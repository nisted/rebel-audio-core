/** Tables (header row + rows of strings), CSV parsing, and a small XLSX reader (no outside libraries). */
import { inflateRawSync } from 'node:zlib'

export interface Table {
	/** Column names, as written in the header row (trimmed). Blank headers become "Column N" */
	headers: string[]
	/** Data rows; every row has exactly headers.length cells */
	rows: string[][]
}

/** Turn raw cells into a Table: pick the header row, pad/trim rows, drop blank rows if asked. */
export function toTable(cells: string[][], headerRow = 1, skipBlankRows = true): Table {
	const hi = Math.max(0, Math.floor(headerRow) - 1)
	const head = (cells[hi] ?? []).map((h) => String(h ?? '').trim())
	let width = head.length
	const body = cells.slice(hi + 1)
	for (const r of body) width = Math.max(width, r.length)
	// trailing blank header columns with nothing under them are dropped
	while (width > 0 && !head[width - 1] && body.every((r) => !String(r[width - 1] ?? '').trim())) width--
	const seen = new Map<string, number>()
	const headers: string[] = []
	for (let i = 0; i < width; i++) {
		let h = head[i] || `Column ${i + 1}`
		const n = seen.get(h.toLowerCase()) ?? 0
		seen.set(h.toLowerCase(), n + 1)
		if (n) h = `${h} (${n + 1})`
		headers.push(h)
	}
	const rows: string[][] = []
	for (const r of body) {
		const row = headers.map((_, i) => String(r[i] ?? ''))
		if (skipBlankRows && row.every((c) => !c.trim())) continue
		rows.push(row)
	}
	return { headers, rows }
}

/** Index of a column by name (case and surrounding space ignored), or -1 */
export function columnIndex(t: Table, name: string): number {
	const want = name.trim().toLowerCase()
	if (!want) return -1
	return t.headers.findIndex((h) => h.trim().toLowerCase() === want)
}

/** One row as { column: value } */
export function rowObject(t: Table, i: number): Record<string, string> {
	const o: Record<string, string> = {}
	const r = t.rows[i]
	if (r) t.headers.forEach((h, j) => (o[h] = r[j] ?? ''))
	return o
}

// ---------- CSV ----------

/** RFC 4180 CSV (also handles ; or tab separated files, BOM, CRLF, quotes with "" escapes, newlines in quotes). */
export function parseCsv(text: string, delimiter?: string): string[][] {
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
	const d = delimiter ?? sniffDelimiter(text)
	const out: string[][] = []
	let row: string[] = []
	let cell = ''
	let q = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (q) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					cell += '"'
					i++
				} else q = false
			} else cell += c
		} else if (c === '"' && cell === '') q = true
		else if (c === d) {
			row.push(cell)
			cell = ''
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++
			row.push(cell)
			out.push(row)
			row = []
			cell = ''
		} else cell += c
	}
	if (cell !== '' || row.length) {
		row.push(cell)
		out.push(row)
	}
	return out
}

function sniffDelimiter(text: string): string {
	const first = text.slice(0, text.search(/\r|\n/) >>> 0 || text.length)
	let best = ','
	let n = 0
	for (const d of [',', ';', '\t']) {
		const k = first.split(d).length
		if (k > n) {
			n = k
			best = d
		}
	}
	return best
}

// ---------- ZIP (just enough for .xlsx) ----------

/** Read every file in a zip into memory. Supports stored and deflated entries (what Excel writes). */
export function unzip(buf: Uint8Array): Map<string, Uint8Array> {
	const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
	let eocd = -1
	for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
		if (b.readUInt32LE(i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new Error("That file isn't an Excel (.xlsx) file, or it's damaged")
	const count = b.readUInt16LE(eocd + 10)
	let p = b.readUInt32LE(eocd + 16)
	if (p === 0xffffffff) throw new Error('That Excel file is too big to read here (over 4 GB)')
	const files = new Map<string, Uint8Array>()
	for (let n = 0; n < count; n++) {
		if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('That Excel file looks damaged')
		const method = b.readUInt16LE(p + 10)
		const csize = b.readUInt32LE(p + 20)
		const nameLen = b.readUInt16LE(p + 28)
		const extraLen = b.readUInt16LE(p + 30)
		const commentLen = b.readUInt16LE(p + 32)
		const local = b.readUInt32LE(p + 42)
		const name = b.toString('utf8', p + 46, p + 46 + nameLen)
		p += 46 + nameLen + extraLen + commentLen
		const lNameLen = b.readUInt16LE(local + 26)
		const lExtra = b.readUInt16LE(local + 28)
		const start = local + 30 + lNameLen + lExtra
		const data = b.subarray(start, start + csize)
		if (method === 0) files.set(name, data)
		else if (method === 8) files.set(name, inflateRawSync(data))
		// other methods: skipped (never used by Excel/Sheets/Numbers exports)
	}
	return files
}

// ---------- tiny XML helpers ----------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function xmlDecode(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
		if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
		return ENT[e] ?? m
	})
}
function attrs(tag: string): Record<string, string> {
	const o: Record<string, string> = {}
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
		const k = m[1].includes(':') && !m[1].startsWith('xmlns') ? m[1] : m[1]
		o[k] = xmlDecode(m[3] ?? m[4] ?? '')
		const local = m[1].split(':').pop()!
		if (!(local in o)) o[local] = o[k]
	}
	return o
}
/** All text inside <t> elements of a fragment (skipping phonetic <rPh> runs) */
function textOf(frag: string): string {
	frag = frag.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '')
	let s = ''
	for (const m of frag.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) s += xmlDecode(m[1])
	return s
}

// ---------- XLSX ----------

/** Excel's built-in number formats that are dates/times (id → a format we can classify) */
const BUILTIN_DATE_FORMATS = new Map<number, string>([
	[14, 'yyyy-mm-dd'],
	[15, 'yyyy-mm-dd'],
	[16, 'yyyy-mm-dd'],
	[17, 'yyyy-mm-dd'],
	[18, 'h:mm'],
	[19, 'h:mm:ss'],
	[20, 'h:mm'],
	[21, 'h:mm:ss'],
	[22, 'yyyy-mm-dd h:mm'],
	[45, 'mm:ss'],
	[46, 'h:mm:ss'],
	[47, 'mm:ss'],
])

function isDateFormat(code: string): boolean {
	const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
	return /[dmyhs]/i.test(bare) && !/^[#0.,%E+\-\s]*$/i.test(bare)
}

function excelSerialToText(v: number, date1904: boolean, code: string): string {
	const ms = Math.round((v + (date1904 ? 1462 : 0) - 25569) * 86400000)
	const d = new Date(ms)
	const p = (n: number) => String(n).padStart(2, '0')
	const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
	const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '').toLowerCase()
	const hasTime = /h|s/.test(bare) || (v % 1 !== 0 && !/[dy]/.test(bare))
	const hasSecs = /s/.test(bare)
	const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${hasSecs ? ':' + p(d.getUTCSeconds()) : ''}`
	if (v < 1 && hasTime) return hm
	return hasTime ? `${ymd} ${hm}` : ymd
}

export interface XlsxSheetInfo {
	name: string
	path: string
}

/** The sheets (tabs) inside an .xlsx, in order */
export function xlsxSheets(files: Map<string, Uint8Array>): XlsxSheetInfo[] {
	const wb = files.get('xl/workbook.xml')
	if (!wb) throw new Error("That file isn't an Excel (.xlsx) workbook (it might be an old .xls: save it as .xlsx or CSV)")
	const rels = new Map<string, string>()
	const relXml = files.get('xl/_rels/workbook.xml.rels')
	if (relXml) {
		for (const m of Buffer.from(relXml).toString('utf8').matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
			const a = attrs(m[0])
			let t = a.Target ?? ''
			t = t.startsWith('/') ? t.slice(1) : 'xl/' + t
			rels.set(a.Id, t.replace(/\/\.\//g, '/'))
		}
	}
	const out: XlsxSheetInfo[] = []
	let i = 1
	for (const m of Buffer.from(wb).toString('utf8').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
		const a = attrs(m[0])
		const rid = a['r:id'] ?? a.id
		out.push({ name: a.name ?? `Sheet${i}`, path: rels.get(rid) ?? `xl/worksheets/sheet${i}.xml` })
		i++
	}
	return out
}

function colNumber(ref: string): number {
	let n = 0
	for (const ch of ref.toUpperCase()) {
		const c = ch.charCodeAt(0)
		if (c < 65 || c > 90) break
		n = n * 26 + (c - 64)
	}
	return n - 1
}

/**
 * Read one sheet of an .xlsx as cells of text (what you'd see in Excel, near enough: dates as
 * YYYY-MM-DD, times as HH:MM, date-times as YYYY-MM-DD HH:MM, numbers as plain numbers).
 * `which`: blank = first sheet, a number = position from 1, otherwise the sheet's name.
 */
export function parseXlsx(buf: Uint8Array, which = ''): { cells: string[][]; sheet: string; sheets: string[] } {
	const files = unzip(buf)
	const sheets = xlsxSheets(files)
	if (!sheets.length) throw new Error('That Excel file has no sheets in it')
	let pick = sheets[0]
	const w = which.trim()
	if (w) {
		const byName = sheets.find((s) => s.name.toLowerCase() === w.toLowerCase())
		const byPos = /^\d+$/.test(w) ? sheets[Number(w) - 1] : undefined
		pick = byName ?? byPos ?? (undefined as any)
		if (!pick) throw new Error(`There's no sheet called "${w}" in that Excel file (it has: ${sheets.map((s) => s.name).join(', ')})`)
	}
	const str = (p: string) => {
		const f = files.get(p)
		return f ? Buffer.from(f).toString('utf8') : ''
	}
	const shared: string[] = []
	for (const m of str('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '')
	const numFmts = new Map<number, string>()
	const stylesXml = str('xl/styles.xml')
	for (const m of stylesXml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) {
		const a = attrs(m[0])
		numFmts.set(Number(a.numFmtId), a.formatCode ?? '')
	}
	const xfFormats: (string | null)[] = []
	const cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)?.[1] ?? ''
	for (const m of cellXfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)) {
		const id = Number(attrs(m[0]).numFmtId ?? 0)
		const code = numFmts.get(id)
		xfFormats.push(code !== undefined ? (isDateFormat(code) ? code : null) : (BUILTIN_DATE_FORMATS.get(id) ?? null))
	}
	const date1904 = /date1904\s*=\s*"(1|true)"/i.test(str('xl/workbook.xml'))
	const cells: string[][] = []
	const xml = str(pick.path)
	let autoRow = 0
	for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
		const ra = attrs(rm[1])
		const r = ra.r ? Number(ra.r) - 1 : autoRow
		autoRow = r + 1
		const row: string[] = []
		let autoCol = 0
		for (const cm of (rm[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
			const a = attrs(cm[1])
			const ci = a.r ? colNumber(a.r) : autoCol
			autoCol = ci + 1
			const inner = cm[2] ?? ''
			const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1]
			let text = ''
			switch (a.t) {
				case 's':
					text = shared[Number(v)] ?? ''
					break
				case 'inlineStr':
					text = textOf(inner)
					break
				case 'b':
					text = v === '1' ? 'TRUE' : 'FALSE'
					break
				case 'str':
				case 'e':
					text = v !== undefined ? xmlDecode(v) : ''
					break
				default: {
					if (v === undefined) break
					const num = Number(v)
					const fmt = a.s !== undefined ? xfFormats[Number(a.s)] : null
					text = fmt && Number.isFinite(num) ? excelSerialToText(num, date1904, fmt) : xmlDecode(v)
				}
			}
			while (row.length < ci) row.push('')
			row[ci] = text
		}
		while (cells.length < r) cells.push([])
		cells[r] = row
	}
	return { cells, sheet: pick.name, sheets: sheets.map((s) => s.name) }
}

/** CSV or XLSX bytes → cells (xlsx spotted by its zip signature, whatever the file name says) */
export function parseFileBytes(bytes: Uint8Array, excelSheet = ''): string[][] {
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return parseXlsx(bytes, excelSheet).cells
	if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
		throw new Error("That's an old-style Excel file (.xls). Open it and save as .xlsx or CSV, then upload that")
	return parseCsv(new TextDecoder('utf-8').decode(bytes))
}
