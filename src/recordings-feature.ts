/**
 * Recordings for one connection: the recordings library (src/recordings/)
 * wired to the Engine and the Device's recording.
 *
 *  - Before a take starts (from Companion, the page or a planned start), the
 *    name from the sheet row goes to the device (`setTakeName`, or
 *    `setFileName` when the device has no separate take name).
 *  - A take started on the device itself still gets looked after: its name
 *    is worked out when the start is seen, and the file is renamed after stop.
 *  - After stop: rename if the row changed (or the device ignored the name),
 *    auto-advance the row, queue the upload. All in the device's recording
 *    folder, or the folder this computer sees it as (`folderOverride`).
 *  - Settings and the queue live in the engine's store (`store.recordings`).
 *
 * The module's main.ts turns `variableDefinitions()` / `variableValues()`,
 * the row / upload / sheet methods and the `uploadFailed` / `overrideActive`
 * getters into Companion variables, actions and feedbacks. web.ts serves the
 * file manager and the settings from here.
 */

import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Recordings, type RecordingsSaved } from './recordings/recordings.js'
import { recordingSettings, type PartialSettings, type RecordingSettings, type Destination } from './recordings/settings.js'
import { checkRclone, type Spawner } from './recordings/upload/rclone.js'
import type { TransportSet } from './recordings/upload/transports.js'
import type { FetchLike } from './recordings/sheet.js'
import type { UploadItem } from './recordings/upload/queue.js'
import type { StopResult } from './recordings/rename.js'
import { columnIndex } from './recordings/table.js'
import type { DeviceRecordEvent, DeviceRecording } from './device.js'
import type { RecordingsStore } from './settings.js'

/** Test seams and options for the recordings feature (EngineOptions.recordings) */
export interface RecordingsOptions {
	transports?: TransportSet
	fetch?: FetchLike
	/** Used to check rclone is installed */
	spawner?: Spawner
	now?: () => number
}

export interface RecordingsHost {
	store(): RecordingsStore
	/** The device's recording folder as the device reports it ('' if unknown) */
	deviceFolder(): string
	/** The device's own file name setting as last read ('' if unknown) */
	deviceFileName(): string
	recording(): DeviceRecording | undefined
	/** For {source}: the connection or device name */
	sourceName(): string
	save(): void
	changed(): void
	/** The variable list changed (the sheet's columns changed) */
	structureChanged(): void
	log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void
}

/** Turn a column name into a variable-safe slug */
export function varSlug(s: string): string {
	return (
		s
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'col'
	)
}

const RCLONE_KINDS = new Set(['rclone', 'ftp', 'sftp'])

/** A file name from a device path, whichever slash it uses */
function baseName(p: string): string {
	const parts = p.split(/[\\/]/)
	return parts[parts.length - 1] || p
}

export class RecordingsFeature {
	rec: Recordings
	readonly #host: RecordingsHost
	readonly #opts: RecordingsOptions
	#running = false
	/** The device's own name setting to put back after a take started with ours */
	#restoreTo: string | null = null
	#nextName = ''
	#nextTimer: NodeJS.Timeout | null = null
	#lastStop: StopResult | null = null
	#rclone: { ok: boolean; version: string | null; error: string | null; checkedFor: string } | null = null
	#colSig = ''
	/** Names (lower case) of files belonging to the take being recorded */
	#busy: string[] = []
	#vars: Record<string, string | number | boolean | undefined> = {}

	constructor(host: RecordingsHost, opts: RecordingsOptions = {}) {
		this.#host = host
		this.#opts = opts
		this.rec = this.#make()
	}

	#make(): Recordings {
		const st = this.#host.store()
		const rec = new Recordings({
			settings: st.settings as PartialSettings,
			folder: () => this.folder(),
			context: () => ({ source: this.#host.sourceName(), vars: this.#vars }),
			busy: () => this.#busy,
			fetch: this.#opts.fetch,
			transports: this.#opts.transports,
			now: this.#opts.now,
		})
		rec.on('persist', () => this.#persist())
		rec.on('row', () => this.#changed())
		rec.on('sheet', () => this.#changed())
		rec.on('upload', () => this.#changed())
		rec.on('log', (m) => this.#host.log('info', `Recordings: ${m}`))
		return rec
	}

	get enabled(): boolean {
		return this.#host.store().enabled
	}

	get settings(): RecordingSettings {
		return this.rec.settings
	}

	/** Where this computer finds the recordings (null when unknown) */
	folder(): string | null {
		const st = this.#host.store()
		return st.folderOverride.trim() || this.#host.deviceFolder() || null
	}

	/** Start timers (sheet polling, time matching, upload queue). Safe to call again. */
	start(): void {
		if (this.#running) return
		this.#running = true
		this.rec.start((this.#host.store().saved as Partial<RecordingsSaved> | null) ?? null)
		this.#changed()
		void this.#checkRclone()
	}

	stop(): void {
		if (!this.#running) return
		this.#running = false
		this.rec.stop()
		if (this.#nextTimer) clearTimeout(this.#nextTimer)
		this.#nextTimer = null
	}

	#persist(): void {
		this.#host.store().saved = JSON.parse(JSON.stringify(this.rec.saved())) as Record<string, unknown>
		this.#host.save()
	}

	#changed(): void {
		const sig = JSON.stringify(this.usedColumns())
		if (sig !== this.#colSig) {
			this.#colSig = sig
			this.#host.structureChanged()
		}
		this.#host.changed()
		if (this.#nextTimer) return
		this.#nextTimer = setTimeout(() => {
			this.#nextTimer = null
			void this.rec.namer
				.preview()
				.then((n) => {
					if (n !== this.#nextName) {
						this.#nextName = n
						this.#host.changed()
					}
				})
				.catch(() => {})
		}, 100)
		this.#nextTimer.unref?.()
	}

	/** Companion variable values the naming can use as {var:name} */
	setVars(v: Record<string, string | number | boolean | undefined>): void {
		this.#vars = v
	}

	// ---- settings ----------------------------------------------------------

	/** Turn naming, renaming and uploading on or off */
	setEnabled(on: boolean): void {
		this.#host.store().enabled = on
		this.#host.save()
		this.#changed()
	}

	/** Where this computer sees the recording folder, when it isn't the device's path (a mounted share, say) */
	setFolderOverride(path: string): void {
		this.#host.store().folderOverride = path.trim()
		this.#host.save()
		this.#changed()
	}

	setRestoreName(on: boolean): void {
		this.#host.store().restoreName = on
		this.#host.save()
	}

	/**
	 * Change settings: per section, the keys given replace the old ones.
	 * Upload destinations: a blank or missing password keeps the saved one.
	 */
	configure(patch: PartialSettings): void {
		const st = this.#host.store()
		const next: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(st.settings))
		for (const [section, values] of Object.entries(patch ?? {})) {
			if (!values || typeof values !== 'object') continue
			next[section] = { ...(next[section] ?? {}), ...(values as Record<string, unknown>) }
		}
		const oldDest = (st.settings.upload?.destinations as Destination[] | undefined) ?? []
		const dests = next.upload?.destinations as (Destination & { password?: string })[] | undefined
		if (Array.isArray(dests)) {
			for (const d of dests) {
				if ('password' in d || ['ftp', 'sftp', 'http', 'webdav'].includes(d.kind)) {
					const was = oldDest.find((o) => o.id === d.id) as (Destination & { password?: string }) | undefined
					if (!d.password && was?.password) d.password = was.password
				}
			}
		}
		// check it makes a whole settings object before keeping it
		recordingSettings(next as PartialSettings)
		st.settings = next
		this.rec.configure(next as PartialSettings)
		this.#host.save()
		this.#changed()
		void this.#checkRclone()
	}

	/** Use an uploaded CSV or Excel file as the sheet. Throws plain words if it can't be read. */
	loadSheetFile(bytes: Uint8Array, name: string): void {
		if (this.rec.settings.sheet.kind !== 'file') this.configure({ sheet: { kind: 'file' } })
		this.rec.sheet.loadFile(bytes, name)
		this.#persist()
	}

	async refreshSheet(): Promise<void> {
		await this.rec.sheet.refresh()
	}

	// ---- rows ----------------------------------------------------------------

	rowNext(): boolean {
		return this.rec.rows.next()
	}
	rowPrevious(): boolean {
		return this.rec.rows.previous()
	}
	/** A row number (1 = first) or a key column value; how = auto / key / number */
	rowSet(value: string | number, how: 'auto' | 'key' | 'number' = 'auto'): boolean {
		return this.rec.rows.setByValue(value, how)
	}
	/** Pick by index (0-based), as the page does */
	rowPick(index: number): boolean {
		return this.rec.rows.pick(index)
	}
	rowRelease(): void {
		this.rec.rows.release()
	}

	// ---- uploads ---------------------------------------------------------------

	uploadNow(includeFailed = false): number {
		return this.rec.uploads.uploadNow(includeFailed)
	}
	retryFailed(): number {
		let n = 0
		for (const i of this.rec.uploads.list()) if (i.status === 'failed' && this.rec.uploads.retry(i.id)) n++
		return n
	}
	retry(id: string): boolean {
		return this.rec.uploads.retry(id)
	}
	removeUpload(id: string): boolean {
		return this.rec.uploads.remove(id)
	}
	clearFinished(includeFailed = false): number {
		return this.rec.uploads.clearFinished(includeFailed)
	}
	/** Queue a file from the file manager (name relative to the folder), now, whatever the "when" setting */
	async uploadFile(name: string): Promise<UploadItem[]> {
		if (!this.rec.settings.upload.destinations.some((d) => d.enabled)) throw new Error('No upload destination is set up (and switched on) yet')
		const full = await this.rec.files.resolveName(name)
		return this.rec.queueUpload(full, this.rec.rows.state, true)
	}

	get uploadFailed(): boolean {
		return this.rec.uploads.list().some((i) => i.status === 'failed')
	}

	get overrideActive(): boolean {
		return this.rec.rows.state.overridden
	}

	async #checkRclone(): Promise<void> {
		const u = this.rec.settings.upload
		const needs = u.destinations.some((d) => d.enabled && RCLONE_KINDS.has(d.kind))
		if (!needs) {
			this.#rclone = null
			return
		}
		if (this.#rclone?.checkedFor === u.rclonePath) return
		const r = await checkRclone(u.rclonePath, this.#opts.spawner)
		this.#rclone = { ...r, checkedFor: u.rclonePath }
		this.#host.changed()
	}

	// ---- the take ----------------------------------------------------------------

	/** Called by the recorder just before it starts the device. Never throws: a naming problem never stops a recording. */
	async beforeStart(): Promise<void> {
		if (!this.enabled) return
		const r = this.#host.recording()
		try {
			const name = await withTimeout(this.rec.beforeStart(), 3000)
			if (!name || !r) return
			const set = r.setTakeName ?? r.setFileName
			if (!set) return
			const before = this.#host.deviceFileName()
			await withTimeout(set.call(r, name), 3000)
			this.#restoreTo = r.setFileName && this.#host.store().restoreName && before && before !== name ? before : null
			this.#busy = [name.toLowerCase()]
		} catch (e) {
			this.#host.log('warn', `Recordings: couldn't set the file name before starting, so it records under the device's own name (it gets renamed after stop): ${(e as Error).message}`)
		}
		this.#changed()
	}

	/** Every record event from the device. `wasActive` = recording before this event. */
	onRecordEvent(ev: DeviceRecordEvent, wasActive: boolean): void {
		if (!this.enabled) return
		if (ev.active && !wasActive) void this.#started()
		else if (!ev.active && wasActive) void this.#stopped(ev.lastFile)
	}

	async #started(): Promise<void> {
		// started on the device itself: work the name out now, so the file's renamed after stop
		if (!this.rec.namer.take) {
			try {
				const n = await this.rec.namer.nameForStart()
				this.#busy = [n.toLowerCase()]
			} catch {
				/* rename after stop just won't happen */
			}
		}
		const r = this.#host.recording()
		if (this.#restoreTo && r?.setFileName) {
			const to = this.#restoreTo
			this.#restoreTo = null
			try {
				await r.setFileName(to)
			} catch (e) {
				this.#host.log('debug', `Recordings: couldn't put the device's file name back: ${(e as Error).message}`)
			}
		}
		this.#changed()
	}

	/** The finished file's path on this computer */
	async #findFile(lastFile: string | undefined, since: number): Promise<string | null> {
		const folder = this.folder()
		if (lastFile) {
			let p: string | null
			if (this.#host.store().folderOverride.trim() && folder) p = join(folder, baseName(lastFile))
			else if (isAbsolute(lastFile) || /^[a-zA-Z]:[\\/]/.test(lastFile)) p = lastFile
			else p = folder ? join(folder, lastFile) : null
			// the device may still be closing it: give it a few seconds to turn up
			for (let i = 0; p && i < 20; i++) {
				try {
					await stat(p)
					return p
				} catch {
					await new Promise((r) => setTimeout(r, 250))
				}
			}
			if (p) this.#host.log('info', `Recordings: "${p}" isn't reachable from this computer. Recording on another machine? Set "Recordings folder as this computer sees it".`)
			return null
		}
		// the device didn't say: the newest recording in the folder that changed since the take began
		if (!folder) return null
		try {
			let best: { p: string; m: number } | null = null
			for (const n of await readdir(folder)) {
				if (n.startsWith('.')) continue
				const p = join(folder, n)
				const s = await stat(p)
				if (s.isFile() && s.mtimeMs >= since - 5000 && (!best || s.mtimeMs > best.m)) best = { p, m: s.mtimeMs }
			}
			return best?.p ?? null
		} catch {
			return null
		}
	}

	async #stopped(lastFile: string | undefined): Promise<void> {
		const take = this.rec.namer.take
		try {
			const path = await this.#findFile(lastFile, take?.startedAt ?? Date.now())
			if (!path) this.#host.log('info', "Recordings: the take stopped, but I can't see the file from this computer, so it's not renamed or uploaded")
			const out = await this.rec.afterStop(path)
			this.#lastStop = out.stop
			if (out.stop?.note) this.#host.log(out.stop.renamed ? 'info' : 'debug', `Recordings: ${out.stop.name}: ${out.stop.note}`)
		} catch (e) {
			this.#host.log('warn', `Recordings: after the take: ${(e as Error).message}`)
		} finally {
			this.#busy = []
			this.#changed()
		}
	}

	// ---- for Companion -------------------------------------------------------------

	/** Sheet columns used in the name, the upload folder pattern or as the key column */
	usedColumns(): string[] {
		const t = this.rec.rows.table
		if (!t) return []
		const s = this.rec.settings
		const text = [s.naming.template, ...s.naming.parts.map((p) => `{${p}}`), s.upload.layout === 'pattern' ? s.upload.folderPattern : ''].join(' ')
		const used = new Set<string>()
		for (const m of text.matchAll(/\{([^}]+)\}/g)) {
			let tok = m[1].trim()
			if (tok.toLowerCase().startsWith('col:')) tok = tok.slice(4).trim()
			const i = columnIndex(t, tok)
			if (i >= 0) used.add(t.headers[i])
		}
		const k = columnIndex(t, s.rows.keyColumn)
		if (k >= 0) used.add(t.headers[k])
		return [...used]
	}

	variableDefinitions(): { variableId: string; name: string }[] {
		const defs = [
			{ variableId: 'rec_naming', name: 'Recordings: sheet naming and upload on' },
			{ variableId: 'rec_row', name: 'Recordings: current sheet row number' },
			{ variableId: 'rec_rows', name: 'Recordings: rows in the sheet' },
			{ variableId: 'rec_row_why', name: 'Recordings: why this row (plain words)' },
			{ variableId: 'rec_override', name: 'Recordings: a manual row pick is overriding the time match' },
			{ variableId: 'rec_next_name', name: 'Recordings: name the next take gets' },
			{ variableId: 'rec_last_name', name: 'Recordings: name of the last take' },
			{ variableId: 'rec_last_note', name: 'Recordings: what happened to the last take (renamed or not, why)' },
			{ variableId: 'rec_sheet', name: 'Recordings: sheet status (ok / problem / off)' },
			{ variableId: 'rec_sheet_error', name: 'Recordings: sheet problem, in plain words (blank = none)' },
			{ variableId: 'rec_up_waiting', name: 'Recordings: uploads waiting (queued, held or retrying)' },
			{ variableId: 'rec_up_uploading', name: 'Recordings: uploads going now' },
			{ variableId: 'rec_up_done', name: 'Recordings: uploads done' },
			{ variableId: 'rec_up_failed', name: 'Recordings: uploads failed' },
			{ variableId: 'rec_up_active', name: 'Recordings: file uploading now and how far' },
		]
		for (const c of this.usedColumns()) defs.push({ variableId: `rec_col_${varSlug(c)}`, name: `Recordings: current row: ${c}` })
		return defs
	}

	variableValues(): Record<string, string | number | boolean> {
		const st = this.rec.rows.state
		const sh = this.rec.sheet.status
		const sum = this.rec.uploads.summary()
		const out: Record<string, string | number | boolean> = {
			rec_naming: this.enabled,
			rec_row: st.number ?? '',
			rec_rows: this.rec.rows.table?.rows.length ?? 0,
			rec_row_why: st.why,
			rec_override: st.overridden,
			rec_next_name: this.#nextName,
			rec_last_name: this.#lastStop?.name ?? '',
			rec_last_note: this.#lastStop?.note ?? '',
			rec_sheet: sh.kind === 'none' ? 'off' : sh.error ? 'problem' : sh.ok ? 'ok' : 'waiting',
			rec_sheet_error: sh.error ?? '',
			rec_up_waiting: sum.queued + sum.held + sum.retrying,
			rec_up_uploading: sum.uploading,
			rec_up_done: sum.done,
			rec_up_failed: sum.failed,
			rec_up_active: sum.active ?? '',
		}
		for (const c of this.usedColumns()) out[`rec_col_${varSlug(c)}`] = st.row[c] ?? ''
		return out
	}

	// ---- for the page --------------------------------------------------------------

	/** Small summary that rides along in the engine snapshot */
	summary(): Record<string, unknown> {
		const st = this.rec.rows.state
		return {
			enabled: this.enabled,
			row: st.number,
			why: st.why,
			overridden: st.overridden,
			nextName: this.#nextName,
			sheet: this.rec.sheet.status,
			uploads: this.rec.uploads.summary(),
		}
	}

	/** Everything the Recordings tab shows (passwords left out) */
	pageState(): Record<string, unknown> {
		const s = JSON.parse(JSON.stringify(this.rec.settings)) as RecordingSettings
		for (const d of s.upload.destinations as (Destination & { password?: string; hasPassword?: boolean })[]) {
			if ('password' in d) {
				d.hasPassword = !!d.password
				d.password = ''
			}
		}
		const t = this.rec.rows.table
		const store = this.#host.store()
		return {
			enabled: store.enabled,
			folderOverride: store.folderOverride,
			restoreName: store.restoreName,
			deviceFolder: this.#host.deviceFolder(),
			folder: this.folder(),
			settings: s,
			sheet: this.rec.sheet.status,
			table: t ? { headers: t.headers, rows: t.rows.slice(0, 1000) } : null,
			row: this.rec.rows.state,
			take: this.rec.namer.take,
			nextName: this.#nextName,
			lastStop: this.#lastStop,
			uploads: this.rec.uploads.list(),
			summary: this.rec.uploads.summary(),
			rclone: this.#rclone,
			usedColumns: this.usedColumns(),
		}
	}

	/** A name built from settings that aren't saved yet (the naming builder's preview) */
	async previewWith(naming: Partial<RecordingSettings['naming']>): Promise<string> {
		const { buildName } = await import('./recordings/naming.js')
		const n = { ...this.rec.settings.naming, ...naming }
		const st = this.rec.rows.state
		return buildName({ row: st.row, rowNumber: st.number, source: this.#host.sourceName(), vars: this.#vars, take: n.takeStart, now: new Date((this.#opts.now ?? Date.now)()) }, n, { ext: '' }).file
	}

	/** Export without passwords or this computer's queue */
	static exportable(st: RecordingsStore): RecordingsStore {
		const copy = JSON.parse(JSON.stringify(st)) as RecordingsStore
		copy.saved = null
		const dests = copy.settings.upload?.destinations as Record<string, unknown>[] | undefined
		if (Array.isArray(dests)) for (const d of dests) if ('password' in d) d.password = ''
		return copy
	}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('took too long')), ms)
		p.then(
			(v) => {
				clearTimeout(t)
				resolve(v)
			},
			(e) => {
				clearTimeout(t)
				reject(e)
			},
		)
	})
}
