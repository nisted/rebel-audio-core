import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
	parseCsv,
	toTable,
	parseXlsx,
	parseFileBytes,
	parseGoogleSheetUrl,
	googleCsvUrl,
	SheetSource,
	buildName,
	cleanFileName,
	recordingSettings,
	RowSelector,
	parseSheetTime,
	parseClock,
	RecordingNamer,
	FileManager,
	FileError,
	readDuration,
	UploadQueue,
	UploadError,
	shareTransport,
	httpTransport,
	webdavTransport,
	rcloneTransport,
	checkRclone,
	rcloneTarget,
	remoteFolder,
	nextAt,
	Recordings,
	type FetchLike,
	type Table,
	type Transport,
	type TransportSet,
	type Destination,
	type UploadSettings,
} from '../../src/recordings/index.js'
import { sampleXlsx, sleep, tmp, zip } from './helpers.js'

const S = () => recordingSettings()

// ---------------- tables: CSV + XLSX ----------------

test('CSV: quotes, escaped quotes, newlines in cells, CRLF, BOM, semicolons', () => {
	const csv = '\ufeffName,"Note, with comma",Q\r\n"Ana ""the voice""","line1\nline2",x\r\n,,\r\nBob,,y'
	const cells = parseCsv(csv)
	assert.deepEqual(cells[0], ['Name', 'Note, with comma', 'Q'])
	assert.deepEqual(cells[1], ['Ana "the voice"', 'line1\nline2', 'x'])
	const t = toTable(cells)
	assert.equal(t.rows.length, 2, 'blank row dropped')
	assert.deepEqual(t.rows[1], ['Bob', '', 'y'])
	assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']])
	const dup = toTable(parseCsv('A,A,,\n1,2,3,'))
	assert.deepEqual(dup.headers, ['A', 'A (2)', 'Column 3'])
})

test('XLSX: shared strings, rich text, inline strings, time/date formats, gaps, booleans, sheet picking', () => {
	const x = sampleXlsx()
	const r = parseXlsx(x)
	assert.equal(r.sheet, 'Schedule')
	assert.deepEqual(r.sheets, ['Schedule', 'Other & Stuff'])
	const t = toTable(r.cells)
	assert.deepEqual(t.headers, ['Session', 'Speaker', 'Start', 'Day', 'Room'])
	assert.deepEqual(t.rows[0], ['Keynote & Q', 'Ana Smith', '09:30', '2026-11-04', '3'])
	assert.deepEqual(t.rows[1], ['Panel', '', '10:30', '', 'TRUE'])
	assert.deepEqual(parseXlsx(x, 'other & stuff').cells[0], ['', 'Tab two'])
	assert.deepEqual(parseXlsx(x, '2').cells[0], ['', 'Tab two'])
	assert.throws(() => parseXlsx(x, 'Nope'), /no sheet called "Nope".*Schedule/)
	// via bytes sniffing; stored (not deflated) zip works too
	assert.equal(toTable(parseFileBytes(x)).rows.length, 2)
	assert.throws(() => parseFileBytes(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])), /old-style Excel/)
	assert.throws(() => parseXlsx(zip({ 'a.txt': 'x' }, true)), /isn't an Excel/)
})

// ---------------- Google Sheets ----------------

test('Google Sheet links: edit, share, gid in hash, published, bare id, wrong sites', () => {
	const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
	assert.deepEqual(parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`), { id, published: false, gid: '123' })
	assert.deepEqual(parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), { id, published: false, gid: null })
	assert.equal(parseGoogleSheetUrl(`docs.google.com/spreadsheets/u/1/d/${id}/edit?gid=9#gid=9`).gid, '9')
	assert.equal(parseGoogleSheetUrl(id).id, id)
	const pub = parseGoogleSheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vabcdefghijklmnopqrstuvwxyz/pubhtml?gid=5')
	assert.equal(pub.published, true)
	assert.match(googleCsvUrl(pub), /\/d\/e\/2PACX-.*\/pub\?output=csv&gid=5&single=true/)
	const link = parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`)
	assert.equal(googleCsvUrl(link), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=123`)
	assert.equal(googleCsvUrl(link, '77'), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=77`)
	assert.equal(googleCsvUrl(link, 'Day 2'), `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=Day%202`)
	assert.throws(() => parseGoogleSheetUrl('https://example.com/x'), /isn't a Google Sheets link/)
	assert.throws(() => parseGoogleSheetUrl(`https://docs.google.com/document/d/${id}/edit`), /Doc\/Slides\/Form/)
	assert.throws(() => parseGoogleSheetUrl(''), /No Google Sheet link/)
})

function mockFetch(handler: (url: string) => { status?: number; body?: string; url?: string; type?: string } | Error) {
	const calls: string[] = []
	const f: FetchLike = async (url) => {
		calls.push(url)
		const r = handler(url)
		if (r instanceof Error) throw r
		return {
			ok: (r.status ?? 200) < 400,
			status: r.status ?? 200,
			url: r.url ?? url,
			headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.type ?? 'text/csv') : null) },
			text: async () => r.body ?? '',
		}
	}
	return { f, calls }
}

test('Google Sheet source: loads, keeps the last good copy on errors, plain-words errors, polls', async () => {
	let mode = 'ok'
	const { f, calls } = mockFetch(() => {
		if (mode === 'ok') return { body: 'Session,Start\nA,09:00\nB,10:00' }
		if (mode === 'private') return { url: 'https://accounts.google.com/v3/signin/identifier?continue=x', type: 'text/html', body: '<html>Sign in</html>' }
		if (mode === '404') return { status: 404 }
		const e: any = new TypeError('fetch failed')
		e.cause = { code: 'ENOTFOUND' }
		return e
	})
	const timers: { fn: () => void; ms: number }[] = []
	const set = { ...S().sheet, kind: 'google' as const, googleUrl: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0', pollSeconds: 30 }
	const src = new SheetSource(set, { fetch: f, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => {} })
	const tables: Table[] = []
	src.on('table', (t) => tables.push(t))
	await src.refresh()
	assert.equal(src.status.ok, true)
	assert.equal(src.table!.rows.length, 2)
	assert.match(calls[0], /export\?format=csv&gid=0/)
	mode = 'private'
	await src.refresh()
	assert.equal(src.status.ok, true, 'still has the old copy')
	assert.match(src.status.error!, /isn't shared with 'anyone with the link'/)
	assert.equal(src.table!.rows.length, 2)
	mode = '404'
	await src.refresh()
	assert.match(src.status.error!, /doesn't exist/)
	mode = 'down'
	await src.refresh()
	assert.match(src.status.error!, /no internet/)
	mode = 'ok'
	await src.refresh()
	assert.equal(src.status.error, null)
	assert.equal(tables.length, 1, 'same content: no second table event')
	// polling: start schedules immediately, then every pollSeconds
	src.start()
	assert.equal(timers.at(-1)!.ms, 0)
	timers.at(-1)!.fn()
	await sleep(5)
	assert.equal(timers.at(-1)!.ms, 30000)
	src.stop()
})

test('File sheet source: CSV and xlsx bytes; a bad file keeps the old copy', () => {
	const src = new SheetSource({ ...S().sheet, kind: 'file' })
	src.loadFile(Buffer.from('A,B\n1,2'), 'x.csv')
	assert.deepEqual(src.table!.headers, ['A', 'B'])
	src.loadFile(sampleXlsx(), 'sched.xlsx')
	assert.equal(src.table!.headers[0], 'Session')
	assert.throws(() => src.loadFile(Buffer.from(''), 'empty.csv'), /empty/)
	assert.equal(src.table!.headers[0], 'Session')
	assert.match(src.status.error!, /empty/)
})

// ---------------- naming ----------------

const fixed = new Date(2026, 10, 4, 9, 5, 7)

test('naming: parts, template, tokens, vars, cleaning, max length, fallback', () => {
	const n = { ...S().naming, parts: ['Session', 'Speaker', 'date'] }
	const row = { Session: 'Keynote: Day 1', Speaker: 'Ana / Bob', Room: '' }
	assert.equal(buildName({ row, now: fixed }, n).file, 'Keynote_ Day 1 - Ana _ Bob - 2026-11-04')
	assert.equal(buildName({ row, now: fixed }, { ...n, parts: ['Session', 'Room', 'time'] }).base, 'Keynote_ Day 1 - 09-05-07', 'empty parts skipped')
	const t = { ...n, template: '{source} {take} {row} {var:show} {col:Speaker} {date}', dateFormat: 'YYMMDD' }
	assert.equal(buildName({ row, rowNumber: 3, now: fixed, source: 'Cam A', take: 4, vars: { show: 'Expo' } }, t).base, 'Cam A 04 3 Expo Ana _ Bob 261104')
	assert.equal(buildName({ row, now: fixed }, { ...n, parts: ['Session'], maxLength: 7 }, { ext: 'mp4' }).file, 'Keynote.mp4')
	assert.equal(buildName({ row: {}, now: fixed }, { ...n, parts: ['Nothing'] }).base, 'Recording')
	assert.equal(cleanFileName(' ..con.. ', { replaceWith: '_', maxLength: 0 }), '_con')
	assert.equal(cleanFileName('a<>b??c', { replaceWith: '-', maxLength: 0 }), 'a-b-c')
	// a column called Date wins over the date token
	assert.equal(buildName({ row: { Date: 'Tues' }, now: fixed }, { ...n, parts: ['date'] }).base, 'Tues')
})

test('naming: collisions with " (2)" and with take numbers', () => {
	const n = { ...S().naming, parts: ['Session'] }
	const used = new Set(['talk.mp4', 'talk (2).mp4'])
	const taken = (f: string) => used.has(f.toLowerCase())
	assert.equal(buildName({ row: { Session: 'Talk' } }, n, { ext: 'mp4', taken }).file, 'Talk (3).mp4')
	const tk = { ...n, collision: 'take' as const }
	const r = buildName({ row: { Session: 'Talk' } }, tk, { ext: 'mp4', taken })
	assert.equal(r.file, 'Talk Take 02.mp4')
	assert.equal(r.take, 2)
	const inPat = { ...n, parts: ['Session', 'take'] }
	used.add('talk - 01.mp4')
	assert.equal(buildName({ row: { Session: 'Talk' }, take: 1 }, inPat, { ext: 'mp4', taken }).file, 'Talk - 02.mp4')
	// suffix fits inside max length
	assert.equal(buildName({ row: { Session: 'Talk' } }, { ...n, maxLength: 6 }, { ext: 'mp4', taken: (f) => f === 'Talk.mp4' }).file, 'Ta (2).mp4')
})

// ---------------- rows ----------------

const sched: Table = {
	headers: ['Code', 'Session', 'Start', 'End'],
	rows: [
		['K1', 'Keynote', '09:00', '10:00'],
		['P1', 'Panel', '10:00', '11:00'],
		['L1', 'Lunch', '12:30', '13:30'],
	],
}
const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m).getTime()

test('time parsing: clocks, am/pm, dates both ways, serials, nonsense', () => {
	const day = new Date(2026, 10, 4)
	assert.equal(parseClock('9:30'), 9 * 3600 + 1800)
	assert.equal(parseClock('0930'), 9 * 3600 + 1800)
	assert.equal(parseClock('9.30pm'), 21 * 3600 + 1800)
	assert.equal(parseClock('12am'), 0)
	assert.equal(parseClock('9'), null)
	assert.equal(parseClock('25:00'), null)
	assert.equal(parseSheetTime('09:30', day), at(9, 30))
	assert.equal(parseSheetTime('2026-11-05 08:00', day), new Date(2026, 10, 5, 8).getTime())
	assert.equal(parseSheetTime('05/11/2026 08:00', day), new Date(2026, 10, 5, 8).getTime())
	assert.equal(parseSheetTime('11/05/2026 08:00', day, 'mdy'), new Date(2026, 10, 5, 8).getTime())
	assert.equal(parseSheetTime('0.375', day), at(9))
	assert.equal(parseSheetTime('46330.375', day), at(9))
	assert.equal(parseSheetTime('soon', day), null)
})

test('rows: pick, next/previous, wrap, set by key or number, auto-advance, keep row across reloads', () => {
	const r = new RowSelector({ ...S().rows, keyColumn: 'Code', autoAdvance: true })
	const changes: number[] = []
	r.on('change', (s) => changes.push(s.index ?? -1))
	r.setTable(sched)
	assert.equal(r.state.index, 0)
	assert.ok(r.next())
	assert.equal(r.state.row.Session, 'Panel')
	assert.equal(r.state.reason, 'stepped')
	assert.ok(r.next())
	assert.equal(r.next(), false, 'end without wrap')
	r.configure({ ...S().rows, keyColumn: 'Code', wrap: true, autoAdvance: true })
	assert.ok(r.next())
	assert.equal(r.state.index, 0)
	assert.ok(r.previous())
	assert.equal(r.state.index, 2)
	assert.ok(r.setByValue('p1'))
	assert.equal(r.state.index, 1)
	assert.equal(r.state.reason, 'value')
	assert.ok(r.setByValue(3))
	assert.equal(r.state.index, 2)
	assert.equal(r.setByValue('ZZ'), false)
	assert.ok(r.recordingStopped())
	assert.equal(r.state.index, 0)
	assert.equal(r.state.reason, 'advanced')
	r.pick(1)
	// sheet reloaded with a row inserted above: stays on P1 via key column
	r.setTable({ ...sched, rows: [['X0', 'Intro', '08:00', '09:00'], ...sched.rows] })
	assert.equal(r.state.row.Code, 'P1')
	assert.equal(r.state.index, 2)
	assert.ok(changes.length >= 8)
	assert.match(r.state.why, /row 2/)
})

test('rows: match by time, gaps, end-less schedules, override until next slot / until released', () => {
	let now = at(9, 15)
	const base = { ...S().rows, mode: 'time' as const }
	const r = new RowSelector(base, { now: () => now })
	r.setTable(sched)
	assert.equal(r.state.row.Code, 'K1')
	assert.equal(r.state.reason, 'time')
	assert.match(r.state.why, /09:00–10:00/)
	now = at(10, 0)
	r.tick()
	assert.equal(r.state.row.Code, 'P1')
	now = at(11, 30)
	r.tick()
	assert.equal(r.state.index, null)
	assert.match(r.state.why, /next at 12:30/)
	// override holds until the next slot boundary (12:30)
	r.pick(0)
	assert.equal(r.state.overridden, true)
	assert.equal(r.state.overrideUntil, at(12, 30))
	now = at(12, 0)
	r.tick()
	assert.equal(r.state.row.Code, 'K1')
	now = at(12, 31)
	r.tick()
	assert.equal(r.state.overridden, false)
	assert.equal(r.state.row.Code, 'L1')
	assert.equal(r.state.reason, 'override-released')
	// until released
	r.configure({ ...base, overrideHold: 'untilReleased' })
	r.pick(1)
	now = at(13, 45)
	r.tick()
	assert.equal(r.state.row.Code, 'P1')
	r.release()
	assert.equal(r.state.index, null)
	// keep last when there's no slot
	r.configure({ ...base, keepLastWhenNoSlot: true })
	now = at(12, 45)
	r.tick()
	now = at(14, 0)
	r.tick()
	assert.equal(r.state.row.Code, 'L1')
	assert.equal(r.state.reason, 'time-last')
	// no End column: each row runs until the next start; last one is open-ended (not matched)
	const r2 = new RowSelector({ ...base, endColumn: '' }, { now: () => at(11, 0) })
	r2.setTable(sched)
	assert.equal(r2.state.row.Code, 'P1')
	// lead seconds: start early
	const r3 = new RowSelector({ ...base, leadSeconds: 120 }, { now: () => at(12, 29) })
	r3.setTable(sched)
	assert.equal(r3.state.row.Code, 'L1')
	// dated rows: only today's match
	const dated: Table = { headers: ['Day', 'Start', 'End', 'S'], rows: [['03/11/2026', '09:00', '10:00', 'yesterday'], ['04/11/2026', '09:00', '10:00', 'today']] }
	const r4 = new RowSelector({ ...base, dateColumn: 'Day' }, { now: () => at(9, 30) })
	r4.setTable(dated)
	assert.equal(r4.state.row.S, 'today')
	// full date-times in Start/End
	const dt: Table = { headers: ['Start', 'End', 'S'], rows: [['2026-11-04 23:00', '2026-11-05 01:00', 'late']] }
	const r5 = new RowSelector(base, { now: () => new Date(2026, 10, 5, 0, 30).getTime() })
	r5.setTable(dt)
	assert.equal(r5.state.row.S, 'late')
	// auto-advance in time mode becomes an override
	const r6 = new RowSelector({ ...base, autoAdvance: true }, { now: () => at(9, 30) })
	r6.setTable(sched)
	r6.recordingStopped()
	assert.equal(r6.state.row.Code, 'P1')
	assert.equal(r6.state.overridden, true)
})

// ---------------- rename flow ----------------

test('rename flow: name at start, rename after stop when the row changed, waits for the file to settle', async () => {
	const dir = tmp()
	const rows = new RowSelector({ ...S().rows, keyColumn: 'Code' })
	rows.setTable(sched)
	const naming = { ...S().naming, parts: ['Session', 'take'] }
	const rename = { ...S().rename, stablePollMs: 20, stableChecks: 2, renameRetryMs: 10, stableTimeoutMs: 300 }
	const namer = new RecordingNamer({ rows, naming: () => naming, rename: () => rename, folder: () => dir })
	const name = await namer.nameForStart()
	assert.equal(name, 'Keynote - 01')
	const file = join(dir, name + '.mp4')
	writeFileSync(file, 'a')
	// still being written for a bit
	const grow = setInterval(() => appendFileSync(file, 'more'), 5)
	setTimeout(() => clearInterval(grow), 60)
	rows.next() // row changed during the take
	const t0 = Date.now()
	const res = await namer.stopped(file)
	assert.ok(Date.now() - t0 >= 50, 'waited for writes to stop')
	assert.equal(res.renamed, true)
	assert.equal(res.name, 'Panel - 01.mp4')
	assert.ok(existsSync(join(dir, 'Panel - 01.mp4')))
	assert.match(res.note, /row changed/)
	// same row → kept; second take on Panel gets take 02
	const n2 = await namer.nameForStart()
	assert.equal(n2, 'Panel - 02')
	writeFileSync(join(dir, n2 + '.mp4'), 'x')
	const r2 = await namer.stopped(join(dir, n2 + '.mp4'))
	assert.equal(r2.renamed, false)
	assert.match(r2.note, /stayed the same/)
	// device ignored our name → renamed to ours
	await namer.nameForStart()
	writeFileSync(join(dir, '2026-11-04 10-00-00.mp4'), 'x')
	const r3 = await namer.stopped(join(dir, '2026-11-04 10-00-00.mp4'))
	assert.equal(r3.name, 'Panel - 03.mp4')
	// file missing
	await namer.nameForStart()
	rows.next()
	const r4 = await namer.stopped(join(dir, 'gone.mp4'))
	assert.equal(r4.renamed, false)
	assert.match(r4.note, /never appeared|isn't there/)
})

test('rename flow: collision at stop gets " (2)"; off switch respected', async () => {
	const dir = tmp()
	const rows = new RowSelector(S().rows)
	rows.setTable(sched)
	const naming = { ...S().naming, parts: ['Session'] }
	let rename = { ...S().rename, stablePollMs: 5, stableChecks: 1 }
	const namer = new RecordingNamer({ rows, naming: () => naming, rename: () => rename, folder: () => dir })
	writeFileSync(join(dir, 'Panel.mp4'), 'old')
	await namer.nameForStart()
	writeFileSync(join(dir, 'Keynote.mp4'), 'x')
	rows.next()
	const r = await namer.stopped(join(dir, 'Keynote.mp4'))
	assert.equal(r.name, 'Panel (2).mp4')
	assert.equal(readFileSync(join(dir, 'Panel.mp4'), 'utf8'), 'old')
	rename = { ...rename, renameAfterStop: false }
	await namer.nameForStart()
	rows.next()
	assert.equal((await namer.stopped(join(dir, 'Panel (2).mp4'))).renamed, false)
})

// ---------------- file manager ----------------

function mp4WithDuration(seconds: number): Buffer {
	const box = (type: string, body: Buffer) => {
		const h = Buffer.alloc(8)
		h.writeUInt32BE(8 + body.length)
		h.write(type, 4, 'latin1')
		return Buffer.concat([h, body])
	}
	const mvhd = Buffer.alloc(100)
	mvhd.writeUInt32BE(1000, 12) // timescale
	mvhd.writeUInt32BE(seconds * 1000, 16)
	return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.alloc(50)), box('moov', box('mvhd', mvhd))])
}
function wav(seconds: number): Buffer {
	const rate = 8000
	const data = Buffer.alloc(rate * seconds)
	const h = Buffer.alloc(44)
	h.write('RIFF', 0)
	h.writeUInt32LE(36 + data.length, 4)
	h.write('WAVE', 8)
	h.write('fmt ', 12)
	h.writeUInt32LE(16, 16)
	h.writeUInt16LE(1, 20)
	h.writeUInt16LE(1, 22)
	h.writeUInt32LE(rate, 24)
	h.writeUInt32LE(rate, 28)
	h.writeUInt16LE(1, 32)
	h.writeUInt16LE(8, 34)
	h.write('data', 36)
	h.writeUInt32LE(data.length, 40)
	return Buffer.concat([h, data])
}

function fmRig() {
	const root = tmp('fm-')
	const dir = join(root, 'rec')
	mkdirSync(dir)
	mkdirSync(join(dir, 'sub'))
	writeFileSync(join(dir, 'a.mp4'), mp4WithDuration(42))
	writeFileSync(join(dir, 'b.wav'), wav(3))
	writeFileSync(join(dir, 'c.mkv'), 'mkv')
	writeFileSync(join(dir, 'notes.txt'), 'no')
	writeFileSync(join(dir, '.hidden.mp4'), 'h')
	writeFileSync(join(dir, 'sub', 'd.mp4'), 'd')
	writeFileSync(join(root, 'secret.mp4'), 'secret')
	symlinkSync(join(root, 'secret.mp4'), join(dir, 'link.mp4'))
	symlinkSync(root, join(dir, 'up'))
	let now = 1000
	const busy = new Set<string>()
	const fm = new FileManager({ folder: dir, settings: { ...S().files }, now: () => now, busy: () => busy })
	return { root, dir, fm, busy, tick: (ms: number) => (now += ms) }
}

test('file manager: lists recordings with sizes and cheap durations; hidden, other types and escaping links left out', async () => {
	const { fm } = fmRig()
	const l = await fm.list()
	const names = l.map((f) => f.name).sort()
	assert.deepEqual(names, ['a.mp4', 'b.wav', 'c.mkv'])
	const a = l.find((f) => f.name === 'a.mp4')!
	assert.equal(a.duration, 42)
	assert.equal(a.type, 'video/mp4')
	assert.equal(l.find((f) => f.name === 'b.wav')!.duration, 3)
	assert.equal(l.find((f) => f.name === 'c.mkv')!.duration, null, 'mkv: not cheaply available')
	fm.configure({ ...S().files, depth: 1 })
	assert.ok((await fm.list()).some((f) => f.name === 'sub/d.mp4'))
	assert.equal(await readDuration('/nonexistent.mp4'), null)
})

test('file manager: path traversal attempts are refused', async () => {
	const { fm } = fmRig()
	fm.configure({ ...S().files, depth: 1 })
	for (const bad of ['../secret.mp4', '..%2Fsecret.mp4', '/etc/passwd', 'sub/../../secret.mp4', 'C:\\Windows\\x', '..\\secret.mp4', 'link.mp4', 'up/secret.mp4', 'a.mp4\0.txt', '', './a.mp4', 'sub//d.mp4']) {
		await assert.rejects(fm.info(bad), (e: any) => e instanceof FileError && (e.code === 'outside' || e.code === 'bad-name' || e.code === 'not-found'), bad)
	}
	await assert.rejects(fm.rename('../secret.mp4', 'x'), FileError)
	await assert.rejects(fm.requestDelete('link.mp4'), FileError)
	assert.equal((await fm.info('sub/d.mp4')).size, 1)
	const noFolder = new FileManager({ folder: () => null, settings: S().files })
	await assert.rejects(noFolder.list(), /isn't known yet/)
})

test('file manager: rename keeps the extension, refuses clashes and busy files', async () => {
	const { fm, dir, busy } = fmRig()
	assert.equal(await fm.rename('a.mp4', 'My: talk'), 'My_ talk.mp4')
	assert.ok(existsSync(join(dir, 'My_ talk.mp4')))
	assert.equal(await fm.rename('My_ talk.mp4', 'Again.mov'), 'Again.mov.mp4', 'real type kept')
	writeFileSync(join(dir, 'Clash.mp4'), 'c')
	await assert.rejects(fm.rename('Again.mov.mp4', 'clash'), (e: any) => e.code === 'exists' && /already a file/.test(e.message))
	await assert.rejects(fm.rename('b.wav', 'c/d'), /can't have/)
	busy.add('c.mkv')
	await assert.rejects(fm.rename('c.mkv', 'z'), /still being recorded/)
	// case-only rename works
	assert.equal(await fm.rename('b.wav', 'B'), 'B.wav')
})

test('file manager: delete needs a confirm token, one use, expires, tied to the file', async () => {
	const { fm, dir, tick } = fmRig()
	await assert.rejects(fm.delete('c.mkv', 'nope'), /needs confirming/)
	const { token } = await fm.requestDelete('c.mkv')
	await assert.rejects(fm.delete('a.mp4', token), /needs confirming/, 'token for another file')
	await fm.delete('c.mkv', token)
	assert.ok(!existsSync(join(dir, 'c.mkv')))
	await assert.rejects(fm.delete('c.mkv', token), /needs confirming/)
	const t2 = await fm.requestDelete('b.wav')
	tick(61000)
	await assert.rejects(fm.delete('b.wav', t2.token), /needs confirming|ran out/)
	const t3 = await fm.requestDelete('b.wav')
	appendFileSync(join(dir, 'b.wav'), 'changed')
	await assert.rejects(fm.delete('b.wav', t3.token), /changed since/)
	assert.ok(existsSync(join(dir, 'b.wav')))
})

function serveRig(fm: FileManager) {
	return new Promise<{ server: Server; port: number }>((resolve) => {
		const server = createServer((req, res) => {
			const u = new URL(req.url!, 'http://x')
			void fm.serve(req, res, u.searchParams.get('f') ?? '', { download: u.searchParams.has('dl') })
		}).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port }))
	})
}
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET') {
	return new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
		const r = request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
		})
		r.on('error', reject)
		r.end()
	})
}

test('file manager: HTTP serving with Range, suffix ranges, 416, HEAD, download, traversal 403', async () => {
	const { fm, dir } = fmRig()
	writeFileSync(join(dir, 'r.mp4'), Buffer.from('0123456789'))
	const { server, port } = await serveRig(fm)
	try {
		const full = await get(port, '/?f=r.mp4')
		assert.equal(full.status, 200)
		assert.equal(full.body.toString(), '0123456789')
		assert.equal(full.headers['accept-ranges'], 'bytes')
		assert.match(String(full.headers['content-disposition']), /^inline/)
		const part = await get(port, '/?f=r.mp4', { Range: 'bytes=2-5' })
		assert.equal(part.status, 206)
		assert.equal(part.body.toString(), '2345')
		assert.equal(part.headers['content-range'], 'bytes 2-5/10')
		assert.equal((await get(port, '/?f=r.mp4', { Range: 'bytes=7-' })).body.toString(), '789')
		assert.equal((await get(port, '/?f=r.mp4', { Range: 'bytes=-3' })).body.toString(), '789')
		assert.equal((await get(port, '/?f=r.mp4', { Range: 'bytes=4-100' })).headers['content-range'], 'bytes 4-9/10')
		const bad = await get(port, '/?f=r.mp4', { Range: 'bytes=20-30' })
		assert.equal(bad.status, 416)
		assert.equal(bad.headers['content-range'], 'bytes */10')
		// If-Range with a stale validator → whole file
		assert.equal((await get(port, '/?f=r.mp4', { Range: 'bytes=0-1', 'If-Range': 'W/"old"' })).status, 200)
		const head = await get(port, '/?f=r.mp4', {}, 'HEAD')
		assert.equal(head.status, 200)
		assert.equal(head.headers['content-length'], '10')
		assert.equal(head.body.length, 0)
		assert.match(String((await get(port, '/?f=r.mp4&dl')).headers['content-disposition']), /^attachment; filename="r.mp4"/)
		assert.equal((await get(port, '/?f=' + encodeURIComponent('../secret.mp4'))).status, 403)
		assert.equal((await get(port, '/?f=link.mp4')).status, 403)
		assert.equal((await get(port, '/?f=missing.mp4')).status, 404)
		assert.equal((await get(port, '/?f=r.mp4', {}, 'DELETE')).status, 405)
		const etag = String(full.headers.etag)
		assert.equal((await get(port, '/?f=r.mp4', { 'If-None-Match': etag })).status, 304)
	} finally {
		server.closeAllConnections()
		server.close()
	}
})

// ---------------- upload ----------------

function fakeTransport() {
	const calls: { name: string; folder: string; dest: string }[] = []
	let failNext: UploadError[] = []
	let gate: Promise<void> | null = null
	const t: Transport = {
		async upload(job, dest, ctx) {
			calls.push({ name: job.remoteName, folder: job.remoteFolder, dest: dest.id })
			ctx.progress(Math.floor(job.size / 2))
			if (gate) await gate
			const f = failNext.shift()
			if (f) throw f
			ctx.progress(job.size)
			return { remote: `${dest.id}:${job.remoteFolder}/${job.remoteName}` }
		},
	}
	const set: TransportSet = { rclone: t, share: t, http: t, webdav: t }
	return {
		set,
		calls,
		fail: (...e: UploadError[]) => (failNext = e),
		hold: () => {
			let release!: () => void
			gate = new Promise((r) => (release = r))
			return () => {
				gate = null
				release()
			}
		},
	}
}

const dest = (id: string, kind: Destination['kind'] = 'rclone', extra: object = {}): Destination => ({ id, name: id.toUpperCase(), enabled: true, kind, remote: 'gdrive:Shows', ...extra }) as any

function queueRig(over: Partial<UploadSettings> = {}) {
	let now = new Date(2026, 10, 4, 12, 0).getTime()
	const timers: { fn: () => void; ms: number }[] = []
	const fk = fakeTransport()
	let settings: UploadSettings = { ...S().upload, enabled: true, destinations: [dest('d1')], retryBaseMs: 1000, retryMaxMs: 8000, ...over }
	const q = new UploadQueue({
		settings: () => settings,
		transports: fk.set,
		now: () => now,
		setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
		clearTimer: () => {},
		progressEveryMs: 0,
	})
	const dir = tmp('up-')
	const file = (n: string, body = 'x'.repeat(100)) => {
		const p = join(dir, n)
		writeFileSync(p, body)
		return p
	}
	return { q, fk, file, dir, advance: (ms: number) => (now += ms), setNow: (t: number) => (now = t), set: (s: Partial<UploadSettings>) => (settings = { ...settings, ...s }), timers }
}
const settle = () => sleep(15)

test('upload queue: after stop, progress, done, one item per destination, local copy kept', async () => {
	const { q, fk, file, dir } = queueRig({ destinations: [dest('d1'), dest('d2'), { ...dest('off'), enabled: false }] })
	const seen: string[] = []
	q.on('item', (i) => seen.push(`${i.destId}:${i.status}:${i.percent}`))
	q.start()
	const p = file('a.mp4')
	const items = q.add(p, { remoteFolder: 'Shows/2026-11-04' })
	assert.equal(items.length, 2)
	await settle()
	await q.idle()
	assert.deepEqual(q.list().map((i) => i.status), ['done', 'done'])
	assert.ok(seen.includes('d1:uploading:50'))
	assert.equal(fk.calls[0].folder, 'Shows/2026-11-04')
	assert.ok(existsSync(p))
	assert.equal(q.summary().done, 2)
	// adding the same file again while pending isn't duplicated
	const r = fk.hold()
	const before = q.list().length
	q.add(file('b.mp4'), { remoteFolder: '' })
	const dup = q.add(join(dir, 'b.mp4'), { remoteFolder: '' })
	assert.equal(q.list().length - before, 2, 'one per enabled destination, not doubled')
	assert.equal(dup.length, 2)
	r()
	await settle()
	await q.idle()
	assert.equal(q.clearFinished(), 4)
})

test('upload queue: retries network failures with backoff, gives up on setting problems, max attempts', async () => {
	const { q, fk, file, advance, timers, set } = queueRig()
	q.start()
	fk.fail(new UploadError('network dropped', true), new UploadError('network dropped', true))
	q.add(file('a.mp4'), { remoteFolder: '' })
	await settle()
	let it = q.list()[0]
	assert.equal(it.status, 'retrying')
	assert.equal(it.error, 'network dropped')
	const first = it.nextTry!
	advance(1000)
	q.tick()
	await settle()
	it = q.list()[0]
	assert.equal(it.status, 'retrying')
	assert.equal(it.nextTry! - first, 2000, 'wait doubles')
	advance(2000)
	q.tick()
	await settle()
	assert.equal(q.list()[0].status, 'done')
	assert.equal(q.list()[0].attempts, 3)
	assert.ok(timers.length > 0, 'a wake-up timer was set for the retry')
	// not retryable → failed straight away
	fk.fail(new UploadError('login refused', false))
	q.add(file('b.mp4'), { remoteFolder: '' })
	await settle()
	const b = q.list().find((i) => i.localPath.endsWith('b.mp4'))!
	assert.equal(b.status, 'failed')
	assert.equal(b.error, 'login refused')
	// retry() gives it another go
	assert.ok(q.retry(b.id))
	await settle()
	assert.equal(q.get(b.id)!.status, 'done')
	// max attempts
	set({ maxAttempts: 2 })
	fk.fail(new UploadError('net', true), new UploadError('net', true))
	q.add(file('c.mp4'), { remoteFolder: '' })
	await settle()
	advance(1000)
	q.tick()
	await settle()
	assert.equal(q.list().find((i) => i.localPath.endsWith('c.mp4'))!.status, 'failed')
	// missing local file → failed with plain words
	q.add(join(tmp(), 'gone.mp4'), { remoteFolder: '' })
	await settle()
	assert.match(q.list().at(-1)!.error!, /isn't there any more/)
})

test('upload queue: backoff doubles and caps', async () => {
	const { q, fk, file, advance } = queueRig({ retryBaseMs: 1000, retryMaxMs: 3000 })
	q.start()
	fk.fail(...Array.from({ length: 5 }, () => new UploadError('net', true)))
	q.add(file('a.mp4'), { remoteFolder: '' })
	const waits: number[] = []
	let last = 0
	for (let n = 0; n < 4; n++) {
		await settle()
		const it = q.list()[0]
		const base = new Date(2026, 10, 4, 12, 0).getTime() + last
		waits.push(it.nextTry! - base)
		advance(waits.at(-1)!)
		last += waits.at(-1)!
		q.tick()
	}
	assert.deepEqual(waits, [1000, 2000, 3000, 3000])
})

test('upload queue: on-demand holds until uploadNow; scheduled runs once a day at the set time; state save/restore', async () => {
	const { q, fk, file, set, setNow } = queueRig({ when: 'manual' })
	q.start()
	q.add(file('a.mp4'), { remoteFolder: '' })
	await settle()
	assert.equal(q.list()[0].status, 'held')
	assert.equal(fk.calls.length, 0)
	// force (an "upload this" button) ignores the when setting
	q.add(file('f.mp4'), { remoteFolder: '' })
	q.add(file('g.mp4'), { remoteFolder: '', force: true })
	await settle()
	assert.equal(fk.calls.length, 1)
	assert.equal(q.uploadNow(), 2)
	await settle()
	await q.idle()
	assert.equal(q.summary().done, 3)

	set({ when: 'scheduled', at: '23:00' })
	setNow(new Date(2026, 10, 4, 22, 0).getTime())
	q.add(file('b.mp4'), { remoteFolder: '' })
	q.tick()
	await settle()
	assert.equal(q.list().at(-1)!.status, 'held')
	setNow(new Date(2026, 10, 4, 23, 0, 5).getTime())
	q.tick()
	await settle()
	assert.equal(q.list().at(-1)!.status, 'done')
	// later the same day: held again until tomorrow
	q.add(file('c.mp4'), { remoteFolder: '' })
	setNow(new Date(2026, 10, 4, 23, 30).getTime())
	q.tick()
	await settle()
	assert.equal(q.list().at(-1)!.status, 'held')
	// save + restore into a new queue: the held item survives, lastScheduled too
	const saved = JSON.parse(JSON.stringify(q.state))
	const { q: q2, fk: fk2, setNow: setNow2, set: set2 } = queueRig({ when: 'scheduled', at: '23:00' })
	set2({})
	setNow2(new Date(2026, 10, 4, 23, 45).getTime())
	q2.restore(saved)
	q2.start()
	q2.tick()
	await settle()
	assert.equal(q2.list().at(-1)!.status, 'held', 'already ran today')
	setNow2(new Date(2026, 10, 5, 23, 1).getTime())
	q2.tick()
	await settle()
	assert.equal(q2.list().at(-1)!.status, 'done')
	assert.equal(fk2.calls.length, 1)
	assert.equal(nextAt('23:00', new Date(2026, 10, 4, 23, 30).getTime()), new Date(2026, 10, 5, 23, 0).getTime())
	assert.equal(nextAt('nope', 0), null)
})

test('upload queue: restoring a mid-upload item puts it back in the queue; remove aborts', async () => {
	const { q, fk, file } = queueRig()
	const release = fk.hold()
	q.start()
	q.add(file('a.mp4'), { remoteFolder: '' })
	await settle()
	assert.equal(q.list()[0].status, 'uploading')
	const saved = q.state
	const { q: q2 } = queueRig()
	q2.restore(saved)
	assert.equal(q2.list()[0].status, 'queued')
	assert.ok(q.remove(q.list()[0].id))
	release()
	await settle()
	assert.equal(q.list().length, 0)
})

test('upload folder layouts: pattern from sheet columns + date, fixed, dated', () => {
	const naming = S().naming
	const ctx = { row: { Event: 'Expo / Hall 3', Day: 'Tue' }, now: fixed }
	assert.equal(remoteFolder({ ...S().upload, layout: 'pattern', folderPattern: '{Event}/{date}/{Nope}' }, ctx, naming), 'Expo _ Hall 3/2026-11-04')
	assert.equal(remoteFolder({ ...S().upload, layout: 'fixed', folder: '/Shows//Main/../x' }, ctx, naming), 'Shows/Main/x')
	assert.equal(remoteFolder({ ...S().upload, layout: 'dated', folder: 'Shows', datedFormat: 'YYYY/MM-DD' }, ctx, naming), 'Shows/2026/11-04')
	assert.equal(remoteFolder({ ...S().upload, layout: 'fixed', folder: '' }, ctx, naming), '')
})

const ctxFor = (s: Partial<UploadSettings> = {}) => ({ signal: new AbortController().signal, progress: () => {}, settings: { ...S().upload, ...s } })

test('network share: copies into dated folders, keeps the local file, plain-words error when unreachable', async () => {
	const src = join(tmp(), 'a.mp4')
	writeFileSync(src, 'video-bytes')
	const share = tmp('nas-')
	let last = 0
	const r = await shareTransport.upload({ localPath: src, remoteFolder: 'Shows/2026-11-04', remoteName: 'Talk.mp4', size: 11 }, dest('n', 'share', { path: share }), { ...ctxFor(), progress: (b) => (last = b) })
	assert.equal(readFileSync(join(share, 'Shows', '2026-11-04', 'Talk.mp4'), 'utf8'), 'video-bytes')
	assert.equal(r.remote, join(share, 'Shows', '2026-11-04', 'Talk.mp4'))
	assert.equal(last, 11)
	assert.ok(existsSync(src))
	assert.deepEqual(readdirSync(join(share, 'Shows', '2026-11-04')), ['Talk.mp4'], 'no partial files left')
	await assert.rejects(shareTransport.upload({ localPath: src, remoteFolder: '', remoteName: 'x', size: 1 }, dest('n', 'share', { path: '/nonexistent/share' }), ctxFor()), (e: any) => e instanceof UploadError && e.retryable && /mounted/.test(e.message))
})

function uploadServer(handler?: (req: IncomingMessage, body: Buffer) => number) {
	const got: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[] = []
	return new Promise<{ server: Server; port: number; got: typeof got }>((resolve) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on('data', (c) => chunks.push(c))
			req.on('end', () => {
				const body = Buffer.concat(chunks)
				got.push({ method: req.method!, url: req.url!, headers: req.headers, body })
				res.statusCode = handler ? handler(req, body) : 201
				res.end()
			})
		}).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port, got }))
	})
}

test('HTTP PUT, POST (multipart and raw) and WebDAV against a local server', async () => {
	const src = join(tmp(), 'a.mp4')
	writeFileSync(src, 'hello video')
	const { server, port, got } = await uploadServer((req) => (req.headers.authorization === 'Basic ' + Buffer.from('nige:pw').toString('base64') ? (req.method === 'MKCOL' && req.url === '/dav/Shows' ? 405 : 201) : 401))
	try {
		const job = { localPath: src, remoteFolder: 'Shows/Day 1', remoteName: 'My talk.mp4', size: 11 }
		const base = { user: 'nige', password: 'pw', headers: {}, fieldName: 'file', postFormat: 'multipart' as const }
		const put = await httpTransport.upload(job, dest('h', 'http', { ...base, url: `http://127.0.0.1:${port}/up`, method: 'PUT' }), ctxFor())
		assert.equal(got[0].method, 'PUT')
		assert.equal(got[0].url, '/up/Shows/Day%201/My%20talk.mp4')
		assert.equal(got[0].body.toString(), 'hello video')
		assert.equal(put.remote, `http://127.0.0.1:${port}/up/Shows/Day%201/My%20talk.mp4`)
		await httpTransport.upload(job, dest('h', 'http', { ...base, url: `http://127.0.0.1:${port}/files?name={name}`, method: 'PUT' }), ctxFor())
		assert.equal(got[1].url, '/files?name=My%20talk.mp4')
		await httpTransport.upload(job, dest('h', 'http', { ...base, url: `http://127.0.0.1:${port}/post`, method: 'POST' }), ctxFor())
		assert.match(String(got[2].headers['content-type']), /^multipart\/form-data; boundary=/)
		const mp = got[2].body.toString()
		assert.match(mp, /name="folder"\r\n\r\nShows\/Day 1\r\n/)
		assert.match(mp, /name="file"; filename="My talk.mp4"/)
		assert.match(mp, /\r\n\r\nhello video\r\n--/)
		assert.equal(Number(got[2].headers['content-length']), got[2].body.length)
		await httpTransport.upload(job, dest('h', 'http', { ...base, postFormat: 'raw', url: `http://127.0.0.1:${port}/raw`, method: 'POST' }), ctxFor())
		assert.equal(got[3].body.toString(), 'hello video')
		assert.equal(got[3].headers['x-file-name'], 'My%20talk.mp4')
		// WebDAV: MKCOL each level (405 = already there is fine), then PUT
		await webdavTransport.upload(job, dest('w', 'webdav', { url: `http://127.0.0.1:${port}/dav/`, user: 'nige', password: 'pw', createFolders: true, headers: {} }), ctxFor())
		assert.deepEqual(got.slice(4).map((g) => `${g.method} ${g.url}`), ['MKCOL /dav/Shows', 'MKCOL /dav/Shows/Day%201', 'PUT /dav/Shows/Day%201/My%20talk.mp4'])
		// wrong password → not retryable, plain words
		await assert.rejects(httpTransport.upload(job, dest('h', 'http', { ...base, password: 'bad', url: `http://127.0.0.1:${port}/up`, method: 'PUT' }), ctxFor()), (e: any) => e instanceof UploadError && !e.retryable && /refused the login/.test(e.message))
	} finally {
		server.closeAllConnections()
		server.close()
	}
	// server gone → retryable
	await assert.rejects(httpTransport.upload({ localPath: src, remoteFolder: '', remoteName: 'a', size: 11 }, dest('h', 'http', { url: `http://127.0.0.1:${port}/up`, method: 'PUT', user: '', password: '', headers: {}, fieldName: 'file', postFormat: 'raw' }), ctxFor()), (e: any) => e instanceof UploadError && e.retryable && /isn't accepting connections/.test(e.message))
	// server 503 → retryable
	const s2 = await uploadServer(() => 503)
	try {
		await assert.rejects(httpTransport.upload({ localPath: src, remoteFolder: '', remoteName: 'a', size: 11 }, dest('h', 'http', { url: `http://127.0.0.1:${s2.port}/`, method: 'PUT', user: '', password: '', headers: {}, fieldName: 'file', postFormat: 'raw' }), ctxFor()), (e: any) => e.retryable)
	} finally {
		s2.server.closeAllConnections()
		s2.server.close()
	}
})

/** A pretend rclone process */
function fakeSpawner(script: (args: string[], p: { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; close: (code: number) => void }) => void) {
	const runs: string[][] = []
	const spawner = (_cmd: string, args: string[]) => {
		runs.push(args)
		const p: any = new EventEmitter()
		p.stdout = new PassThrough()
		p.stderr = new PassThrough()
		p.stdin = new PassThrough()
		p.kill = () => setImmediate(() => p.emit('close', null))
		setImmediate(() => script(args, { stdout: p.stdout, stderr: p.stderr, stdin: p.stdin, close: (c) => setImmediate(() => p.emit('close', c)) }))
		return p
	}
	return { spawner: spawner as any, runs }
}

test('rclone: missing program explained, remote targets, progress, plain-words failures', async () => {
	const missing = await checkRclone('/definitely/not/rclone-xyz')
	assert.equal(missing.ok, false)
	assert.match(missing.error!, /rclone isn't installed.*rclone\.org\/downloads.*rclone config/)
	assert.equal(rcloneTarget({ kind: 'rclone', remote: 'gdrive' }), 'gdrive:')
	assert.equal(rcloneTarget({ kind: 'rclone', remote: 'gdrive:Shows' }), 'gdrive:Shows/')
	assert.equal(rcloneTarget({ kind: 'sftp', host: 'nas.local', port: 2222, user: 'nige', password: 'x', tls: false, basePath: '/media/' }, 'OBSC'), ':sftp,host=nas.local,port=2222,user=nige,pass=OBSC:media/')
	assert.equal(rcloneTarget({ kind: 'ftp', host: 'h', port: 0, user: "o'neil", password: '', tls: true, basePath: '' }), ":ftp,host=h,user='o''neil',explicit_tls=true:")

	let outcome = 'ok'
	const { spawner, runs } = fakeSpawner((args, p) => {
		if (args[0] === 'version') {
			p.stdout.end('rclone v1.68.2\n- os/version: x')
			return p.close(0)
		}
		if (args[0] === 'obscure') {
			p.stdout.end('OBSCURED\n')
			return p.close(0)
		}
		if (outcome === 'ok') {
			p.stderr.write('Transferred:   5 B / 11 B, 45%, 1 B/s, ETA 1s\n')
			p.stderr.end()
			return p.close(0)
		}
		if (outcome === 'net') {
			p.stderr.end('2026/11/04 12:00:00 ERROR : Failed to copy: dial tcp: lookup www.googleapis.com: no such host\n')
			return p.close(1)
		}
		p.stderr.end("2026/11/04 12:00:00 CRITICAL: Failed to create file system for \"nope:\": didn't find section in config file\n")
		p.close(1)
	})
	const t = rcloneTransport(spawner)
	const src = join(tmp(), 'a.mp4')
	writeFileSync(src, 'hello video')
	const progress: number[] = []
	const r = await t.upload({ localPath: src, remoteFolder: 'Shows/Day 1', remoteName: 'Talk.mp4', size: 11 }, dest('g', 'rclone', { remote: 'gdrive:Rec' }), { ...ctxFor(), progress: (b) => progress.push(b) })
	assert.equal(r.remote, 'gdrive:Rec/Shows/Day 1/Talk.mp4')
	const copy = runs.find((a) => a[0] === 'copyto')!
	assert.deepEqual(copy.slice(0, 3), ['copyto', src, 'gdrive:Rec/Shows/Day 1/Talk.mp4'])
	assert.ok(progress.includes(5) && progress.at(-1) === 11)
	// SFTP with a password: obscured first, never shown in the result
	const s = await t.upload({ localPath: src, remoteFolder: '', remoteName: 'T.mp4', size: 11 }, dest('s', 'sftp', { host: 'nas', port: 0, user: 'u', password: 'secret', tls: false, basePath: 'rec' }), ctxFor())
	assert.equal(s.remote, ':sftp,host=nas,user=u,pass=***:rec/T.mp4')
	assert.ok(runs.some((a) => a[2]?.includes('pass=OBSCURED')))
	outcome = 'net'
	await assert.rejects(t.upload({ localPath: src, remoteFolder: '', remoteName: 'T.mp4', size: 11 }, dest('g'), ctxFor()), (e: any) => e.retryable && /network looks down/.test(e.message))
	outcome = 'cfg'
	await assert.rejects(t.upload({ localPath: src, remoteFolder: '', remoteName: 'T.mp4', size: 11 }, dest('g'), ctxFor()), (e: any) => !e.retryable && /isn't set up on this computer/.test(e.message))
	// via the real spawner, a missing rclone fails the item with how-to-get-it words
	const real = rcloneTransport()
	await assert.rejects(real.upload({ localPath: src, remoteFolder: '', remoteName: 'T.mp4', size: 11 }, dest('g'), ctxFor({ rclonePath: '/no/such/rclone' })), (e: any) => !e.retryable && /rclone\.org\/downloads/.test(e.message))
})

// ---------------- all together ----------------

test('Recordings: sheet → name at start → row changes → rename after stop → auto-advance → upload queued', async () => {
	const dir = tmp('all-')
	const fk = fakeTransport()
	const { f } = mockFetch(() => ({ body: 'Code,Session,Speaker\nK1,Keynote,Ana\nP1,Panel,Bob' }))
	const rec = new Recordings({
		folder: () => dir,
		fetch: f,
		transports: fk.set,
		context: () => ({ source: 'OBS Main', now: fixed }),
		settings: {
			sheet: { kind: 'google', googleUrl: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', pollSeconds: 0 },
			naming: { parts: ['Session', 'Speaker', 'source'] },
			rows: { autoAdvance: true, keyColumn: 'Code' },
			rename: { stablePollMs: 5, stableChecks: 1 },
			upload: { enabled: true, destinations: [dest('d1')], layout: 'pattern', folderPattern: '{date}/{Session}' },
		},
	})
	const persisted: number[] = []
	rec.on('persist', () => persisted.push(1))
	rec.start()
	await rec.sheet.refresh()
	assert.equal(rec.rows.state.row.Code, 'K1')
	const name = await rec.beforeStart()
	assert.equal(name, 'Keynote - Ana - OBS Main')
	writeFileSync(join(dir, name + '.mkv'), 'x')
	rec.rows.next()
	const out = await rec.afterStop(join(dir, name + '.mkv'))
	assert.equal(out.stop!.name, 'Panel - Bob - OBS Main.mkv')
	assert.equal(out.uploads.length, 1)
	assert.equal(out.uploads[0].remoteFolder, '2026-11-04/Panel', 'folder from the row live at stop')
	assert.equal(rec.rows.state.index, 1, 'no row after P1: stayed (no wrap)')
	await settle()
	await rec.uploads.idle()
	assert.equal(rec.uploads.list()[0].status, 'done')
	assert.equal((await rec.files.list())[0].name, 'Panel - Bob - OBS Main.mkv')
	const saved = JSON.parse(JSON.stringify(rec.saved()))
	assert.equal(saved.table.rows.length, 2)
	assert.ok(persisted.length > 0)
	rec.stop()
	// restart offline: the saved copy still names files
	const { f: down } = mockFetch(() => new Error('offline'))
	const rec2 = new Recordings({ folder: () => dir, fetch: down, transports: fk.set, settings: { sheet: { kind: 'google', googleUrl: 'x', pollSeconds: 0 }, naming: { parts: ['Session'] } } })
	rec2.start(saved)
	await rec2.sheet.refresh()
	assert.equal(rec2.rows.state.row.Code, 'P1')
	assert.ok(rec2.sheet.status.error)
	assert.equal(await rec2.beforeStart(), 'Panel')
	rec2.stop()
})

