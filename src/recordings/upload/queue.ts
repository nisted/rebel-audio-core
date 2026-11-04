/**
 * Upload queue: one item per (file, destination). Retries network trouble with backoff, holds items for
 * "on demand" or "at a set time", reports progress, and can be saved/restored (`state` / `restore`).
 * Uploads are copies: the local file is never touched.
 */
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Destination, UploadSettings } from '../settings.js'
import { defaultTransports, transportFor, UploadError, type TransportSet } from './transports.js'

export type UploadStatus = 'held' | 'queued' | 'uploading' | 'retrying' | 'done' | 'failed'

export interface UploadItem {
	id: string
	localPath: string
	/** Name to use at the destination */
	remoteName: string
	/** Folder at the destination ("a/b", "" = top) */
	remoteFolder: string
	destId: string
	destName: string
	status: UploadStatus
	/** 0–100 */
	percent: number
	bytesSent: number
	size: number
	attempts: number
	/** ms epoch of the next try (retrying) */
	nextTry: number | null
	/** Plain-words reason for the last failure */
	error: string | null
	/** Where it ended up (URL, path or rclone target; passwords hidden) */
	remote: string | null
	addedAt: number
	finishedAt: number | null
}

export interface UploadQueueState {
	version: 1
	items: UploadItem[]
	/** Last day (YYYY-MM-DD) the scheduled run fired, so a restart doesn't run it twice */
	lastScheduled: string | null
}

export interface UploadQueueEvents {
	/** One item changed (status or progress) */
	item: [UploadItem]
	/** Anything changed: save `state` now if you persist it */
	change: [UploadQueueState]
}

export interface UploadQueueOptions {
	settings: () => UploadSettings
	transports?: TransportSet
	now?: () => number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (h: unknown) => void
	log?: (msg: string) => void
	/** Progress events at most this often per item (ms) */
	progressEveryMs?: number
}

const dayKey = (t: number) => {
	const d = new Date(t)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Next time "HH:MM" (local) happens at or after `from` */
export function nextAt(at: string, from: number): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim())
	if (!m || +m[1] > 23 || +m[2] > 59) return null
	const d = new Date(from)
	d.setHours(+m[1], +m[2], 0, 0)
	if (d.getTime() < from) d.setDate(d.getDate() + 1)
	return d.getTime()
}

export class UploadQueue extends EventEmitter<UploadQueueEvents> {
	private readonly o: UploadQueueOptions
	private readonly transports: TransportSet
	private readonly now: () => number
	private readonly setTimer: (fn: () => void, ms: number) => unknown
	private readonly clearTimer: (h: unknown) => void
	private items: UploadItem[] = []
	private readonly running = new Map<string, AbortController>()
	private timer: unknown = null
	private lastScheduled: string | null = null
	private started = false
	private idleWaiters: (() => void)[] = []
	private lastProgress = new Map<string, number>()

	constructor(o: UploadQueueOptions) {
		super()
		this.o = o
		this.transports = o.transports ?? defaultTransports()
		this.now = o.now ?? Date.now
		this.setTimer = o.setTimer ?? ((fn, ms) => {
			const t = setTimeout(fn, ms)
			;(t as any).unref?.()
			return t
		})
		this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as any))
	}

	get state(): UploadQueueState {
		return { version: 1, items: this.items.map((i) => ({ ...i })), lastScheduled: this.lastScheduled }
	}

	/** Everything, oldest first */
	list(): UploadItem[] {
		return this.items.map((i) => ({ ...i }))
	}

	get(id: string): UploadItem | undefined {
		const i = this.items.find((x) => x.id === id)
		return i ? { ...i } : undefined
	}

	/** Load a saved queue. Anything that was mid-upload goes back to queued (or held for manual/scheduled). */
	restore(s: UploadQueueState | null | undefined): void {
		if (!s || s.version !== 1 || !Array.isArray(s.items)) return
		this.items = s.items.map((i) => (i.status === 'uploading' ? { ...i, status: 'queued', percent: 0, bytesSent: 0 } : { ...i }))
		this.lastScheduled = s.lastScheduled ?? null
		this.changed()
		this.kick()
	}

	/** Begin processing (timers). Call once the module is ready. */
	start(): void {
		this.started = true
		this.kick()
	}

	/** Stop timers and abort running uploads (they go back to queued) */
	stop(): void {
		this.started = false
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
		for (const ac of this.running.values()) ac.abort()
	}

	/**
	 * Add a finished recording, one item per enabled destination (or the ones named in `destIds`).
	 * With `when: 'afterStop'` it goes straight in the queue; otherwise it's held until `uploadNow()` or the set time.
	 * `force`: queue now whatever the `when` setting says (an "upload this file" button).
	 */
	add(localPath: string, opts: { remoteFolder: string; remoteName?: string; destIds?: string[]; force?: boolean }): UploadItem[] {
		const s = this.o.settings()
		const dests = s.destinations.filter((d) => d.enabled && (!opts.destIds || opts.destIds.includes(d.id)))
		const out: UploadItem[] = []
		for (const d of dests) {
			const dup = this.items.find((i) => i.localPath === localPath && i.destId === d.id && i.status !== 'done' && i.status !== 'failed')
			if (dup) {
				out.push({ ...dup })
				continue
			}
			const item: UploadItem = {
				id: randomBytes(8).toString('hex'),
				localPath,
				remoteName: opts.remoteName ?? basename(localPath),
				remoteFolder: opts.remoteFolder,
				destId: d.id,
				destName: d.name || d.kind,
				status: opts.force || s.when === 'afterStop' ? 'queued' : 'held',
				percent: 0,
				bytesSent: 0,
				size: 0,
				attempts: 0,
				nextTry: null,
				error: null,
				remote: null,
				addedAt: this.now(),
				finishedAt: null,
			}
			this.items.push(item)
			out.push({ ...item })
			this.emit('item', { ...item })
		}
		if (out.length) this.changed()
		this.kick()
		return out
	}

	/** Upload everything held or waiting to retry, now (and give failed ones another go if `includeFailed`) */
	uploadNow(includeFailed = false): number {
		let n = 0
		for (const i of this.items) {
			if (i.status === 'held' || i.status === 'retrying' || (includeFailed && i.status === 'failed')) {
				this.patch(i, { status: 'queued', nextTry: null, ...(i.status === 'failed' ? { attempts: 0 } : {}) })
				n++
			}
		}
		this.kick()
		return n
	}

	/** Try one failed / retrying / held item again now */
	retry(id: string): boolean {
		const i = this.items.find((x) => x.id === id)
		if (!i || i.status === 'uploading' || i.status === 'done') return false
		this.patch(i, { status: 'queued', nextTry: null, attempts: i.status === 'failed' ? 0 : i.attempts })
		this.kick()
		return true
	}

	/** Remove an item (aborts it if running). The local file is untouched. */
	remove(id: string): boolean {
		const idx = this.items.findIndex((x) => x.id === id)
		if (idx < 0) return false
		this.running.get(id)?.abort()
		this.items.splice(idx, 1)
		this.changed()
		return true
	}

	/** Remove finished ones (done, and failed too if asked) */
	clearFinished(includeFailed = false): number {
		const before = this.items.length
		this.items = this.items.filter((i) => !(i.status === 'done' || (includeFailed && i.status === 'failed')))
		if (this.items.length !== before) this.changed()
		return before - this.items.length
	}

	/** Counts per status, for variables / feedbacks */
	summary(): Record<UploadStatus, number> & { total: number; active: string | null } {
		const s = { held: 0, queued: 0, uploading: 0, retrying: 0, done: 0, failed: 0, total: this.items.length, active: null as string | null }
		for (const i of this.items) s[i.status]++
		const up = this.items.find((i) => i.status === 'uploading')
		s.active = up ? `${up.remoteName} ${up.percent}%` : null
		return s
	}

	/** Resolves when nothing is uploading or queued-and-due (for tests and shutdown) */
	idle(): Promise<void> {
		if (!this.busy()) return Promise.resolve()
		return new Promise((r) => this.idleWaiters.push(r))
	}

	private busy(): boolean {
		return this.running.size > 0 || this.items.some((i) => i.status === 'queued')
	}

	/**
	 * Check due retries and the scheduled time, and start uploads. Called by the queue's own timer; callable directly
	 * (tests with a fake clock).
	 */
	tick(): void {
		const s = this.o.settings()
		const now = this.now()
		if (s.when === 'scheduled') {
			// fires once a day, at or after the set time (so a restart after the time still catches up that day)
			const today = dayKey(now)
			const atToday = nextAt(s.at, new Date(now).setHours(0, 0, 0, 0))
			if (atToday !== null && now >= atToday && this.lastScheduled !== today) {
				this.lastScheduled = today
				const n = this.uploadNowInternal()
				this.o.log?.(`Scheduled upload time (${s.at}): ${n} file(s) to send`)
				this.changed()
			}
		}
		for (const i of this.items) if (i.status === 'retrying' && i.nextTry !== null && i.nextTry <= now) this.patch(i, { status: 'queued', nextTry: null })
		if (s.enabled) {
			const max = Math.max(1, s.concurrency)
			for (const i of this.items) {
				if (this.running.size >= max) break
				if (i.status === 'queued' && !this.running.has(i.id)) void this.run(i)
			}
		}
		if (!this.busy()) this.flushIdle()
		this.arm()
	}

	private uploadNowInternal(): number {
		let n = 0
		for (const i of this.items) if (i.status === 'held') {
			this.patch(i, { status: 'queued' })
			n++
		}
		return n
	}

	private kick(): void {
		if (!this.started) return
		queueMicrotask(() => this.tick())
	}

	/** Set the timer for the next retry or scheduled time */
	private arm(): void {
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
		if (!this.started) return
		const s = this.o.settings()
		const now = this.now()
		let wake: number | null = null
		for (const i of this.items) if (i.status === 'retrying' && i.nextTry !== null) wake = wake === null ? i.nextTry : Math.min(wake, i.nextTry)
		if (s.when === 'scheduled') {
			const n = nextAt(s.at, now + 1000)
			if (n !== null) wake = wake === null ? n : Math.min(wake, n)
		}
		if (wake === null) return
		// cap so a changed clock or setting gets noticed
		this.timer = this.setTimer(() => {
			this.timer = null
			this.tick()
		}, Math.min(Math.max(0, wake - now), 60000))
	}

	private async run(i: UploadItem): Promise<void> {
		const s = this.o.settings()
		const dest = s.destinations.find((d) => d.id === i.destId)
		const ac = new AbortController()
		this.running.set(i.id, ac)
		try {
			if (!dest) throw new UploadError(`The destination "${i.destName}" has been removed from the settings`, false)
			if (!dest.enabled) throw new UploadError(`The destination "${i.destName}" is switched off`, false)
			let size: number
			try {
				size = (await stat(i.localPath)).size
			} catch {
				throw new UploadError("The recording isn't there any more (moved or deleted?)", false)
			}
			this.patch(i, { status: 'uploading', attempts: i.attempts + 1, size, percent: 0, bytesSent: 0, error: null })
			const t = transportFor(this.transports, dest)
			const r = await t.upload({ localPath: i.localPath, remoteFolder: i.remoteFolder, remoteName: i.remoteName, size }, dest, {
				signal: ac.signal,
				settings: s,
				progress: (b) => this.progress(i, b),
			})
			this.patch(i, { status: 'done', percent: 100, bytesSent: size, remote: r.remote, finishedAt: this.now(), error: null })
			this.o.log?.(`Uploaded "${i.remoteName}" to ${i.destName}`)
		} catch (e: any) {
			const cur = this.items.find((x) => x.id === i.id)
			if (!cur) return // removed while running
			if (ac.signal.aborted && !this.started) {
				this.patch(cur, { status: 'queued', percent: 0, bytesSent: 0 })
				return
			}
			const msg = e instanceof UploadError ? e.message : `Upload failed: ${e?.message ?? e}`
			const retryable = e instanceof UploadError ? e.retryable : true
			const attempts = cur.attempts
			const limit = s.maxAttempts
			if (retryable && (limit <= 0 || attempts < limit)) {
				const wait = Math.min(s.retryMaxMs, s.retryBaseMs * Math.pow(2, Math.max(0, attempts - 1)))
				this.patch(cur, { status: 'retrying', error: msg, nextTry: this.now() + wait })
				this.o.log?.(`Upload of "${cur.remoteName}" to ${cur.destName} failed (${msg}); trying again in ${Math.round(wait / 1000)} s`)
			} else {
				this.patch(cur, { status: 'failed', error: msg, nextTry: null, finishedAt: this.now() })
				this.o.log?.(`Upload of "${cur.remoteName}" to ${cur.destName} failed: ${msg}`)
			}
		} finally {
			this.running.delete(i.id)
			this.lastProgress.delete(i.id)
			this.tick()
		}
	}

	private progress(i: UploadItem, bytes: number): void {
		const cur = this.items.find((x) => x.id === i.id)
		if (!cur || cur.status !== 'uploading') return
		cur.bytesSent = bytes
		cur.percent = cur.size ? Math.min(99, Math.floor((bytes / cur.size) * 100)) : 0
		const every = this.o.progressEveryMs ?? 250
		const last = this.lastProgress.get(i.id) ?? 0
		if (this.now() - last >= every) {
			this.lastProgress.set(i.id, this.now())
			this.emit('item', { ...cur })
		}
	}

	private patch(i: UploadItem, p: Partial<UploadItem>): void {
		const cur = this.items.find((x) => x.id === i.id)
		if (!cur) return
		Object.assign(cur, p)
		this.emit('item', { ...cur })
		this.changed()
	}

	private changed(): void {
		this.emit('change', this.state)
	}

	private flushIdle(): void {
		const w = this.idleWaiters
		this.idleWaiters = []
		w.forEach((f) => f())
	}
}

export type { Destination }
