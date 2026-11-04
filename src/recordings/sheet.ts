/** Where the rows come from: a Google Sheet shared "anyone with the link" (polled), or an uploaded CSV/Excel file. */
import { EventEmitter } from 'node:events'
import { parseCsv, parseFileBytes, toTable, type Table } from './table.js'
import type { SheetSettings } from './settings.js'

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'follow' | 'manual' }) => Promise<{
	ok: boolean
	status: number
	url: string
	headers: { get(name: string): string | null }
	text(): Promise<string>
}>

export interface GoogleLink {
	/** Spreadsheet id (from /d/<id>/) or, for a "Publish to web" link, the published id (2PACX-…) */
	id: string
	published: boolean
	/** Tab id from the link (gid), if there was one */
	gid: string | null
}

/** Pull the spreadsheet id and tab out of any Google Sheets link (edit, share, copy, export, published). */
export function parseGoogleSheetUrl(input: string): GoogleLink {
	const s = input.trim()
	if (!s) throw new Error('No Google Sheet link set yet')
	// a bare id pasted on its own
	if (/^[\w-]{25,}$/.test(s)) return { id: s, published: false, gid: null }
	let u: URL
	try {
		u = new URL(s.includes('://') ? s : 'https://' + s)
	} catch {
		throw new Error("That doesn't look like a link. Copy the whole address from the browser while the sheet is open")
	}
	if (!/(^|\.)docs\.google\.com$/i.test(u.hostname) && !/(^|\.)sheets\.google\.com$/i.test(u.hostname)) {
		if (/drive\.google\.com$/i.test(u.hostname)) {
			const id = u.searchParams.get('id') ?? /\/d\/([\w-]+)/.exec(u.pathname)?.[1]
			if (id) return { id, published: false, gid: null }
		}
		throw new Error("That isn't a Google Sheets link (it should start https://docs.google.com/spreadsheets/…)")
	}
	const hashGid = /(?:^|[#&])gid=(\d+)/.exec(u.hash)?.[1]
	const gid = u.searchParams.get('gid') ?? hashGid ?? null
	const pub = /\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname)
	if (pub) return { id: pub[1], published: true, gid }
	const m = /\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(u.pathname)
	if (!m) {
		if (/\/document\/|\/presentation\/|\/forms\//.test(u.pathname)) throw new Error("That's a Google Doc/Slides/Form link, not a Sheet")
		throw new Error("Can't find the sheet's id in that link. Copy the address from the browser while the sheet is open")
	}
	return { id: m[1], published: false, gid }
}

/**
 * The CSV address for a sheet. `tab`: blank = the gid in the link (or the first tab), digits = a gid, anything else = a tab name.
 * Tab names use the gviz endpoint (the export endpoint only takes gids).
 */
export function googleCsvUrl(link: GoogleLink, tab = ''): string {
	const t = tab.trim()
	const gid = /^\d+$/.test(t) ? t : t ? null : link.gid
	if (link.published) {
		const q = new URLSearchParams({ output: 'csv' })
		if (gid !== null) {
			q.set('gid', gid)
			q.set('single', 'true')
		}
		return `https://docs.google.com/spreadsheets/d/e/${link.id}/pub?${q}`
	}
	if (t && gid === null) return `https://docs.google.com/spreadsheets/d/${link.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(t)}`
	return `https://docs.google.com/spreadsheets/d/${link.id}/export?format=csv${gid !== null ? `&gid=${gid}` : ''}`
}

/** Fetch a Google Sheet as CSV text, with plain-words errors */
export async function fetchGoogleCsv(url: string, fetchFn: FetchLike, timeoutMs: number): Promise<string> {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), timeoutMs)
	let res: Awaited<ReturnType<FetchLike>>
	try {
		res = await fetchFn(url, { signal: ac.signal, redirect: 'follow' })
	} catch (e: any) {
		if (ac.signal.aborted) throw new Error(`Google didn't answer within ${Math.round(timeoutMs / 1000)} s. Is the internet connection up?`)
		const code = e?.cause?.code ?? e?.code ?? ''
		if (/ENOTFOUND|EAI_AGAIN/.test(code)) throw new Error("Can't reach Google: no internet, or DNS isn't working on this machine")
		if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/.test(code)) throw new Error(`Can't reach Google (${code}). Is the internet connection up?`)
		throw new Error(`Couldn't fetch the sheet: ${e?.message ?? e}`)
	} finally {
		clearTimeout(timer)
	}
	const finalUrl = res.url || url
	const type = (res.headers.get('content-type') ?? '').toLowerCase()
	if (/accounts\.google\.com|ServiceLogin|\/signin/i.test(finalUrl) || res.status === 401 || res.status === 403)
		throw new Error("That sheet isn't shared with 'anyone with the link'. In Google Sheets: Share → General access → Anyone with the link (Viewer)")
	if (res.status === 404) throw new Error("Google says that sheet doesn't exist. Check the link (has it been deleted, or is it a copy?)")
	if (res.status === 400) throw new Error("Google didn't like that tab. Check the tab name or number (gid) in the settings")
	if (res.status === 429) throw new Error('Google is asking us to slow down. Make the check interval longer')
	if (!res.ok) throw new Error(`Google answered with an error (${res.status}). Try again in a minute`)
	const body = await res.text()
	if (type.includes('text/html') || /^\s*<(!doctype|html)/i.test(body)) {
		if (/accounts\.google\.com|sign in/i.test(body))
			throw new Error("That sheet isn't shared with 'anyone with the link'. In Google Sheets: Share → General access → Anyone with the link (Viewer)")
		throw new Error("Google sent a web page instead of the sheet. Check the link, and that it's shared with 'anyone with the link'")
	}
	return body
}

export interface SheetStatus {
	kind: SheetSettings['kind']
	/** Have rows to use (possibly an older copy, if the latest fetch failed) */
	ok: boolean
	/** Plain-words problem with the latest load (the last good copy is still in use) */
	error: string | null
	/** When the rows in use were loaded (ms since epoch) */
	loadedAt: number | null
	/** When we last tried */
	triedAt: number | null
	/** Where the rows came from (file name or tab) */
	label: string
	rowCount: number
}

export interface SheetSourceEvents {
	/** New rows arrived and differ from before */
	table: [Table]
	/** Status changed (loaded, error, cleared) */
	status: [SheetStatus]
}

export interface SheetSourceOptions {
	fetch?: FetchLike
	now?: () => number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (h: unknown) => void
}

/**
 * Holds the current table. Google: polls every `pollSeconds`, keeps the last good copy when a fetch fails.
 * File: `loadFile(bytes, name)`; the caller persists the bytes (or `table`) if it wants them after a restart.
 */
export class SheetSource extends EventEmitter<SheetSourceEvents> {
	private settings: SheetSettings
	private readonly fetchFn: FetchLike
	private readonly now: () => number
	private readonly setTimer: (fn: () => void, ms: number) => unknown
	private readonly clearTimer: (h: unknown) => void
	private timer: unknown = null
	private running = false
	private inflight: Promise<void> | null = null
	private fileBytes: Uint8Array | null = null
	private _table: Table | null = null
	private sig = ''
	private _status: SheetStatus

	constructor(settings: SheetSettings, opts: SheetSourceOptions = {}) {
		super()
		this.settings = settings
		this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i as RequestInit) as any)
		this.now = opts.now ?? Date.now
		this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
		this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as any))
		this._status = { kind: settings.kind, ok: false, error: null, loadedAt: null, triedAt: null, label: '', rowCount: 0 }
	}

	get table(): Table | null {
		return this._table
	}
	get status(): SheetStatus {
		return { ...this._status }
	}

	/** Change settings; reloads if the source changed */
	configure(settings: SheetSettings): void {
		const before = this.settings
		this.settings = settings
		const changed = before.kind !== settings.kind || before.googleUrl !== settings.googleUrl || before.tab !== settings.tab || before.headerRow !== settings.headerRow || before.skipBlankRows !== settings.skipBlankRows || before.excelSheet !== settings.excelSheet
		if (changed) {
			if (before.kind !== settings.kind) this.clear()
			if (settings.kind === 'file' && this.fileBytes) this.reparseFile()
		}
		if (this.running) {
			this.schedule(0)
		}
	}

	/** Begin (polling a Google Sheet; nothing to do for files) */
	start(): void {
		this.running = true
		this.schedule(0)
	}
	stop(): void {
		this.running = false
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
	}

	private schedule(ms: number): void {
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
		if (!this.running || this.settings.kind !== 'google') return
		this.timer = this.setTimer(() => {
			this.timer = null
			void this.refresh().finally(() => {
				if (this.settings.pollSeconds > 0) this.schedule(this.settings.pollSeconds * 1000)
			})
		}, ms)
	}

	/** Fetch the Google Sheet now (any kind other than google does nothing). Never throws; see `status.error`. */
	refresh(): Promise<void> {
		if (this.settings.kind !== 'google') return Promise.resolve()
		if (this.inflight) return this.inflight
		this.inflight = (async () => {
			this._status.triedAt = this.now()
			try {
				const link = parseGoogleSheetUrl(this.settings.googleUrl)
				const url = googleCsvUrl(link, this.settings.tab)
				const csv = await fetchGoogleCsv(url, this.fetchFn, this.settings.fetchTimeoutMs)
				const t = toTable(parseCsv(csv, ','), this.settings.headerRow, this.settings.skipBlankRows)
				if (!t.headers.length) throw new Error('That sheet is empty (no header row found)')
				this.accept(t, this.settings.tab || (link.gid ? `tab ${link.gid}` : 'first tab'))
			} catch (e: any) {
				this.fail(e?.message ?? String(e))
			} finally {
				this.inflight = null
			}
		})()
		return this.inflight
	}

	/** Use an uploaded CSV or .xlsx (bytes). Throws a plain-words error if it can't be read (the old copy stays). */
	loadFile(bytes: Uint8Array, name = 'uploaded file'): Table {
		try {
			const t = toTable(parseFileBytes(bytes, this.settings.excelSheet), this.settings.headerRow, this.settings.skipBlankRows)
			if (!t.headers.length) throw new Error('That file is empty (no header row found)')
			this.fileBytes = bytes
			this._status.triedAt = this.now()
			this.accept(t, name)
			return t
		} catch (e: any) {
			this._status.triedAt = this.now()
			this.fail(e?.message ?? String(e))
			throw e
		}
	}

	/** Restore a table saved earlier (e.g. the last good copy from before a restart) without fetching */
	restore(t: Table, label = 'saved copy', loadedAt: number | null = null): void {
		this.accept(t, label, loadedAt ?? this.now())
	}

	clear(): void {
		this._table = null
		this.sig = ''
		this.fileBytes = null
		this._status = { kind: this.settings.kind, ok: false, error: null, loadedAt: null, triedAt: null, label: '', rowCount: 0 }
		this.emit('status', this.status)
	}

	private reparseFile(): void {
		if (!this.fileBytes) return
		try {
			this.loadFile(this.fileBytes, this._status.label)
		} catch {
			/* status already says why */
		}
	}

	private accept(t: Table, label: string, at = this.now()): void {
		const sig = JSON.stringify(t)
		const changed = sig !== this.sig
		this._table = t
		this.sig = sig
		this._status = { kind: this.settings.kind, ok: true, error: null, loadedAt: at, triedAt: this._status.triedAt, label, rowCount: t.rows.length }
		if (changed) this.emit('table', t)
		this.emit('status', this.status)
	}

	private fail(msg: string): void {
		this._status = { ...this._status, kind: this.settings.kind, ok: this._table !== null, error: msg }
		this.emit('status', this.status)
	}
}
