/** Building a recording's file name from sheet columns and tokens. */
import type { NamingSettings } from './settings.js'

export interface NameContext {
	/** The selected row as { column: value } (empty object when there's no sheet/row) */
	row: Record<string, string>
	/** Row number shown to people (1 = first data row), or null */
	rowNumber?: number | null
	/** Time to use for {date}/{time} (default: now) */
	now?: Date
	/** Source / device / connection name for {source} */
	source?: string
	/** Take number for {take} (default: settings.takeStart) */
	take?: number
	/** Any extra values, e.g. Companion variables, for {var:name} (also matched by bare {name} when no column has that name) */
	vars?: Record<string, string | number | boolean | undefined>
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Format a date: YYYY, YY, MM, DD, HH, mm, ss (anything else is kept as written) */
export function formatDate(d: Date, fmt: string): string {
	return fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => {
		switch (t) {
			case 'YYYY':
				return String(d.getFullYear())
			case 'YY':
				return pad(d.getFullYear() % 100)
			case 'MM':
				return pad(d.getMonth() + 1)
			case 'DD':
				return pad(d.getDate())
			case 'HH':
				return pad(d.getHours())
			case 'mm':
				return pad(d.getMinutes())
			default:
				return pad(d.getSeconds())
		}
	})
}

function lookup(row: Record<string, string>, name: string): string | undefined {
	if (name in row) return row[name]
	const want = name.trim().toLowerCase()
	for (const k of Object.keys(row)) if (k.trim().toLowerCase() === want) return row[k]
	return undefined
}

/** The value of one token (no braces): date, time, source, take, row, col:X, var:X, or a column name */
export function tokenValue(token: string, ctx: NameContext, s: NamingSettings): string {
	const t = token.trim()
	const now = ctx.now ?? new Date()
	const low = t.toLowerCase()
	if (low.startsWith('col:')) return lookup(ctx.row, t.slice(4)) ?? ''
	if (low.startsWith('var:')) {
		const v = ctx.vars?.[t.slice(4).trim()]
		return v === undefined ? '' : String(v)
	}
	if (low.startsWith('text:')) return t.slice(5)
	// a column with the token's name wins over the built-in tokens (so a "Date" column works)
	const col = lookup(ctx.row, t)
	if (col !== undefined) return col
	switch (low) {
		case 'date':
			return formatDate(now, s.dateFormat)
		case 'time':
			return formatDate(now, s.timeFormat)
		case 'source':
			return ctx.source ?? ''
		case 'take':
			return pad(ctx.take ?? s.takeStart, Math.max(1, s.takePad))
		case 'row':
			return ctx.rowNumber == null ? '' : String(ctx.rowNumber)
	}
	const v = ctx.vars?.[t]
	return v === undefined ? '' : String(v)
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Make text safe as a file name on Windows, macOS and Linux (no extension handling). */
export function cleanFileName(name: string, s: Pick<NamingSettings, 'replaceWith' | 'maxLength'>): string {
	const rep = s.replaceWith.replace(ILLEGAL, '')
	let out = name.normalize('NFC').replace(ILLEGAL, rep)
	out = out.replace(/\s+/g, ' ').trim()
	if (rep) {
		const r = rep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		out = out.replace(new RegExp(`(${r}){2,}`, 'g'), rep)
	}
	out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
	if (RESERVED.test(out)) out = '_' + out
	if (s.maxLength > 0 && out.length > s.maxLength) out = [...out].slice(0, s.maxLength).join('').replace(/[.\s]+$/, '')
	return out
}

/** Split "name.ext" (".mp4" → ext "mp4"; dotfiles have no extension) */
export function splitExt(file: string): { base: string; ext: string } {
	const i = file.lastIndexOf('.')
	if (i <= 0) return { base: file, ext: '' }
	return { base: file.slice(0, i), ext: file.slice(i + 1) }
}

/** The raw (not yet cleaned) name from the template or parts */
export function expandName(ctx: NameContext, s: NamingSettings): string {
	if (s.template.trim()) {
		return s.template.replace(/\{([^{}]+)\}/g, (_, tok: string) => tokenValue(tok, ctx, s))
	}
	return s.parts
		.map((p) => tokenValue(p.replace(/^\{|\}$/g, ''), ctx, s).trim())
		.filter((v) => v !== '')
		.join(s.separator)
}

/** Does the pattern itself carry a take number? */
export function usesTake(s: NamingSettings): boolean {
	const has = (t: string) => /^\s*take\s*$/i.test(t)
	if (s.template.trim()) return [...s.template.matchAll(/\{([^{}]+)\}/g)].some((m) => has(m[1]))
	return s.parts.some((p) => has(p.replace(/^\{|\}$/g, '')))
}

export interface BuiltName {
	/** Name without extension */
	base: string
	/** With extension (if one was given) */
	file: string
	/** Take number used (if the pattern has {take} or collision mode 'take' kicked in) */
	take: number | null
	/** 1 = no collision; 2+ = which " (n)" was needed */
	attempt: number
}

/**
 * Build a cleaned, unique file name.
 * `taken(file)` says whether a name (with extension) is already used (e.g. by an existing file); case-insensitive is wise.
 */
export function buildName(ctx: NameContext, s: NamingSettings, opts: { ext?: string; taken?: (file: string) => boolean } = {}): BuiltName {
	const ext = (opts.ext ?? '').replace(/^\./, '')
	const taken = opts.taken ?? (() => false)
	const withExt = (b: string) => (ext ? `${b}.${ext}` : b)
	const inPattern = usesTake(s)
	const make = (take: number, suffix: string) => {
		let raw = expandName({ ...ctx, take }, s)
		let base = cleanFileName(raw, { replaceWith: s.replaceWith, maxLength: 0 })
		if (!base) base = cleanFileName(s.fallbackName, { replaceWith: s.replaceWith, maxLength: 0 }) || 'Recording'
		const room = s.maxLength > 0 ? s.maxLength - suffix.length : Infinity
		if (base.length > room) base = [...base].slice(0, Math.max(1, room)).join('').replace(/[.\s]+$/, '')
		return base + suffix
	}
	const startTake = ctx.take ?? s.takeStart
	if (inPattern || s.collision === 'take') {
		for (let take = startTake, n = 0; n < 10000; take++, n++) {
			const suffix = inPattern ? '' : n === 0 ? '' : ` ${s.takeLabel}${pad(take, Math.max(1, s.takePad))}`.replace(/\s+$/, '')
			const base = make(take, inPattern ? '' : suffix)
			if (!taken(withExt(base))) return { base, file: withExt(base), take: inPattern || n > 0 ? take : null, attempt: n + 1 }
		}
	} else {
		for (let n = 1; n < 10000; n++) {
			const base = make(startTake, n === 1 ? '' : ` (${n})`)
			if (!taken(withExt(base))) return { base, file: withExt(base), take: null, attempt: n }
		}
	}
	throw new Error('Ran out of unique names (10,000 recordings with the same name?)')
}
