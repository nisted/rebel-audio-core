import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dbToPosition, positionToDb, type LawSettings } from '../src/law.js'
import { AutoLevel, type MeterSample } from '../src/autolevel.js'
import { INPUT_DEFAULTS, type InputRecord, type InputSettings, loadStore, newStore, applyImport, makeSchema, migrateStore, STORE_VERSION } from '../src/settings.js'
import { PickupManager } from '../src/pickup.js'
import { GestureReader, type Gesture } from '../src/gesture.js'
import { compareVersions, newVersionInfo, pickNewest, recompute } from '../src/updates.js'
import { parseColour, scaleColour } from '../src/colour.js'
import { Engine, type EngineHost, type UserChange } from '../src/engine.js'
import { WebServer, pageHtml } from '../src/web.js'
import { CLASSIC_CAPS, FAKE_INFO, FakeDevice } from './fake-device.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mul = (db: number) => Math.pow(10, db / 20)

test('fader law round trips and puts unity at three quarters', () => {
	const law: LawSettings = { kind: 'desk', topDb: 10, bottomDb: -60 }
	assert.equal(positionToDb(0, law), null)
	assert.equal(positionToDb(0.75, law), 0)
	assert.equal(positionToDb(1, law), 10)
	for (const db of [-90, -60, -33.3, -12, -6, -1, 0, 3, 10]) {
		const back = positionToDb(dbToPosition(db, law), law)!
		assert.ok(Math.abs(back - db) < 0.01, `${db} -> ${back}`)
	}
	const lin: LawSettings = { kind: 'linear', topDb: 10, bottomDb: -60 }
	assert.ok(Math.abs(positionToDb(0.5, lin)! - -25) < 1e-9)
})

/** Auto level wired to a pretend input, driven with synthetic meter readings */
function rig(over: Partial<InputSettings> = {}) {
	const set: InputSettings = { ...INPUT_DEFAULTS, autoLevelOn: true, measureWindowMs: 500, rideRateDbPerS: 4, captureMode: 'instant', ...over }
	const rec: InputRecord = { overrides: {}, sections: {}, target: null, refGain: null }
	const st = { fader: 0 as number | null, trim: 0, raw: -20 as number | null, muted: false, t: 1000, offCalled: false }
	const r = new AutoLevel({
		settings: () => set,
		record: () => rec,
		saveRecord: () => {},
		setGain: (db) => {
			if (set.controlMode === 'trim') st.trim = db
			else st.fader = db
		},
		gainRange: (mode) => (mode === 'trim' ? [-30, 30] : [-100, 26]),
		autoLevelOff: () => {
			st.offCalled = true
			set.autoLevelOn = false
		},
		log: () => {},
		changed: () => {},
	})
	const step = (ms: number) => {
		for (let i = 0; i < ms / 50; i++) {
			st.t += 50
			const x = st.raw === null ? 0 : mul(st.raw + st.trim)
			const sample: MeterSample = {
				t: st.t,
				mag: [x * (st.muted ? 0 : st.fader === null ? 0 : mul(st.fader)), x * (st.muted ? 0 : st.fader === null ? 0 : mul(st.fader))],
				prePeak: [x * 2, x * 2],
				faderDb: st.fader,
				trimDb: st.trim,
				muted: st.muted,
			}
			r.onMeter(sample)
		}
	}
	return { r, set, rec, st, step }
}

test('auto level captures a target and rides the fader back, within the limits', () => {
	const { r, set, rec, st, step } = rig()
	step(1000)
	r.captureTarget()
	assert.ok(Math.abs(rec.target! - -20) < 0.6, `target ${rec.target}`)
	assert.equal(rec.refGain, 0)
	st.raw = -28 // source drops 8 dB
	step(6000)
	assert.ok(Math.abs(st.fader! - 6) < 0.05, `fader stopped at max boost: ${st.fader}`)
	assert.equal(r.state, 'limit')
	set.maxBoostDb = 12
	step(6000)
	assert.ok(st.fader! > 7.4 && st.fader! < 8.6, `fader back near +8: ${st.fader}`)
	assert.equal(r.state, 'holding')
})

test('auto level stays put inside the band', () => {
	const { r, rec, st, step } = rig({ bandDb: 3 })
	step(1000)
	r.captureTarget()
	st.raw = -22
	step(4000)
	assert.equal(st.fader, 0)
	assert.equal(r.state, 'holding')
	assert.ok(rec.target !== null)
})

test('ride back "just inside the band" stops sooner than "to the target"', () => {
	const a = rig({ rideBack: 'band', bandDb: 3 })
	a.step(1000)
	a.r.captureTarget()
	a.st.raw = -28
	a.step(8000)
	assert.ok(a.st.fader! > 4.4 && a.st.fader! < 5.6, `band mode fader ${a.st.fader}`)
})

test('auto level freezes when quiet or muted, and drifts back if set to', () => {
	const { r, set, st, step } = rig()
	step(1000)
	r.captureTarget()
	st.raw = -28
	step(1000)
	const moved = st.fader!
	st.raw = null
	step(3000)
	assert.equal(r.state, 'frozen')
	assert.equal(st.fader, moved)
	st.raw = -28
	st.muted = true
	step(2000)
	assert.equal(r.state, 'frozen')
	assert.equal(st.fader, moved)
	st.muted = false
	set.quietMode = 'drift'
	set.quietDriftAfterMs = 1000
	set.driftRateDbPerS = 10
	st.raw = null
	step(3000)
	assert.ok(Math.abs(st.fader!) < 0.05, `drifted back to the set point: ${st.fader}`)
})

test('moving the fader by hand: new target, pause, or auto level off', () => {
	const a = rig()
	a.step(1000)
	a.r.captureTarget()
	const t0 = a.rec.target!
	a.r.manualMove(0, -5)
	assert.ok(Math.abs(a.rec.target! - (t0 - 5)) < 1e-9)
	assert.equal(a.rec.refGain, -5)

	const b = rig({ grab: 'pause', grabPauseMs: 2000 })
	b.step(1000)
	b.r.captureTarget()
	b.st.raw = -30
	b.r.manualMove(0, 0)
	b.step(1500)
	assert.equal(b.st.fader, 0)
	b.step(3000)
	assert.ok(b.st.fader! > 0)

	const c = rig({ grab: 'off' })
	c.step(500)
	c.r.captureTarget()
	c.r.manualMove(0, 3)
	assert.ok(c.st.offCalled)
})

test('calibrate sets the fader for a level, and the target with it', () => {
	const { r, rec, st, step } = rig({ calibrateMove: 'jump', autoLevelOn: false })
	st.raw = -26
	step(1000)
	r.calibrate(-18)
	assert.ok(Math.abs(st.fader! - 8) < 0.6, `fader ${st.fader}`)
	assert.equal(rec.target, -18)
})

test('trim mode measures before the fader, so the fader is left alone', () => {
	const { r, rec, st, step } = rig({ controlMode: 'trim' })
	st.fader = -10
	step(1000)
	r.captureTarget()
	assert.ok(Math.abs(rec.target! - -20) < 0.6, `target is pre-fader: ${rec.target}`)
	st.raw = -26
	step(5000)
	assert.equal(st.fader, -10)
	assert.ok(st.trim > 5.4 && st.trim < 6.6, `trim ${st.trim}`)
})

test('pickup: waits, catches after the dwell, releases on an outside move', async () => {
	let desk = 64
	let sent: number | undefined
	const p = new PickupManager(
		() => desk,
		() => {},
	)
	const s = { band: 3, dwellMs: 100, releaseBand: 6, releaseMs: 0 }
	assert.equal(p.handle('a', 20, s, (x) => (sent = x)), false)
	assert.equal(p.ledState('a', 20).led, 'below')
	assert.equal(p.handle('a', 63, s, (x) => (sent = x)), false)
	assert.equal(p.ledState('a', 63).led, 'catch')
	await sleep(150)
	assert.equal(sent, 63)
	desk = 63
	assert.equal(p.handle('a', 90, s, (x) => (sent = x)), true) // latched: follows anything
	desk = 90
	desk = 30 // someone moved OBS
	p.tick()
	assert.equal(p.ledState('a', 90).led, 'above')
	p.destroy()
})

test('gestures: press, double tap, hold', async () => {
	const got: Gesture[] = []
	const g = new GestureReader(
		() => ({ doubleTapMs: 120, holdMs: 200 }),
		(_k, x) => got.push(x),
	)
	g.down('a')
	g.up('a')
	await sleep(160)
	g.down('a')
	g.up('a')
	g.down('a')
	g.up('a')
	await sleep(160)
	g.down('a')
	await sleep(260)
	g.up('a')
	await sleep(160)
	assert.deepEqual(got, ['press', 'double', 'hold'])
	g.destroy()
})

test('store: unknown or bad values are dropped, import picks parts', () => {
	const s = loadStore(JSON.stringify({ defaults: { bandDb: 'x', rideRateDbPerS: 5 }, page: { layout: 'rows' }, inputs: { Mic: { overrides: { measure: 'peak', nonsense: 1 }, target: -20 } } }))
	assert.equal(s.defaults.bandDb, INPUT_DEFAULTS.bandDb)
	assert.equal(s.defaults.rideRateDbPerS, 5)
	assert.equal(s.page.layout, 'rows')
	assert.deepEqual(s.inputs.Mic.overrides, { measure: 'peak' })
	const t = newStore()
	applyImport(t, s, ['input:Mic'])
	assert.equal(t.inputs.Mic.target, -20)
	assert.equal(t.page.layout, 'strips')
})

test('version compare and update flags', () => {
	assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
	assert.equal(compareVersions('v0.2.0', '0.1.9'), 1)
	assert.equal(compareVersions('31.0.2', '31.1.0'), -1)
	assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0)
	const v = newVersionInfo('0.1.0', { moduleDownload: '', deviceDownload: '' }, 'OBS Studio')
	v.moduleLatest = '0.1.1'
	v.deviceVersion = '31.0.2'
	v.deviceLatest = '31.0.2'
	recompute(v)
	assert.equal(v.moduleUpdate, true)
	assert.equal(v.deviceUpdate, false)
})

test('newest module release includes pre-releases, skips drafts', () => {
	assert.equal(pickNewest([{ tag_name: 'v0.1.1' }, { tag_name: 'v0.2.0', draft: true }, { tag_name: 'v0.1.3' }]), '0.1.3')
	assert.equal(pickNewest([]), null)
})


test('colours from text', () => {
	assert.equal(parseColour('#ff0000', undefined), 0xff0000)
	assert.equal(parseColour('0,255,0', undefined), 0x00ff00)
	assert.equal(parseColour('nope', 7), 7)
	assert.equal(scaleColour(0xffffff, 0.5), 0x808080)
})

test('store migration: a version 1 (rider) store loads as auto level', () => {
	const v1 = {
		version: 1,
		defaults: { riderOn: true, bandDb: 4 },
		sections: [{ id: 'input', name: 'Input', controls: ['trim', 'sync', 'balance'], mode: 'open' }, { id: 'tracks', name: 'Tracks', controls: ['tracks'], mode: 'collapsible' }],
		inputs: { Mic: { overrides: { riderOn: true, measure: 'peak' }, target: -20, refGain: 0 }, Music: { overrides: { riderOn: false } } },
	}
	const s = loadStore(JSON.stringify(v1))
	assert.equal(s.version, STORE_VERSION)
	assert.equal(s.defaults.autoLevelOn, true)
	assert.equal(s.defaults.bandDb, 4)
	assert.equal('riderOn' in s.defaults, false)
	assert.deepEqual(s.inputs.Mic.overrides, { autoLevelOn: true, measure: 'peak' })
	assert.deepEqual(s.inputs.Music.overrides, { autoLevelOn: false })
	assert.equal(s.inputs.Mic.target, -20)
	assert.deepEqual(s.sections[0].controls, ['trim', 'delay', 'balance'])
	assert.deepEqual(s.sections[1].controls, ['routing'])
	// an object (not text) is migrated without touching the caller's copy
	const raw = JSON.parse(JSON.stringify(v1))
	loadStore(raw)
	assert.equal(raw.defaults.riderOn, true)
	// already version 2: left alone
	assert.deepEqual(migrateStore({ version: 2, defaults: { riderOn: true } }).defaults, { riderOn: true })
	// both present (half-migrated): the new one wins
	assert.equal(loadStore({ version: 1, defaults: { riderOn: false, autoLevelOn: true } }).defaults.autoLevelOn, true)
})

test('store schema: device fields and processing kinds are kept, unknown ones dropped', () => {
	const schema = makeSchema({ processing: FAKE_INFO.processing, inputFields: { trimFilterName: { label: 'Trim filter', type: 'text', group: 'autolevel', help: '', default: 'Trim' } } })
	assert.equal(schema.defaults.trimFilterName, 'Trim')
	const s = loadStore({ version: 2, defaults: { trimFilterName: 'Gain' }, sections: [{ id: 'p', name: 'P', controls: ['comp', 'nonsense', 'routing'] }], inputs: { a: { overrides: { trimFilterName: 'G2', bogus: 1 } } } }, schema)
	assert.equal(s.defaults.trimFilterName, 'Gain')
	assert.deepEqual(s.sections[0].controls, ['comp', 'routing'])
	assert.deepEqual(s.inputs.a.overrides, { trimFilterName: 'G2' })
	assert.ok(newStore(schema).sections.some((x) => x.controls.includes('comp')))
	// without the device, its field isn't known
	assert.equal('trimFilterName' in loadStore({ defaults: { trimFilterName: 'x' } }).defaults, false)
})

function engineRig() {
	const dev = new FakeDevice()
	const logs: string[] = []
	const changes: UserChange[] = []
	const host: EngineHost = { log: (l, m) => logs.push(`${l}: ${m}`), save: () => {}, structureChanged: () => {}, stateChanged: () => {} }
	const engine = new Engine(host, FAKE_INFO, { appId: 'fake-audio', appName: 'Fake Audio', moduleVersion: '0.0.1', updates: { moduleRepo: 'x/y', deviceRepo: '', moduleDownload: '', deviceDownload: '', userAgent: 't' } }, undefined, '')
	engine.on('userChange', (c: UserChange) => changes.push(c))
	return { dev, engine, logs, changes }
}

test('engine on a fake device: auto level rides the trim, PFL/solo by caps, external changes recorded', async (t) => {
	const { dev, engine, logs, changes } = engineRig()
	t.after(() => engine.destroy())
	dev.add('mic', -24)
	dev.add('aux', -12)
	dev.add('old', -18, CLASSIC_CAPS)
	engine.useDevice(dev)
	for (let i = 0; i < 40 && engine.visible().length < 3; i++) await sleep(25)
	assert.deepEqual(engine.visible().map((i) => i.id), ['mic', 'aux', 'old'])
	assert.equal(engine.versions.deviceVersion, '1.0.0')
	assert.equal(engine.resolve('MIC')!.id, 'mic')

	engine.setDefaultSetting('measureWindowMs', 400)
	engine.setDefaultSetting('rideRateDbPerS', 10)
	engine.setDefaultSetting('captureMode', 'instant')
	engine.setInputSetting('mic', 'controlMode', 'trim')
	engine.setInputSetting('mic', 'autoLevelOn', true)
	await sleep(600)
	engine.captureTarget(engine.resolve('mic')!)
	assert.ok(Math.abs(engine.store.inputs.mic.target! - -24) < 1.5, `target ${engine.store.inputs.mic.target}`)
	dev.get('mic').signalDb = -30
	await sleep(2200)
	assert.ok(dev.get('mic').trimDb > 4.5 && dev.get('mic').trimDb < 7, `trim ridden up ~6: ${dev.get('mic').trimDb}`)
	assert.equal(dev.get('mic').volumeDb, 0, 'fader left alone')
	assert.ok(!dev.calls.includes('volume mic'))

	// trim mode on an input without a trim: auto level falls back to the fader, the trim action says why not
	engine.setInputSetting('old', 'controlMode', 'trim')
	engine.setTrim(engine.resolve('old')!, 3)
	assert.ok(logs.some((l) => l.includes('has no trim')))
	engine.setInputSetting('old', 'autoLevelOn', true)
	engine.setInputSetting('old', 'calibrateMove', 'jump')
	await sleep(600) // the mode change restarted its listening window
	engine.calibrate(engine.resolve('old')!, -10)
	await sleep(100)
	assert.ok(dev.calls.includes('volume old'), 'calibrated on the fader: ' + logs.filter((l) => l.includes('OLD')).join(' | '))
	assert.ok(!dev.calls.includes('trim old'))

	// PFL and solo only touch inputs with monitoring
	const mic = engine.resolve('mic')!
	const aux = engine.resolve('aux')!
	const old = engine.resolve('old')!
	await engine.monitoring.setPfl(mic, true)
	await sleep(30)
	assert.equal(dev.get('mic').monitor, 'pfl')
	await engine.monitoring.setSolo(aux, true)
	await sleep(30)
	assert.equal(dev.get('mic').monitor, 'off')
	assert.equal(dev.get('aux').monitor, 'pfl')
	assert.equal(engine.monitoring.pflShown(mic), true)
	await engine.monitoring.setSolo(aux, false)
	await sleep(30)
	assert.equal(dev.get('mic').monitor, 'pfl')
	assert.equal(dev.get('aux').monitor, 'off')
	assert.equal(engine.monitoring.pflShown(old), false)
	await engine.monitoring.setPfl(old, true) // no monitoring: nothing happens

	// delay snaps to the device's unit and range; mix option is checked against the choices
	await engine.setDelay(aux, 3.4)
	await engine.setDelay(old, 2)
	await engine.setMixOption(aux, 'afv')
	await engine.setMixOption(aux, 'nonsense')
	await sleep(30)
	assert.equal(dev.get('aux').delay, 3)
	assert.equal(dev.get('aux').mixOption, 'afv')
	assert.ok(logs.some((l) => l.includes("isn't a mix option")))

	// a change on the desk itself is reported for the action recorder; our own echoes aren't
	const before = changes.length
	dev.external('aux', { muted: true })
	dev.external('aux', { blocks: [{ id: 'comp', name: 'Comp', kind: 'comp', enabled: true, settings: { threshold: -30 } }] })
	await sleep(20)
	const ext = changes.slice(before)
	assert.ok(ext.some((c) => c.kind === 'mute' && c.muted))
	assert.ok(ext.some((c) => c.kind === 'blockParam' && c.key === 'threshold' && c.value === -30))
	assert.ok(!changes.some((c) => c.kind === 'delay'), 'own delay change not recorded as a hand move')

	// meters carry gain reduction through to the page frame
	const frame = engine.meterFrame()
	assert.equal(frame.aux[4].comp, 3)

	// rename keeps settings
	dev.get('mic').id = 'presenter'
	dev.host!.inputRenamed('mic', 'presenter', 'Presenter')
	assert.equal(engine.settings('presenter').autoLevelOn, true)
	assert.equal(engine.resolve('1')!.name, 'Presenter')

	// recording through the device
	await engine.recorder.setFileName('Session 1')
	await engine.recorder.start()
	await sleep(20)
	assert.equal(engine.recorder.state.active, true)
	await engine.recorder.stop()
	await sleep(20)
	assert.equal(engine.recorder.state.lastFile, 'Session 1.wav')

	engine.destroy()
	assert.ok(!logs.some((l) => l.startsWith('error')), logs.join('\n'))
})

test('page is served with the module name and draws from caps', async (t) => {
	const { dev, engine } = engineRig()
	t.after(() => engine.destroy())
	dev.add('mic', -24)
	engine.useDevice(dev)
	for (let i = 0; i < 40 && engine.visible().length < 1; i++) await sleep(25)
	const web = new WebServer(engine, { port: 0, bind: '127.0.0.1', pin: '' }, () => {})
	web.start()
	await sleep(50)
	const base = `http://127.0.0.1:${web.port}`
	const html = await (await fetch(base + '/')).text()
	assert.ok(html.includes('<title>Fake Audio</title>'))
	assert.ok(html.includes('FAKE AUDIO'))
	assert.ok(!html.includes('%APP_'))
	assert.ok(pageHtml('x', 'A<b>').includes('<title>A&#60;b&#62;</title>'), 'name is escaped')
	const post = (c: object) => fetch(base + '/cmd', { method: 'POST', body: JSON.stringify(c) }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>)
	assert.equal((await post({ cmd: 'blockSet', input: 'mic', block: 'comp', key: 'threshold', value: -40 })).ok, true)
	assert.equal((await post({ cmd: 'mixOption', input: 'mic', value: 'off' })).ok, true)
	assert.equal((await post({ cmd: 'autoLevel', input: 'mic', value: true })).ok, true)
	assert.equal((await post({ cmd: 'blockSet', input: 'mic', block: 'nope', key: 'x', value: 1 })).ok, false)
	await sleep(30)
	assert.equal(dev.get('mic').blocks[0].settings.threshold, -40)
	assert.equal(dev.get('mic').mixOption, 'off')
	assert.equal(engine.settings('mic').autoLevelOn, true)
	const ac = new AbortController()
	const res = await fetch(base + '/events', { signal: ac.signal })
	const reader = res.body!.getReader()
	let text = ''
	while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value)
	ac.abort()
	assert.ok(text.includes('"processing":[{"kind":"comp"'))
	assert.ok(text.includes('"mixOption":{"label":"Mix"'))
	web.stop()
	engine.destroy()
})
