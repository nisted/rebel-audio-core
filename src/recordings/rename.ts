/**
 * The naming flow around one recording:
 *   1. `nameForStart()` before recording starts: the name to give the device (no extension; the device adds its own).
 *   2. `stopped(path)` after it stops: if the row changed during the take (or the device ignored our name),
 *      wait until the file has stopped growing, then rename it, retrying while it's locked.
 */
import { readdir, rename as fsRename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { buildName, type NameContext } from './naming.js'
import type { RowSelector } from './rows.js'
import type { NamingSettings, RenameSettings } from './settings.js'

export interface TakeInfo {
	/** Name handed to the device at start (no extension) */
	startName: string
	/** Row number live at start (1-based) or null */
	startRow: number | null
	/** Row contents at start */
	startRowData: Record<string, string>
	/** ms epoch */
	startedAt: number
	take: number
}

export interface StopResult {
	/** Final full path of the file */
	path: string
	/** Final file name */
	name: string
	renamed: boolean
	/** Plain words: what happened and why */
	note: string
	/** Rows: at start and at stop */
	startRow: number | null
	stopRow: number | null
}

export interface NamerOptions {
	rows: RowSelector
	naming: () => NamingSettings
	rename: () => RenameSettings
	/** Folder the device records into (null if unknown: then we can't check for name clashes before start) */
	folder?: () => string | null
	/** Extra context at the moment of naming: source name, Companion variables… */
	context?: () => Omit<NameContext, 'row' | 'rowNumber' | 'take'>
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	log?: (msg: string) => void
}

export class RecordingNamer {
	private readonly o: NamerOptions
	private readonly now: () => number
	private readonly sleep: (ms: number) => Promise<void>
	private current: TakeInfo | null = null
	/** Take counter: per name stem (so a new session row starts again at take 1) */
	private takes = new Map<string, number>()

	constructor(o: NamerOptions) {
		this.o = o
		this.now = o.now ?? Date.now
		this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
	}

	get take(): TakeInfo | null {
		return this.current ? { ...this.current } : null
	}

	private async takenSet(folder: string | null | undefined): Promise<Set<string>> {
		if (!folder) return new Set()
		try {
			return new Set((await readdir(folder)).map((n) => n.toLowerCase()))
		} catch {
			return new Set()
		}
	}

	/** The name the current row would produce now (no side effects) */
	async preview(ext = ''): Promise<string> {
		return (await this.make(ext, null)).file
	}

	private async make(ext: string, exclude: string | null, takeOverride?: number, folder = this.o.folder?.()) {
		const n = this.o.naming()
		const st = this.o.rows.state
		const extra = this.o.context?.() ?? {}
		const ctx: NameContext = { ...extra, now: extra.now ?? new Date(this.now()), row: st.row, rowNumber: st.number }
		const stem = JSON.stringify([st.index, n.template, n.parts])
		const take = takeOverride ?? (this.takes.get(stem) ?? n.takeStart - 1) + 1
		const taken = await this.takenSet(folder)
		const ex = exclude?.toLowerCase() ?? null
		// without an extension (name at start), any existing file with that stem counts as taken
		const isTaken = (f: string) => {
			const low = f.toLowerCase()
			if (low === ex) return false
			if (ext) return taken.has(low)
			for (const t of taken) if (t !== ex && (t === low || (t.startsWith(low + '.') && !t.slice(low.length + 1).includes(' ')))) return true
			return false
		}
		const built = buildName({ ...ctx, take }, n, { ext, taken: isTaken })
		return { ...built, stem, take: built.take ?? take }
	}

	/** Call just before the device starts recording. Returns the name (no extension) to set on the device. */
	async nameForStart(): Promise<string> {
		const b = await this.make('', null)
		this.takes.set(b.stem, b.take)
		const st = this.o.rows.state
		this.current = { startName: b.base, startRow: st.number, startRowData: st.row, startedAt: this.now(), take: b.take }
		return b.base
	}

	/**
	 * Call after the device stops, with the full path of the finished file.
	 * Renames it if the row changed during the take (and renameAfterStop is on), or if the device didn't use our name.
	 * Never throws: problems end up in `note` and the file is left as it was.
	 */
	async stopped(path: string): Promise<StopResult> {
		const rs = this.o.rename()
		const take = this.current
		this.current = null
		const st = this.o.rows.state
		const name = basename(path)
		const base: StopResult = { path, name, renamed: false, note: '', startRow: take?.startRow ?? null, stopRow: st.number }
		const rowChanged = !!take && (take.startRow !== st.number || JSON.stringify(take.startRowData) !== JSON.stringify(st.row))
		if (!rs.renameAfterStop) return { ...base, note: 'Rename after stop is off' }
		if (!take) return { ...base, note: "No name was set at the start, so it's left as the device named it" }
		const ext = extname(name).slice(1)
		const deviceIgnoredName = rs.nameAtStart && !name.toLowerCase().startsWith(take.startName.toLowerCase())
		if (!rowChanged && !deviceIgnoredName) return { ...base, note: 'Row stayed the same: name kept' }
		const dir = dirname(path)
		// build against the folder the file is actually in
		const b = rowChanged ? await this.make(ext, name, undefined, dir) : await this.make(ext, name, take.take, dir)
		if (rowChanged) this.takes.set(b.stem, b.take)
		const target = b.file
		if (target.toLowerCase() === name.toLowerCase()) return { ...base, note: 'Name already right' }
		const settled = await this.waitStable(path, rs)
		if (!settled.ok) return { ...base, note: settled.note }
		const dst = join(dir, target)
		for (let i = 0; i <= rs.renameRetries; i++) {
			try {
				try {
					await stat(dst)
					return { ...base, note: `Not renamed: "${target}" turned up while waiting` }
				} catch {
					/* free */
				}
				await fsRename(path, dst)
				const why = rowChanged ? `row changed during the take (${take.startRow ?? 'none'} → ${st.number ?? 'none'})` : "the device didn't use the name we gave it"
				this.o.log?.(`Renamed "${name}" to "${target}": ${why}`)
				return { ...base, path: dst, name: target, renamed: true, note: `Renamed: ${why}` }
			} catch (e: any) {
				if (e?.code === 'ENOENT') return { ...base, note: `The file "${name}" isn't there any more (moved or deleted?)` }
				if (i === rs.renameRetries) return { ...base, note: `Couldn't rename "${name}": it's still locked or in use (${e?.code ?? e?.message})` }
				await this.sleep(rs.renameRetryMs)
			}
		}
		return base
	}

	/** Wait until the file's size and modified time stop changing for `stableChecks` checks in a row */
	async waitStable(path: string, rs: RenameSettings): Promise<{ ok: boolean; note: string }> {
		const deadline = this.now() + rs.stableTimeoutMs
		let last = ''
		let same = 0
		let seen = false
		while (true) {
			try {
				const s = await stat(path)
				seen = true
				const sig = `${s.size}:${s.mtimeMs}`
				same = sig === last ? same + 1 : 0
				last = sig
				if (same + 1 >= Math.max(1, rs.stableChecks)) return { ok: true, note: '' }
			} catch {
				if (seen) return { ok: false, note: `The file "${basename(path)}" disappeared while waiting for it to finish` }
			}
			if (this.now() >= deadline) return { ok: false, note: seen ? `Not renamed: "${basename(path)}" was still being written after ${Math.round(rs.stableTimeoutMs / 1000)} s` : `The file "${basename(path)}" never appeared` }
			await this.sleep(rs.stablePollMs)
		}
	}
}
