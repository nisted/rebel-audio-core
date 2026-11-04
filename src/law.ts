/**
 * Levels and the fader law.
 *
 * Everything inside the module works in dB (null = -inf). The fader on the
 * web page and Grid fader positions use a position 0-1 along the fader travel.
 */

export type Db = number | null // null = -inf

/** The floor: anything at or below is -inf */
export const MIN_DB = -100

export function mulToDb(mul: number): Db {
	if (!(mul > 0)) return null
	const db = 20 * Math.log10(mul)
	return db <= MIN_DB ? null : db
}

export function dbToMul(db: Db): number {
	return db === null ? 0 : Math.pow(10, db / 20)
}

/** dB to power, for averaging */
export function dbToPow(db: Db): number {
	return db === null ? 0 : Math.pow(10, db / 10)
}

export function powToDb(p: number): Db {
	if (!(p > 0)) return null
	const db = 10 * Math.log10(p)
	return db <= MIN_DB ? null : db
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n))
}

export function fmtDb(db: Db, decimals = 1): string {
	return db === null ? '-inf' : db.toFixed(decimals)
}

export type LawKind = 'desk' | 'linear'

export interface LawSettings {
	kind: LawKind
	/** Top of the fader, dB */
	topDb: number
	/** Bottom of the travel above -inf, dB (linear law only; desk law fixes its own lower marks) */
	bottomDb: number
}

/**
 * Desk law: position -> dB marks below unity, as on a typical console.
 * Unity sits at 0.75; above it the travel runs linearly to the top dB.
 */
const DESK_MARKS: [number, number][] = [
	[0.03, -80],
	[0.08, -60],
	[0.15, -50],
	[0.25, -40],
	[0.35, -30],
	[0.45, -20],
	[0.55, -12],
	[0.65, -6],
	[0.75, 0],
]

export function positionToDb(pos: number, law: LawSettings): Db {
	const p = clamp(pos, 0, 1)
	if (p <= 0) return null
	if (law.kind === 'linear') {
		return law.bottomDb + (law.topDb - law.bottomDb) * p
	}
	const unity = 0.75
	if (p >= unity) return law.topDb <= 0 ? 0 : ((p - unity) / (1 - unity)) * law.topDb
	if (p < DESK_MARKS[0][0]) {
		// between -inf and the first mark: fall off to the floor
		const [p0, d0] = DESK_MARKS[0]
		return MIN_DB + ((d0 - MIN_DB) * p) / p0
	}
	for (let i = 1; i < DESK_MARKS.length; i++) {
		const [p1, d1] = DESK_MARKS[i]
		const [p0, d0] = DESK_MARKS[i - 1]
		if (p <= p1) return d0 + ((d1 - d0) * (p - p0)) / (p1 - p0)
	}
	return 0
}

export function dbToPosition(db: Db, law: LawSettings): number {
	if (db === null || db <= MIN_DB) return 0
	if (law.kind === 'linear') {
		if (db <= law.bottomDb) return 0
		return clamp((db - law.bottomDb) / (law.topDb - law.bottomDb), 0, 1)
	}
	const unity = 0.75
	if (db >= 0) return law.topDb <= 0 ? unity : clamp(unity + (db / law.topDb) * (1 - unity), 0, 1)
	const [p0, d0] = DESK_MARKS[0]
	if (db <= d0) return clamp(((db - MIN_DB) / (d0 - MIN_DB)) * p0, 0, 1)
	for (let i = 1; i < DESK_MARKS.length; i++) {
		const [p1, d1] = DESK_MARKS[i]
		const [pa, da] = DESK_MARKS[i - 1]
		if (db <= d1) return pa + ((p1 - pa) * (db - da)) / (d1 - da)
	}
	return unity
}

/** A number from typed text or a variable's value, falling back to `fallback` */
export function parseNumber(raw: unknown, fallback: number, min = -Infinity, max = Infinity): number {
	const text = String(raw ?? '').trim()
	const n = Number(text)
	if (text === '' || Number.isNaN(n)) return fallback
	return clamp(n, min, max)
}

/** A dB value from text: a number, or '-inf' */
export function parseDb(raw: unknown): Db | undefined {
	const text = String(raw ?? '')
		.trim()
		.toLowerCase()
	if (text === '') return undefined
	if (text === '-inf' || text === 'inf' || text === '-infinity') return null
	const n = Number(text)
	if (Number.isNaN(n)) return undefined
	return n <= MIN_DB ? null : n
}
