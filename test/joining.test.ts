/** Page joining (beacon, peers, CORS, PIN header), look settings, and recordings wired to the engine. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type EngineHost } from '../src/engine.js'
import { WebServer } from '../src/web.js'
import { Beacon, parseBeacon, peerUrl, type BeaconMessage } from '../src/discovery.js'
import { loadStore, newStore, applyImport } from '../src/settings.js'
import type { Transport, TransportSet } from '../src/recordings/upload/transports.js'
import { FAKE_INFO, FakeDevice } from './fake-device.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 3000) => {
	for (let t = 0; t < ms && !f(); t += 25) await sleep(25)
	return f()
}

function rig(opts: { store?: unknown; recordings?: ConstructorParameters<typeof Engine>[2]['recordings'] } = {}) {
	const dev = new FakeDevice()
	const logs: string[] = []
	let saved = ''
	const host: EngineHost = { log: (l, m) => logs.push(`${l}: ${m}`), save: (s) => (saved = s), structureChanged: () => {}, stateChanged: () => {} }
	const engine = new Engine(
		host,
		FAKE_INFO,
		{ appId: 'fake-audio', appName: 'Fake Audio', moduleVersion: '0.0.1', sourceName: 'Rig A', updates: { moduleRepo: 'x/y', deviceRepo: '', moduleDownload: '', deviceDownload: '', userAgent: 't' }, recordings: opts.recordings },
		opts.store,
		'',
	)
	return { dev, engine, logs, saved: () => saved }
}

test('beacon: parse rejects junk, peer address follows the sender or the bind address', () => {
	assert.equal(parseBeacon(Buffer.from('hello')), null)
	assert.equal(parseBeacon(Buffer.from(JSON.stringify({ rebel: 2, id: 'a', port: 1 }))), null)
	assert.equal(parseBeacon(Buffer.from(JSON.stringify({ rebel: 1, id: 'a', port: 70000 }))), null)
	const m = parseBeacon(Buffer.from(JSON.stringify({ rebel: 1, id: 'a', app: 'atem-audio', appName: 'ATEM Audio', name: 'ATEM 1', port: 8891, pin: true, version: '0.1.0', device: 'the ATEM' })))!
	assert.equal(m.name, 'ATEM 1')
	assert.equal(peerUrl(m, '192.168.1.30', new Set(['127.0.0.1'])), 'http://192.168.1.30:8891')
	assert.equal(peerUrl({ ...m, bind: '10.0.0.5' }, '192.168.1.30', new Set()), 'http://10.0.0.5:8891')
	assert.equal(peerUrl({ ...m, bind: '127.0.0.1' }, '192.168.1.30', new Set(['127.0.0.1'])), null, 'a this-computer-only page from elsewhere is unreachable')
	assert.equal(peerUrl({ ...m, bind: '127.0.0.1' }, '127.0.0.1', new Set(['127.0.0.1'])), 'http://127.0.0.1:8891')
})

test('beacon: two finders on one port hear each other (loopback), not themselves; quiet ones drop off', async (t) => {
	const port = 40000 + Math.floor(Math.random() * 20000)
	const msg = (id: string, name: string): BeaconMessage => ({ rebel: 1, id, app: 'fake-audio', appName: 'Fake Audio', name, port: 9000, pin: false, version: '1', device: 'x' })
	let now = Date.now()
	const a = new Beacon({ port, message: () => msg('A', 'Rig A'), everyMs: 100, now: () => now })
	const b = new Beacon({ port, message: () => msg('B', 'Rig B'), everyMs: 100, now: () => now })
	t.after(() => (a.stop(), b.stop()))
	a.start()
	b.start()
	assert.ok(await until(() => a.peers().length > 0 && b.peers().length > 0), 'heard each other')
	assert.deepEqual(a.peers().map((p) => p.name), ['Rig B'])
	assert.deepEqual(b.peers().map((p) => p.name), ['Rig A'])
	assert.match(a.peers()[0].url, /^http:\/\/[\d.]+:9000$/)
	b.stop()
	now += 60000
	assert.equal(a.peers().length, 0, 'gone quiet: dropped')
})

test('joining API: two pages find each other, CORS on everything, PIN by header or query, commands act on their own source', async (t) => {
	const beaconPort = 40000 + Math.floor(Math.random() * 20000)
	const A = rig()
	const B = rig()
	B.engine.sourceName = 'Rig B'
	t.after(() => (A.engine.destroy(), B.engine.destroy()))
	A.dev.add('mic', -24)
	B.dev.add('desk', -18)
	A.engine.useDevice(A.dev)
	B.engine.useDevice(B.dev)
	const wa = new WebServer(A.engine, { port: 0, bind: '127.0.0.1', pin: '', beacon: { port: beaconPort, everyMs: 100 }, name: () => 'Rig A' }, () => {})
	const wb = new WebServer(B.engine, { port: 0, bind: '127.0.0.1', pin: '4321', beacon: { port: beaconPort, everyMs: 100 } }, () => {})
	t.after(() => (wa.stop(), wb.stop()))
	wa.start()
	wb.start()
	await until(() => wa.port > 0 && wb.port > 0)
	const A0 = `http://127.0.0.1:${wa.port}`
	const B0 = `http://127.0.0.1:${wb.port}`

	// who's who, without a PIN
	const info = (await (await fetch(B0 + '/api/info')).json()) as BeaconMessage
	assert.equal(info.name, 'Rig B')
	assert.equal(info.pin, true)
	assert.equal(info.port, wb.port)
	assert.equal(info.bind, '127.0.0.1')

	// A hears B (and the other way round)
	let peers: { peers: { name: string; url: string; pin: boolean }[]; self: BeaconMessage; finder: boolean } = { peers: [], self: info, finder: true }
	assert.ok(
		await until(() => {
			void fetch(A0 + '/api/peers')
				.then((r) => r.json())
				.then((j) => (peers = j as typeof peers))
			return peers.peers.some((p) => p.name === 'Rig B')
		}),
		'B found from A',
	)
	const pb = peers.peers.find((p) => p.name === 'Rig B')!
	assert.equal(pb.url, B0)
	assert.equal(pb.pin, true)
	assert.equal(peers.self.name, 'Rig A')
	assert.equal(peers.finder, true)

	// CORS: preflight and plain answers, including private network access
	const pre = await fetch(B0 + '/cmd', { method: 'OPTIONS', headers: { Origin: A0, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-rebel-pin', 'Access-Control-Request-Private-Network': 'true' } })
	assert.equal(pre.status, 204)
	assert.equal(pre.headers.get('access-control-allow-origin'), '*')
	assert.match(pre.headers.get('access-control-allow-headers')!, /X-Rebel-Pin/)
	assert.equal(pre.headers.get('access-control-allow-private-network'), 'true')

	// PIN: refused without, by header and by query it's fine
	const no = await fetch(B0 + '/events')
	assert.equal(no.status, 401)
	assert.equal(no.headers.get('access-control-allow-origin'), '*', '401 still carries CORS so the page can ask for the PIN')
	const wrong = await fetch(B0 + '/api/peers', { headers: { 'X-Rebel-Pin': '1111' } })
	assert.equal(wrong.status, 401)
	const ok = await fetch(B0 + '/api/peers', { headers: { 'X-Rebel-Pin': '4321' } })
	assert.equal(ok.status, 200)
	const ac = new AbortController()
	const sse = await fetch(B0 + '/events?pin=4321', { signal: ac.signal, headers: { Origin: A0 } })
	assert.equal(sse.status, 200)
	assert.equal(sse.headers.get('access-control-allow-origin'), '*')
	ac.abort()

	// a command sent to B's server acts on B's desk only
	await until(() => B.engine.visible().length === 1 && A.engine.visible().length === 1)
	const r = await fetch(B0 + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rebel-Pin': '4321', Origin: A0 }, body: JSON.stringify({ cmd: 'mute', input: 'desk', value: true }) })
	assert.equal(((await r.json()) as { ok: boolean }).ok, true)
	await sleep(30)
	assert.equal(B.dev.get('desk').muted, true)
	assert.equal(A.dev.get('mic').muted, false)

	// finder off: still answers, lists nobody
	const wc = new WebServer(A.engine, { port: 0, bind: '127.0.0.1', pin: '' }, () => {})
	t.after(() => wc.stop())
	wc.start()
	await until(() => wc.port > 0)
	const off = (await (await fetch(`http://127.0.0.1:${wc.port}/api/peers`)).json()) as { finder: boolean; peers: unknown[] }
	assert.equal(off.finder, false)
	assert.deepEqual(off.peers, [])
})

test('look settings: new page settings have defaults, are checked, and survive a reload', () => {
	const { engine } = rig()
	assert.equal(engine.store.page.faderScaleSide, 'left')
	assert.equal(engine.store.page.meterScaleSide, 'right')
	assert.equal(engine.store.page.meterPaleBack, true)
	engine.setPage('faderScaleSide', 'right')
	engine.setPage('meterScaleSide', 'sideways')
	engine.setPage('capColour', '#ff8800')
	engine.setPage('capColour', 'purple-ish')
	engine.setPage('meterPaleStrength', 3)
	engine.setPage('meterPaleBack', 'false')
	assert.equal(engine.store.page.faderScaleSide, 'right')
	assert.equal(engine.store.page.meterScaleSide, 'right', 'impossible value skipped')
	assert.equal(engine.store.page.capColour, '#ff8800')
	assert.equal(engine.store.page.meterPaleStrength, 0.22, 'out of range skipped')
	assert.equal(engine.store.page.meterPaleBack, false)
	const back = loadStore(JSON.stringify(engine.store))
	assert.equal(back.page.capColour, '#ff8800')
	const old = loadStore({ version: 2, page: { layout: 'rows' } })
	assert.equal(old.page.capColour, '#7a2fe0', 'older stores pick up the defaults')
	engine.destroy()
})

test('recordings store: kept, exported without passwords or queue, import keeps the saved password', () => {
	const s = newStore()
	s.recordings = { enabled: true, folderOverride: '/mnt/rec', restoreName: true, settings: { upload: { destinations: [{ id: 'f', kind: 'ftp', name: 'FTP', enabled: true, host: 'h', password: 'pw' }] } }, saved: { upload: { version: 1, items: [], lastScheduled: null } } }
	const back = loadStore(JSON.stringify(s))
	assert.equal(back.recordings.enabled, true)
	assert.equal(back.recordings.folderOverride, '/mnt/rec')
	assert.ok(back.recordings.saved)
	const { engine } = rig({ store: s })
	const exported = JSON.parse(engine.exportJson()).store
	assert.equal(exported.recordings.saved, null)
	assert.equal(exported.recordings.settings.upload.destinations[0].password, '')
	// import into a store with that destination: the blank password keeps the old one
	const target = loadStore(JSON.stringify(s))
	applyImport(target, loadStore(exported), ['recordings'])
	assert.equal((target.recordings.settings.upload.destinations as { password: string }[])[0].password, 'pw')
	engine.destroy()
})

/** An upload transport that copies nothing and remembers what it was asked */
function fakeTransports(): { set: TransportSet; sent: string[] } {
	const sent: string[] = []
	const t: Transport = {
		async upload(job) {
			sent.push(`${job.remoteFolder}/${job.remoteName}`)
			return { remote: `fake:${job.remoteFolder}/${job.remoteName}` }
		},
	}
	return { set: { rclone: t, share: t, http: t, webdav: t }, sent }
}

test('recordings on the engine: start names the take from the row, stop renames and queues the upload, page API serves it', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'core-rec-'))
	const fk = fakeTransports()
	const { dev, engine } = rig({ recordings: { transports: fk.set } })
	t.after(() => engine.destroy())
	dev.add('mic', -24)
	dev.rec.name = 'Show %CCYY'
	// the fake writes its file into dir when it stops
	;(dev.recording as { stop: () => Promise<void> }).stop = async () => {
		writeFileSync(join(dir, `${dev.rec.name}.wav`), 'RIFF')
		dev.rec.active = false
		dev.host?.record({ active: false, paused: false, edge: true, lastFile: join(dir, `${dev.rec.name}.wav`) })
	}
	engine.useDevice(dev)
	await until(() => engine.connected)
	const r = engine.recordings
	r.setFolderOverride(dir)
	r.configure({
		naming: { parts: ['Session', 'source'] },
		rows: { keyColumn: 'Code' },
		rename: { stablePollMs: 5, stableChecks: 1 },
		upload: { enabled: true, when: 'afterStop', layout: 'pattern', folderPattern: '{Code}', destinations: [{ id: 'd1', kind: 'share', name: 'NAS', enabled: true, path: '/x' } as never] },
	})
	r.loadSheetFile(new TextEncoder().encode('Code,Session\nK1,Keynote\nP1,Panel\n'), 'sched.csv')
	r.setEnabled(true)
	assert.equal(r.rec.rows.state.row.Session, 'Keynote')

	// start from the engine (as a Companion button or the page would): the name goes to the device first
	await engine.recorder.start()
	assert.equal(dev.rec.active, true)
	await until(() => dev.rec.name === 'Show %CCYY')
	assert.ok(engine.recordings.rec.namer.take, 'take is being looked after')
	assert.equal(engine.recordings.rec.namer.take!.startName, 'Keynote - Rig A')
	assert.equal(dev.rec.name, 'Show %CCYY', "the device's own name setting is put back once the take has started")

	// move to the next session during the take, then stop: renamed after stop, upload queued with the row live at stop
	dev.rec.name = 'Keynote - Rig A' // what the device named the file (it took our name)
	r.rowNext()
	await engine.recorder.stop()
	assert.ok(await until(() => existsSync(join(dir, 'Panel - Rig A.wav'))), `renamed: ${readdirSync(dir)}`)
	assert.ok(await until(() => fk.sent.length === 1), 'uploaded')
	assert.deepEqual(fk.sent, ['P1/Panel - Rig A.wav'])
	const vars = r.variableValues()
	assert.equal(vars.rec_row, 2)
	assert.equal(vars.rec_col_session, 'Panel')
	assert.equal(vars.rec_col_code, 'P1')
	assert.equal(vars.rec_last_name, 'Panel - Rig A.wav')
	assert.equal(vars.rec_up_done, 1)
	assert.ok(r.variableDefinitions().some((d) => d.variableId === 'rec_col_session'))

	// a take started on the device itself still gets renamed after stop
	r.rowPrevious()
	dev.rec.name = 'Device own'
	await dev.recording.start() // not through the engine: no name set first
	await sleep(30)
	assert.match(r.rec.namer.take?.startName ?? '', /^Keynote - Rig A/, 'name worked out when the device started by itself')
	await engine.recorder.stop()
	assert.ok(await until(() => readdirSync(dir).some((n) => n.startsWith('Keynote - Rig A'))), `device-started take renamed: ${readdirSync(dir)}`)

	// the page API: state, files, file download with Range, rename and two-step delete
	const web = new WebServer(engine, { port: 0, bind: '127.0.0.1', pin: '9' }, () => {})
	t.after(() => web.stop())
	web.start()
	await until(() => web.port > 0)
	const B = `http://127.0.0.1:${web.port}`
	const H = { 'X-Rebel-Pin': '9', 'Content-Type': 'application/json' }
	const st = (await (await fetch(B + '/rec/state', { headers: H })).json()) as { enabled: boolean; table: { headers: string[] }; settings: { upload: { destinations: { password?: string }[] } } }
	assert.equal(st.enabled, true)
	assert.deepEqual(st.table.headers, ['Code', 'Session'])
	const files = (await (await fetch(B + '/rec/files', { headers: H })).json()) as { files: { name: string }[] }
	assert.ok(files.files.some((f) => f.name === 'Panel - Rig A.wav'))
	const part = await fetch(B + '/rec/file?pin=9&name=' + encodeURIComponent('Panel - Rig A.wav'), { headers: { Range: 'bytes=0-1' } })
	assert.equal(part.status, 206)
	assert.equal(await part.text(), 'RI')
	assert.equal((await fetch(B + '/rec/file?pin=9&name=..%2F..%2Fetc%2Fpasswd')).status, 403)
	const post = async (c: object) => (await (await fetch(B + '/cmd', { method: 'POST', headers: H, body: JSON.stringify(c) })).json()) as { ok: boolean; message?: string; error?: string }
	assert.equal((await post({ cmd: 'recRename', name: 'Panel - Rig A.wav', to: 'Panel final.mov' })).ok, true)
	assert.ok(existsSync(join(dir, 'Panel final.mov.wav')), 'keeps its real ending')
	assert.equal((await post({ cmd: 'recDelete', name: 'Panel final.mov.wav', token: 'nope' })).ok, false, 'no delete without asking first')
	const ask = await post({ cmd: 'recDeleteAsk', name: 'Panel final.mov.wav' })
	const { token } = JSON.parse(ask.message!)
	assert.equal((await post({ cmd: 'recDelete', name: 'Panel final.mov.wav', token })).ok, true)
	assert.ok(!existsSync(join(dir, 'Panel final.mov.wav')))
	assert.equal((await post({ cmd: 'recRow', op: 'set', value: 'P1', how: 'key' })).ok, true)
	assert.equal(r.rec.rows.state.row.Code, 'P1')
	assert.equal((await post({ cmd: 'recRow', op: 'next' })).ok, false, 'no row after the last')
	const pv = await post({ cmd: 'recPreview', naming: { parts: ['Code', 'text:X'], separator: '_' } })
	assert.equal(pv.message, 'P1_X')
	const sheet = await (await fetch(B + '/rec/sheet?name=new.csv', { method: 'POST', headers: { 'X-Rebel-Pin': '9' }, body: 'Code,Session\nZ9,Wrap\n' })).json()
	assert.equal((sheet as { ok: boolean }).ok, true)
	assert.equal(r.rec.rows.state.row.Code, 'Z9')

	// switched off: the device names its own files and nothing's renamed
	r.setEnabled(false)
	dev.rec.name = 'Plain'
	await engine.recorder.start()
	await engine.recorder.stop()
	await sleep(50)
	assert.ok(existsSync(join(dir, 'Plain.wav')))
})
