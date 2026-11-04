/** Which sheet row is live: picked, stepped, set by value, auto-advanced, or matched by time with manual override. */
import { EventEmitter } from 'node:events'
import { columnIndex, rowObject, type Table } from './table.js'
import type { RowSettings } from './settings.js'

export type RowReason =
	| 'none' // no sheet or no rows
	| 'picked' // chosen explicitly (page / action)
	| 'stepped' // next / previous
	| 'value' // set by value / expression
	| 'advanced' // auto-advance after a recording
	| 'time' // time slot covers now
	| 'time-last' // no slot covers now; kept the last matched one
	| 'kept' // the sheet reloaded and the same row was found again
	| 'override-released' // back to time matching

export interface RowState {
	/** Index into table.rows, or null */
	index: number | null
	/** 1-based row number for people (null when none) */
	number: number | null
	/** The row as { column: value } ({} when none) */
	row: Record<string, string>
	reason: RowReason
	/** Plain words, e.g. "Matched by time: 09:30–10:15" or "Manual pick (holds until the next time slot)" */
	why: string
	/** Time mode: a manual choice is holding the row */
	overridden: boolean
	/** Time mode: when the override lets go by itself (ms epoch), or null */
	overrideUntil: number | null
	/** Time mode: the slot of the current row (ms epoch) if known */
	slot: { start: number; end: number | null } | null
}

export interface RowSelectorEvents {
	change: [RowState, RowState]
}

/**
 * Parse a time or date-time written in a sheet into ms since epoch (local time).
 * Accepts 09:30, 9:30, 9.30, 0930, 9:30pm, 21:30:15, 2026-11-04 09:30, 2026-11-04T09:30, 04/11/2026 09:30 (dmy or mdy),
 * and Excel/Sheets serial numbers (45965.39…). Times without a date use `day` (default: today).
 */
export function parseSheetTime(text: string, day: Date, dateOrder: 'dmy' | 'mdy' = 'dmy'): number | null {
	let s = text.trim()
	if (!s) return null
	// spreadsheet serial (days since 1899-12-30), as an un-formatted Sheets/Excel cell exports it
	if (/^\d+(\.\d+)?$/.test(s) && !/^\d{3,4}$/.test(s)) {
		const v = Number(s)
		if (v < 1) return atTime(day, v * 86400)
		if (v > 20000 && v < 80000) {
			const whole = Math.floor(v)
			const d = new Date(Date.UTC(1899, 11, 30) + whole * 86400000)
			return atTime(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), Math.round((v - whole) * 86400))
		}
		return null
	}
	let base = new Date(day.getFullYear(), day.getMonth(), day.getDate())
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(.*))?$/.exec(s)
	if (m) {
		base = new Date(+m[1], +m[2] - 1, +m[3])
		s = m[4] ?? ''
		if (!s.trim()) return base.getTime()
	} else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[T\s,]+(.*))?$/.exec(s))) {
		const a = +m[1]
		const b = +m[2]
		let y = +m[3]
		if (y < 100) y += 2000
		const [dd, mm] = dateOrder === 'mdy' ? [b, a] : [a, b]
		base = new Date(y, mm - 1, dd)
		s = m[4] ?? ''
		if (!s.trim()) return base.getTime()
	}
	const secs = parseClock(s)
	return secs === null ? null : atTime(base, secs)
}

function atTime(day: Date, secs: number): number {
	const d = new Date(day.getFullYear(), day.getMonth(), day.getDate())
	d.setSeconds(Math.round(secs))
	return d.getTime()
}

/** "09:30", "9.30", "0930", "9:30 pm", "21:30:15" → seconds after midnight */
export function parseClock(text: string): number | null {
	const s = text.trim().toLowerCase()
	const m = /^(\d{1,2})(?:[:.h](\d{2})(?:[:.](\d{2}))?|(\d{2}))?\s*(am|pm|a|p)?$/.exec(s)
	if (!m) return null
	let h = +m[1]
	const min = +(m[2] ?? m[4] ?? 0)
	const sec = +(m[3] ?? 0)
	const ap = m[5]
	if (!m[2] && !m[4] && !ap) return null // a lone number isn't a time
	if (ap) {
		if (h < 1 || h > 12) return null
		if (ap.startsWith('p') && h !== 12) h += 12
		if (ap.startsWith('a') && h === 12) h = 0
	}
	if (h > 24 || min > 59 || sec > 59) return null
	return h * 3600 + min * 60 + sec
}

const hhmm = (t: number) => {
	const d = new Date(t)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface Slot {
	index: number
	start: number
	end: number | null
}

export interface RowSelectorOptions {
	now?: () => number
}

/**
 * Keeps track of the live row. Call `setTable` when the sheet changes and `tick()` now and then (e.g. every second)
 * in time mode; or `start()` to tick on its own.
 */
export class RowSelector extends EventEmitter<RowSelectorEvents> {
	private s: RowSettings
	private t: Table | null = null
	private readonly now: () => number
	private _state: RowState = blank()
	/** time mode: manual hold */
	private override: { index: number; until: number | null; startedAt: number } | null = null
	private lastMatched: number | null = null
	private timer: ReturnType<typeof setInterval> | null = null

	constructor(settings: RowSettings, opts: RowSelectorOptions = {}) {
		super()
		this.s = settings
		this.now = opts.now ?? Date.now
	}

	get state(): RowState {
		return { ...this._state, row: { ...this._state.row } }
	}
	get table(): Table | null {
		return this.t
	}

	configure(settings: RowSettings): void {
		const modeChanged = settings.mode !== this.s.mode
		this.s = settings
		if (modeChanged) this.override = null
		this.reevaluate()
	}

	start(everyMs = 1000): void {
		this.stop()
		this.timer = setInterval(() => this.tick(), everyMs)
		this.timer.unref?.()
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}

	/** New or reloaded sheet. Tries to stay on the same row (by key column if set, else by position). */
	setTable(t: Table | null): void {
		const old = this.t
		const oldIdx = this._state.index
		this.t = t
		if (!t || !t.rows.length) {
			this.override = null
			this.set(null, 'none', 'No sheet rows to use')
			return
		}
		if (this.s.mode === 'time' && !this.override) {
			this.reevaluate()
			return
		}
		let idx: number | null = oldIdx
		if (old && oldIdx !== null) {
			const kc = columnIndex(old, this.s.keyColumn)
			const nk = columnIndex(t, this.s.keyColumn)
			if (kc >= 0 && nk >= 0) {
				const key = old.rows[oldIdx]?.[kc]
				const found = t.rows.findIndex((r) => r[nk] === key)
				if (found >= 0) idx = found
			}
		}
		if (idx === null) idx = this.s.mode === 'manual' ? 0 : null
		if (idx !== null) idx = Math.min(idx, t.rows.length - 1)
		if (this.override && idx !== null) this.override.index = idx
		if (idx === null) this.reevaluate()
		else if (oldIdx === null) this.set(idx, 'picked', 'First row')
		else this.set(idx, 'kept', this._state.why || 'Same row after the sheet reloaded', true)
	}

	/** Pick a row by index (0-based). In time mode this is a manual override. */
	pick(index: number, reason: RowReason = 'picked'): boolean {
		if (!this.t || !Number.isInteger(index) || index < 0 || index >= this.t.rows.length) return false
		if (this.s.mode === 'time') {
			this.override = { index, until: this.s.overrideHold === 'untilNextSlot' ? this.nextBoundary(this.now()) : null, startedAt: this.now() }
		}
		this.set(index, reason, this.describe(reason, index))
		return true
	}

	/** Pick by 1-based row number */
	pickNumber(n: number): boolean {
		return this.pick(Math.round(n) - 1)
	}

	/** Step forward (+1) or back (-1). Returns false at the ends (unless wrapping) */
	step(delta: number, reason: RowReason = 'stepped'): boolean {
		if (!this.t || !this.t.rows.length) return false
		const n = this.t.rows.length
		const cur = this._state.index ?? (delta > 0 ? -1 : n)
		let next = cur + Math.trunc(delta)
		if (this.s.wrap) next = ((next % n) + n) % n
		if (next < 0 || next >= n) return false
		return this.pick(next, reason)
	}
	next(): boolean {
		return this.step(1)
	}
	previous(): boolean {
		return this.step(-1)
	}

	/**
	 * Set by a value (e.g. a Companion expression result).
	 * `how`: 'key' = match the key column, 'number' = row number, 'auto' = key column match first, else a whole number as row number.
	 */
	setByValue(value: string | number, how: 'auto' | 'key' | 'number' = 'auto'): boolean {
		if (!this.t) return false
		const v = String(value).trim()
		if (how !== 'number') {
			const kc = columnIndex(this.t, this.s.keyColumn)
			if (kc >= 0) {
				let i = this.t.rows.findIndex((r) => r[kc] === v)
				if (i < 0) i = this.t.rows.findIndex((r) => r[kc].trim().toLowerCase() === v.toLowerCase())
				if (i >= 0) return this.pick(i, 'value')
			}
			if (how === 'key') return false
		}
		if (/^\d+$/.test(v)) {
			const i = Number(v) - 1
			if (i >= 0 && i < this.t.rows.length) return this.pick(i, 'value')
		}
		return false
	}

	/** Call when a recording stops; advances if autoAdvance is on (in time mode this becomes an override) */
	recordingStopped(): boolean {
		if (!this.s.autoAdvance) return false
		return this.step(1, 'advanced')
	}

	/** Time mode: let go of a manual pick and go back to matching by time */
	release(): void {
		if (!this.override) return
		this.override = null
		this.reevaluate('override-released')
	}

	get overridden(): boolean {
		return this.override !== null
	}

	/** Re-check time matching / override expiry */
	tick(): void {
		if (this.s.mode !== 'time') return
		if (this.override && this.override.until !== null && this.now() >= this.override.until) {
			this.override = null
			this.reevaluate('override-released')
			return
		}
		if (!this.override) this.reevaluate()
	}

	/** All time slots in the sheet (rows with an unreadable start time are left out) */
	slots(at = this.now()): Slot[] {
		const t = this.t
		if (!t) return []
		const sc = columnIndex(t, this.s.startColumn)
		if (sc < 0) return []
		const ec = columnIndex(t, this.s.endColumn)
		const dc = columnIndex(t, this.s.dateColumn)
		const today = new Date(at)
		const out: Slot[] = []
		t.rows.forEach((r, index) => {
			let day = today
			if (dc >= 0 && r[dc].trim()) {
				const d = parseSheetTime(r[dc], today, this.s.dateOrder)
				if (d === null) return
				day = new Date(d)
			}
			const start = parseSheetTime(r[sc], day, this.s.dateOrder)
			if (start === null) return
			let end = ec >= 0 ? parseSheetTime(r[ec], new Date(start), this.s.dateOrder) : null
			if (end !== null && end <= start && !/\d{4}|\//.test(r[ec])) end += 86400000 // runs past midnight
			out.push({ index, start, end })
		})
		out.sort((a, b) => a.start - b.start || a.index - b.index)
		for (let i = 0; i < out.length; i++) if (out[i].end === null && ec < 0) out[i].end = out[i + 1]?.start ?? null
		return out
	}

	/** The slot that covers `at` (latest-starting wins when slots overlap) */
	matchTime(at = this.now()): Slot | null {
		const lead = this.s.leadSeconds * 1000
		let best: Slot | null = null
		for (const sl of this.slots(at)) {
			if (at >= sl.start - lead && (sl.end === null ? false : at < sl.end - lead)) best = sl
		}
		return best
	}

	/** The next moment a slot starts or ends after `at` (null if none) */
	nextBoundary(at = this.now()): number | null {
		const lead = this.s.leadSeconds * 1000
		let best: number | null = null
		for (const sl of this.slots(at)) {
			for (const b of [sl.start - lead, sl.end === null ? null : sl.end - lead]) {
				if (b !== null && b > at && (best === null || b < best)) best = b
			}
		}
		return best
	}

	private reevaluate(reason?: RowReason): void {
		if (!this.t || !this.t.rows.length) {
			this.set(null, 'none', 'No sheet rows to use')
			return
		}
		if (this.s.mode !== 'time') {
			if (this._state.index === null) this.set(0, 'picked', 'First row')
			return
		}
		if (this.override) {
			this.set(this.override.index, this._state.reason, this._state.why)
			return
		}
		const m = this.matchTime()
		if (m) {
			this.lastMatched = m.index
			this.set(m.index, reason ?? 'time', `Matched by time: ${hhmm(m.start)}–${m.end === null ? '…' : hhmm(m.end)}${reason === 'override-released' ? ' (manual pick released)' : ''}`)
		} else if (this.s.keepLastWhenNoSlot && this.lastMatched !== null && this.lastMatched < this.t.rows.length) {
			this.set(this.lastMatched, 'time-last', 'No time slot right now: kept the last one')
		} else {
			const nb = this.nextBoundary()
			this.set(null, 'none', nb ? `No time slot right now (next at ${hhmm(nb)})` : 'No time slot covers now')
		}
	}

	private describe(reason: RowReason, index: number): string {
		const what = reason === 'stepped' ? 'Stepped' : reason === 'value' ? 'Set by value' : reason === 'advanced' ? 'Moved on after the recording' : 'Picked'
		if (this.s.mode !== 'time') return `${what}: row ${index + 1}`
		const u = this.override?.until ?? null
		return `${what}: row ${index + 1}, overriding the time match (${this.s.overrideHold === 'untilReleased' ? 'until released' : u ? `until ${hhmm(u)}` : 'until released: no later time slot'})`
	}

	private set(index: number | null, reason: RowReason, why: string, quiet = false): void {
		const prev = this._state
		let slot: RowState['slot'] = null
		if (this.s.mode === 'time' && index !== null) {
			const sl = this.slots().find((x) => x.index === index)
			if (sl) slot = { start: sl.start, end: sl.end }
		}
		const next: RowState = {
			index,
			number: index === null ? null : index + 1,
			row: index === null || !this.t ? {} : rowObject(this.t, index),
			reason: quiet ? prev.reason : reason,
			why,
			overridden: this.override !== null,
			overrideUntil: this.override?.until ?? null,
			slot,
		}
		this._state = next
		const changed = prev.index !== next.index || JSON.stringify(prev.row) !== JSON.stringify(next.row) || prev.overridden !== next.overridden || prev.why !== next.why
		if (changed) this.emit('change', this.state, prev)
	}
}

function blank(): RowState {
	return { index: null, number: null, row: {}, reason: 'none', why: 'No sheet loaded', overridden: false, overrideUntil: null, slot: null }
}
