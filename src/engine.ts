/**
 * The core of every Rebel audio module, separate from Companion and from any
 * one device: every input's audio state, meters, auto level, CLOR pickup,
 * gestures, show features and the settings store. It talks to the mixer only
 * through a Device (see device.ts). The module's main.ts turns this into
 * Companion actions/feedbacks/variables; web.ts serves the page from it.
 */

import { EventEmitter } from 'node:events'
import { type Db, clamp, dbToPosition, mulToDb, MIN_DB, type LawSettings } from './law.js'
import { AutoLevel, type AutoLevelState } from './autolevel.js'
import { PickupManager } from './pickup.js'
import { GestureReader, type Gesture } from './gesture.js'
import { latestRelease, newestRelease, newVersionInfo, recompute, type UpdateSources, type VersionInfo } from './updates.js'
import { Backups, Monitoring, Notices, Recorder, type FeatureHost } from './features.js'
import type { BlockInfo, Device, DeviceHost, DeviceInfo, DeviceInputState, DeviceMeter } from './device.js'
import { RecordingsFeature, type RecordingsOptions } from './recordings-feature.js'
import {
	type Store,
	type InputSettings,
	type ImportPart,
	type SectionMode,
	type Section,
	type PageSettings,
	type StoreSchema,
	makeSchema,
	newStore,
	loadStore,
	inputRecord,
	effectiveSettings,
	coerceSetting,
	applyImport,
	PAGE_DEFAULTS,
	GESTURE_DEFAULTS,
} from './settings.js'

/** An input as the engine keeps it: the device's state plus meters and auto level */
export interface InputInfo extends DeviceInputState {
	/** Latest meters, dB per channel */
	postPeak: Db[]
	postMag: Db[]
	prePeak: Db[]
	/** Gain reduction per block id, dB */
	gainReduction: Record<string, number>
	autoLevel: AutoLevel
}

export interface EngineHost {
	log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void
	/** Persist the store (and autosave) */
	save(store: string, autosave: string): void
	/** Inputs, blocks or names changed: redo variable definitions, presets */
	structureChanged(): void
	/** Something feedbacks or variables show changed */
	stateChanged(): void
}

export interface EngineOptions {
	/** Module id, e.g. 'obs-audio' (export files, page storage) */
	appId: string
	/** Module name, e.g. 'OBS Audio' (page title, messages) */
	appName: string
	moduleVersion: string
	updates: UpdateSources
	/** What the routing section is called by default, e.g. 'Tracks' */
	routingLabel?: string
	/** Recordings (sheet naming, file manager, uploads): test seams. Optional. */
	recordings?: RecordingsOptions
	/** For {source} in recording names: the connection's name (default: the module name). Can change later: engine.sourceName */
	sourceName?: string
}

/**
 * A change made by hand somewhere other than Companion (the page, or the
 * device itself), for Companion's action recorder. The module maps each kind
 * to one of its actions.
 */
export type UserChange =
	| { kind: 'volume'; input: string; db: Db }
	| { kind: 'trim'; input: string; db: number }
	| { kind: 'mute'; input: string; muted: boolean }
	| { kind: 'balance'; input: string; balance: number }
	| { kind: 'delay'; input: string; value: number }
	| { kind: 'monitor'; input: string; value: string }
	| { kind: 'routing'; input: string; target: string; on: boolean }
	| { kind: 'mixOption'; input: string; value: string }
	| { kind: 'blockParam'; input: string; block: BlockInfo; key: string; value: unknown }
	| { kind: 'blockEnabled'; input: string; block: BlockInfo; on: boolean }

interface Coalesce {
	busy: boolean
	next: (() => Promise<unknown>) | null
}

const ECHO_MS = 1500

export class Engine extends EventEmitter {
	readonly host: EngineHost
	readonly opts: EngineOptions
	readonly info: DeviceInfo
	readonly schema: StoreSchema
	store: Store
	autosave: string
	device: Device | null = null
	inputs = new Map<string, InputInfo>()
	/** The device's own order of inputs (ids) */
	#deviceOrder: string[] = []
	#sentVolume = new Map<string, { db: Db; at: number }[]>()
	#sentTrim = new Map<string, { db: number; at: number }[]>()
	#coalesce = new Map<string, Coalesce>()
	#fades = new Map<string, NodeJS.Timeout>()
	#saveTimer: NodeJS.Timeout | null = null
	#stateTimer: NodeJS.Timeout | null = null
	#tick: NodeJS.Timeout
	readonly pickup: PickupManager
	readonly gestures: GestureReader
	versions: VersionInfo
	readonly notices: Notices
	readonly monitoring: Monitoring
	readonly backups: Backups
	readonly recorder: Recorder
	/** Recordings: sheet naming, rename after stop, file manager, upload queue */
	readonly recordings: RecordingsFeature
	/** Used for {source} in recording names */
	sourceName: string
	/** Things this module just set, so the echo isn't taken for someone else's change */
	#self = new Map<string, number>()
	#updateTimer: NodeJS.Timeout | null = null

	constructor(host: EngineHost, info: DeviceInfo, opts: EngineOptions, storeJson: unknown, autosave: string) {
		super()
		this.host = host
		this.info = info
		this.opts = opts
		this.schema = makeSchema({ ...info, routingLabel: opts.routingLabel })
		this.store = storeJson ? loadStore(storeJson, this.schema) : newStore(this.schema)
		this.autosave = autosave || ''
		this.versions = newVersionInfo(opts.moduleVersion, opts.updates, info.software.label)
		this.pickup = new PickupManager(
			(id) => {
				const inp = this.inputs.get(id)
				return inp ? dbToPosition(inp.volumeDb, this.law) * 127 : undefined
			},
			() => this.#stateChanged(),
		)
		this.gestures = new GestureReader(
			() => this.store.gestures,
			(id, g) => this.#gesture(id, g),
		)
		this.#tick = setInterval(() => this.pickup.tick(), 125)
		const fh: FeatureHost = {
			inputs: this.inputs,
			settings: (n) => this.settings(n),
			setMonitor: (i, m) => this.setMonitor(i, m),
			fadeTo: (i, db, ms) => this.fadeTo(i, db, ms),
			setInputSetting: (n, k, v) => this.setInputSetting(n, k, v),
			recording: () => this.device?.recording,
			connected: () => this.connected,
			pflMode: () => this.store.page.pflMode,
			plan: () => this.store.record,
			savePlan: () => this.#dirty(),
			recordLeadMin: () => this.store.page.recordLeadMin,
			recordSnoozeMin: () => this.store.page.recordSnoozeMin,
			log: (l, m) => this.host.log(l, m),
			changed: () => this.#stateChanged(),
			beforeStart: () => this.recordings.beforeStart(),
		}
		this.sourceName = opts.sourceName ?? opts.appName
		this.recordings = new RecordingsFeature(
			{
				store: () => this.store.recordings,
				deviceFolder: () => this.recorder?.state.directory ?? '',
				deviceFileName: () => this.recorder?.state.fileName ?? '',
				recording: () => this.device?.recording,
				sourceName: () => this.sourceName,
				save: () => this.#dirty(),
				changed: () => {
					this.#stateChanged()
					this.emit('recordings')
				},
				structureChanged: () => this.host.structureChanged(),
				log: (l, m) => this.host.log(l, m),
			},
			opts.recordings,
		)
		this.notices = new Notices(() => this.#stateChanged())
		this.monitoring = new Monitoring(fh)
		this.backups = new Backups(fh, this.notices)
		this.recorder = new Recorder(fh, this.notices)
		this.recordings.start()
	}

	/** Note something this module is about to set */
	#mark(key: string): void {
		this.#self.set(key, Date.now())
	}

	#wasSelf(key: string): boolean {
		const t = this.#self.get(key)
		return t !== undefined && Date.now() - t < ECHO_MS
	}

	/** Tell Companion's action recorder about a change made by hand (page or the device itself) */
	userChange(c: UserChange): void {
		this.emit('userChange', c)
	}

	get law(): LawSettings {
		return { kind: this.store.page.law, topDb: this.store.page.faderTopDb, bottomDb: this.store.page.faderBottomDb }
	}

	get connected(): boolean {
		return this.device?.connected ?? false
	}

	/** Why the device isn't connected, in plain words ('' when it is) */
	get deviceError(): string {
		return this.device?.lastError ?? ''
	}

	destroy(): void {
		clearInterval(this.#tick)
		this.recorder.destroy()
		this.recordings.stop()
		if (this.#updateTimer) clearInterval(this.#updateTimer)
		for (const t of this.#fades.values()) clearInterval(t)
		this.#fades.clear()
		this.pickup.destroy()
		this.gestures.destroy()
		this.device?.stop()
		this.device = null
		this.flushSave()
	}

	/** Drive this device (replacing any before it, e.g. after the address changed) */
	useDevice(device: Device): void {
		this.device?.stop()
		this.device = device
		const mine = () => this.device === device
		const dh: DeviceHost = {
			log: (l, m) => mine() && this.host.log(l, m),
			connected: () => {
				if (!mine()) return
				this.host.log('info', `Connected to ${this.info.label}`)
				void device.refresh().then(() => this.recorder.refresh())
				this.emit('status')
			},
			disconnected: (reason, was) => {
				if (!mine()) return
				if (was) this.host.log('warn', `Disconnected from ${this.info.label}: ${reason}`)
				this.#stateChanged()
				this.emit('status')
			},
			inputs: (list) => mine() && this.#setInputs(list),
			inputAdded: (s) => {
				if (!mine()) return
				this.#upsert(s)
				if (!this.#deviceOrder.includes(s.id)) this.#deviceOrder.push(s.id)
				this.host.structureChanged()
				this.#stateChanged()
			},
			inputRemoved: (id) => {
				if (!mine()) return
				this.#dropInput(id)
				this.#deviceOrder = this.#deviceOrder.filter((n) => n !== id)
				this.host.structureChanged()
				this.#stateChanged()
			},
			inputRenamed: (oldId, newId, name) => mine() && this.#rename(oldId, newId, name),
			inputChanged: (id, patch, blocksChanged) => mine() && this.#onChange(id, patch, !!blocksChanged),
			meters: (list) => mine() && this.#onMeters(list),
			record: (ev) => {
				if (!mine()) return
				const was = this.recorder.state.active
				this.recorder.onEvent(ev)
				this.recordings.onRecordEvent(ev, was)
			},
			setting: (id, key) => this.settings(id)[key],
			version: (v) => {
				if (!mine()) return
				this.versions.deviceVersion = v
				recompute(this.versions)
				this.#stateChanged()
			},
		}
		device.start(dh)
	}

	// ---- update checks --------------------------------------------------------

	/** Check for updates now and every `hours` (0 = never) */
	setUpdateChecks(hours: number): void {
		if (this.#updateTimer) clearInterval(this.#updateTimer)
		this.#updateTimer = null
		if (!(hours > 0)) return
		void this.checkUpdates()
		this.#updateTimer = setInterval(() => void this.checkUpdates(), hours * 3600 * 1000)
	}

	async checkUpdates(): Promise<void> {
		const v = this.versions
		const u = this.opts.updates
		try {
			const [mod, dev] = await Promise.all([newestRelease(u.moduleRepo, u.userAgent), u.deviceRepo ? latestRelease(u.deviceRepo, u.userAgent) : Promise.resolve(null)])
			v.moduleLatest = mod
			v.deviceLatest = dev
			v.error = null
		} catch (e) {
			v.error = `Couldn't check for updates: ${(e as Error).message}`
			this.host.log('debug', v.error)
		}
		v.checkedAt = new Date().toISOString()
		recompute(v)
		if (v.moduleUpdate) this.host.log('info', `${this.opts.appName} ${v.moduleLatest} is out (this is ${v.moduleVersion})`)
		if (v.deviceUpdate) this.host.log('info', `${v.deviceLabel} ${v.deviceLatest} is out (this is ${v.deviceVersion})`)
		this.#stateChanged()
	}

	// ---- inputs and order ---------------------------------------------------

	/** Inputs in display order, hidden ones included */
	ordered(): InputInfo[] {
		const ids: string[] = []
		for (const n of this.store.order) if (this.inputs.has(n) && !ids.includes(n)) ids.push(n)
		for (const n of this.#deviceOrder) if (this.inputs.has(n) && !ids.includes(n)) ids.push(n)
		return ids.map((n) => this.inputs.get(n)!)
	}

	visible(): InputInfo[] {
		const hidden = new Set(this.store.hidden)
		return this.ordered().filter((i) => !hidden.has(i.id))
	}

	/** An input from text: its number in the visible list, its id or its name */
	resolve(text: string): InputInfo | undefined {
		const t = text.trim()
		if (t === '') return undefined
		if (/^\d+$/.test(t)) return this.visible()[Number(t) - 1]
		const lc = t.toLowerCase()
		return this.inputs.get(t) ?? [...this.inputs.values()].find((i) => i.name === t || i.id.toLowerCase() === lc || i.name.toLowerCase() === lc)
	}

	/** Which input a Grid fader drives: the override if given, else by position in the list */
	gridInput(fader: number, override: string): InputInfo | undefined {
		if (override.trim()) return this.resolve(override)
		return this.visible()[fader - 1]
	}

	settings(id: string): InputSettings {
		return effectiveSettings(this.store, id)
	}

	/** Re-read everything from the device */
	async refreshAll(): Promise<void> {
		if (!this.device?.connected) return
		await this.device.refresh()
	}

	#setInputs(list: DeviceInputState[]): void {
		const seen = new Set<string>()
		for (const s of list) {
			this.#upsert(s)
			seen.add(s.id)
		}
		for (const id of [...this.inputs.keys()]) if (!seen.has(id)) this.#dropInput(id)
		this.#deviceOrder = list.map((s) => s.id)
		this.host.structureChanged()
		this.#stateChanged()
		this.emit('status')
	}

	#upsert(s: DeviceInputState): InputInfo {
		let inp = this.inputs.get(s.id)
		if (!inp) {
			inp = this.#newInput(s)
			this.inputs.set(s.id, inp)
		} else Object.assign(inp, s)
		return inp
	}

	#newInput(s: DeviceInputState): InputInfo {
		const inp: InputInfo = {
			...s,
			postPeak: [],
			postMag: [],
			prePeak: [],
			gainReduction: {},
			autoLevel: undefined as unknown as AutoLevel,
		}
		inp.autoLevel = new AutoLevel({
			// an input without a trim can only be levelled on its fader
			settings: () => {
				const s = this.settings(inp.id)
				return inp.caps.trim || s.controlMode !== 'trim' ? s : { ...s, controlMode: 'fader' }
			},
			record: () => inputRecord(this.store, inp.id),
			saveRecord: () => this.#dirty(),
			setGain: (db) => {
				if (this.settings(inp.id).controlMode === 'trim' && inp.caps.trim) void this.#sendTrim(inp, db)
				else void this.#sendVolume(inp, db)
			},
			gainRange: (mode) => (mode === 'trim' ? [inp.caps.trim?.minDb ?? -30, inp.caps.trim?.maxDb ?? 30] : [inp.caps.fader.minDb, inp.caps.fader.maxDb]),
			autoLevelOff: () => this.setInputSetting(inp.id, 'autoLevelOn', false),
			log: (level, msg) => this.host.log(level, `${inp.name}: ${msg}`),
			changed: () => this.#stateChanged(),
		})
		return inp
	}

	#dropInput(id: string): void {
		this.inputs.delete(id)
		this.pickup.forget(id)
		const t = this.#fades.get(id)
		if (t) clearInterval(t)
		this.#fades.delete(id)
	}

	#rename(oldId: string, newId: string, name: string): void {
		const inp = this.inputs.get(oldId)
		if (!inp) return
		inp.name = name
		if (newId !== oldId) {
			this.inputs.delete(oldId)
			inp.id = newId
			this.inputs.set(newId, inp)
			const swap = (n: string) => (n === oldId ? newId : n)
			this.#deviceOrder = this.#deviceOrder.map(swap)
			this.store.order = this.store.order.map(swap)
			this.store.hidden = this.store.hidden.map(swap)
			if (this.store.inputs[oldId]) {
				this.store.inputs[newId] = this.store.inputs[oldId]
				delete this.store.inputs[oldId]
			}
			for (const rec of Object.values(this.store.inputs)) if (rec.overrides.backupOf === oldId) rec.overrides.backupOf = newId
			if (this.store.defaults.backupOf === oldId) this.store.defaults.backupOf = newId
			this.pickup.forget(oldId)
			this.#dirty()
		}
		this.host.structureChanged()
		this.#stateChanged()
	}

	// ---- changes from the device ----------------------------------------------

	#onChange(id: string, patch: Partial<DeviceInputState>, blocksChanged: boolean): void {
		const inp = this.inputs.get(id)
		if (!inp) return
		const before = { ...inp, routing: { ...inp.routing }, blocks: inp.blocks.map((b) => ({ ...b, settings: { ...b.settings } })) }
		Object.assign(inp, patch)
		if ('volumeDb' in patch) this.#onVolume(inp, before.volumeDb)
		if ('trimDb' in patch && patch.trimDb !== before.trimDb) this.#onTrim(inp, before.trimDb)
		if ('muted' in patch && patch.muted !== before.muted && !this.#wasSelf(`mute:${id}`)) this.userChange({ kind: 'mute', input: id, muted: inp.muted })
		if ('balance' in patch && patch.balance !== before.balance && !this.#wasSelf(`bal:${id}`)) this.userChange({ kind: 'balance', input: id, balance: inp.balance })
		if ('delay' in patch && patch.delay !== before.delay && !this.#wasSelf(`delay:${id}`)) this.userChange({ kind: 'delay', input: id, value: inp.delay })
		if ('monitor' in patch && patch.monitor !== before.monitor && !this.#wasSelf(`mon:${id}`)) this.userChange({ kind: 'monitor', input: id, value: inp.monitor })
		if ('mixOption' in patch && patch.mixOption !== before.mixOption && !this.#wasSelf(`mix:${id}`)) this.userChange({ kind: 'mixOption', input: id, value: inp.mixOption })
		if ('routing' in patch && !this.#wasSelf(`route:${id}`)) {
			for (const [t, on] of Object.entries(inp.routing)) if (before.routing[t] !== on) this.userChange({ kind: 'routing', input: id, target: t, on })
		}
		if ('blocks' in patch && !blocksChanged) {
			for (const b of inp.blocks) {
				const old = before.blocks.find((x) => x.id === b.id)
				if (!old || b.isTrim) continue
				if (old.enabled !== b.enabled && !this.#wasSelf(`bon:${id}:${b.id}`)) this.userChange({ kind: 'blockEnabled', input: id, block: b, on: b.enabled })
				if (!this.#wasSelf(`b:${id}:${b.id}`)) {
					for (const [k, v] of Object.entries(b.settings)) if (old.settings[k] !== v) this.userChange({ kind: 'blockParam', input: id, block: b, key: k, value: v })
				}
			}
		}
		if (blocksChanged) this.host.structureChanged()
		this.#stateChanged()
	}

	#isOurs<T extends number | null>(list: { db: T; at: number }[] | undefined, db: T, tol: number): boolean {
		const now = Date.now()
		return (list ?? []).some((s) => now - s.at <= ECHO_MS && (s.db === db || (s.db !== null && db !== null && Math.abs((s.db as number) - (db as number)) <= tol)))
	}

	#onVolume(inp: InputInfo, old: Db): void {
		const db = inp.volumeDb
		if (!this.#isOurs(this.#sentVolume.get(inp.id), db, 0.05)) {
			// moved somewhere else (the device itself, another module)
			const fade = this.#fades.get(inp.id)
			if (fade) {
				clearInterval(fade)
				this.#fades.delete(inp.id)
			}
			if (this.settings(inp.id).controlMode === 'fader') inp.autoLevel.manualMove(old, db)
			this.userChange({ kind: 'volume', input: inp.id, db })
		}
	}

	#onTrim(inp: InputInfo, before: number): void {
		if (this.#isOurs(this.#sentTrim.get(inp.id), inp.trimDb, 0.05)) return
		if (this.settings(inp.id).controlMode === 'trim') inp.autoLevel.manualMove(before, inp.trimDb)
	}

	#onMeters(list: DeviceMeter[]): void {
		const t = Date.now()
		for (const m of list ?? []) {
			const inp = this.inputs.get(m.id)
			if (!inp) continue
			inp.channels = m.postMag.length || inp.channels
			inp.postMag = m.postMag.map(mulToDb)
			inp.postPeak = m.postPeak.map(mulToDb)
			inp.prePeak = m.prePeak.map(mulToDb)
			inp.gainReduction = m.gainReduction ?? {}
			// no pre-fader meter (a classic desk): work it out from post-fader, while the fader's up and unmuted
			const fader = inp.volumeDb === null || inp.muted ? 0 : Math.pow(10, inp.volumeDb / 20)
			const pre = m.prePeak.length ? m.prePeak : fader > 0 ? m.postPeak.map((x) => x / fader) : []
			inp.autoLevel.onMeter({
				t,
				mag: m.postMag,
				prePeak: pre,
				faderDb: inp.volumeDb,
				trimDb: inp.trimDb,
				muted: inp.muted,
			})
		}
		this.backups.check(t)
		this.emit('meters')
	}

	// ---- sending to the device -------------------------------------------------

	/** Send requests for one thing one at a time, always ending on the latest */
	#coalesced(key: string, job: () => Promise<unknown>): Promise<void> {
		let c = this.#coalesce.get(key)
		if (!c) {
			c = { busy: false, next: null }
			this.#coalesce.set(key, c)
		}
		c.next = job
		if (c.busy) return Promise.resolve()
		const run = async (): Promise<void> => {
			const cc = c!
			while (cc.next) {
				const j = cc.next
				cc.next = null
				cc.busy = true
				try {
					await j()
				} catch (e) {
					this.host.log('warn', (e as Error).message)
				}
			}
			cc.busy = false
		}
		return run()
	}

	#remember<T>(map: Map<string, { db: T; at: number }[]>, id: string, db: T): void {
		const now = Date.now()
		const list = (map.get(id) ?? []).filter((s) => now - s.at <= ECHO_MS)
		list.push({ db, at: now })
		map.set(id, list)
	}

	#dev(): Device {
		if (!this.device?.connected) throw new Error(`Not connected to ${this.info.label}`)
		return this.device
	}

	#sendVolume(inp: InputInfo, db: Db): Promise<void> {
		const v: Db = db === null || db <= MIN_DB ? null : clamp(db, MIN_DB, inp.caps.fader.maxDb)
		inp.volumeDb = v
		this.#remember(this.#sentVolume, inp.id, v)
		this.#stateChanged()
		return this.#coalesced(`vol:${inp.id}`, () => this.#dev().setVolume(inp.id, v))
	}

	#sendTrim(inp: InputInfo, db: number): Promise<void> {
		const t = inp.caps.trim
		if (!t) return Promise.resolve()
		const v = clamp(db, t.minDb, t.maxDb)
		inp.trimDb = v
		this.#remember(this.#sentTrim, inp.id, v)
		this.#stateChanged()
		return this.#coalesced(`trim:${inp.id}`, async () => {
			const d = this.#dev()
			if (!d.setTrim) throw new Error(`${inp.name} has no trim`)
			await d.setTrim(inp.id, v)
		})
	}

	/** Run a device call; log (not throw) if it fails or the device can't do it */
	async #call(what: string, fn: (d: Device) => Promise<unknown> | undefined): Promise<void> {
		if (!this.device?.connected) {
			this.host.log('warn', `Not connected to ${this.info.label}`)
			return
		}
		try {
			const p = fn(this.device)
			if (p === undefined) this.host.log('warn', `${this.info.label} can't do that (${what})`)
			else await p
		} catch (e) {
			this.host.log('warn', `${what}: ${(e as Error).message}`)
		}
	}

	// ---- operations (from actions and the web page) --------------------------

	/** A hand move of the fader (web page, Grid, Companion button) */
	setVolume(inp: InputInfo, db: Db, fadeMs = 0): void {
		const old = inp.volumeDb
		const existing = this.#fades.get(inp.id)
		if (existing) {
			clearInterval(existing)
			this.#fades.delete(inp.id)
		}
		if (this.settings(inp.id).controlMode === 'fader') inp.autoLevel.manualMove(old, db)
		if (fadeMs <= 0 || old === null || db === null) {
			void this.#sendVolume(inp, db)
			return
		}
		const start = Date.now()
		const from = old
		const to = db
		const timer = setInterval(() => {
			const f = Math.min(1, (Date.now() - start) / fadeMs)
			void this.#sendVolume(inp, from + (to - from) * f)
			if (f >= 1) {
				clearInterval(timer)
				this.#fades.delete(inp.id)
			}
		}, 50)
		this.#fades.set(inp.id, timer)
	}

	/** An automatic move (backup switch): glide there, not counted as a hand move */
	fadeTo(inp: InputInfo, db: Db, ms: number): void {
		const existing = this.#fades.get(inp.id)
		if (existing) clearInterval(existing)
		this.#fades.delete(inp.id)
		const from = inp.volumeDb ?? -60
		const to = db ?? -60
		if (ms <= 0) {
			void this.#sendVolume(inp, db)
			return
		}
		const start = Date.now()
		const timer = setInterval(() => {
			const f = Math.min(1, (Date.now() - start) / ms)
			void this.#sendVolume(inp, f >= 1 ? db : from + (to - from) * f)
			if (f >= 1) {
				clearInterval(timer)
				this.#fades.delete(inp.id)
			}
		}, 40)
		this.#fades.set(inp.id, timer)
	}

	/** Act on a pop-up's button */
	async noticeAction(id: string, action: string): Promise<string | void> {
		const n = this.notices.get(id)
		if (!n) return
		const backup = n.input ? this.inputs.get(n.input) : undefined
		if (action === 'dismiss') {
			this.notices.remove(id)
			if (n.kind === 'record-due') this.recorder.dismissPrompt()
			return
		}
		if (n.kind === 'backup-back' && backup) {
			if (action === 'take') this.backups.switchToMain(backup)
			else if (action === 'snooze') this.backups.snooze(backup)
			else if (action === 'swap') this.backups.swap(backup)
			return
		}
		if (n.kind === 'record-due') {
			if (action === 'start') {
				await this.recorder.start()
				this.notices.remove(id)
			} else if (action === 'snooze') this.recorder.snoozePrompt()
			// 'newtime' is handled on the page, which then sets a new plan
		}
	}

	setTrim(inp: InputInfo, db: number): void {
		if (!inp.caps.trim) return this.host.log('warn', `${inp.name} has no trim`)
		if (this.settings(inp.id).controlMode === 'trim') inp.autoLevel.manualMove(inp.trimDb, db)
		void this.#sendTrim(inp, db)
	}

	touch(inp: InputInfo, on: boolean): void {
		inp.autoLevel.touch(on)
	}

	setMute(inp: InputInfo, muted: boolean): Promise<void> {
		this.#mark(`mute:${inp.id}`)
		inp.muted = muted
		this.#stateChanged()
		return this.#call('Mute', (d) => d.setMute?.(inp.id, muted))
	}

	setBalance(inp: InputInfo, balance: number): Promise<void> {
		this.#mark(`bal:${inp.id}`)
		inp.balance = clamp(balance, 0, 1)
		this.#stateChanged()
		return this.#call('Balance', (d) => d.setBalance?.(inp.id, inp.balance))
	}

	setDelay(inp: InputInfo, value: number): Promise<void> {
		const c = inp.caps.delay
		if (!c) return Promise.resolve(this.host.log('warn', `${inp.name} has no delay`))
		this.#mark(`delay:${inp.id}`)
		inp.delay = clamp(Math.round(value / c.step) * c.step, c.min, c.max)
		this.#stateChanged()
		return this.#call('Delay', (d) => d.setDelay?.(inp.id, inp.delay))
	}

	setMonitor(inp: InputInfo, m: string): Promise<void> {
		const c = inp.caps.monitor
		if (!c || !c.choices.some((x) => x.id === m)) return Promise.resolve(this.host.log('warn', `"${m}" isn't a monitoring choice for ${inp.name}`))
		this.#mark(`mon:${inp.id}`)
		inp.monitor = m
		this.#stateChanged()
		return this.#call('Monitoring', (d) => d.setMonitor?.(inp.id, m))
	}

	setRouting(inp: InputInfo, changes: Record<string, boolean>): Promise<void> {
		this.#mark(`route:${inp.id}`)
		inp.routing = { ...inp.routing, ...changes }
		this.#stateChanged()
		return this.#call('Routing', (d) => d.setRouting?.(inp.id, changes))
	}

	setMixOption(inp: InputInfo, value: string): Promise<void> {
		const c = inp.caps.mixOption
		if (!c || !c.choices.some((x) => x.id === value)) return Promise.resolve(this.host.log('warn', `"${value}" isn't a mix option for ${inp.name}`))
		this.#mark(`mix:${inp.id}`)
		inp.mixOption = value
		this.#stateChanged()
		return this.#call('Mix option', (d) => d.setMixOption?.(inp.id, value))
	}

	async addBlock(inp: InputInfo, kind: string, name: string): Promise<void> {
		const k = this.info.processing.find((f) => f.kind === kind)
		if (!k) return
		if (!inp.caps.processing?.addable || !this.device?.addBlock) return this.host.log('warn', `${inp.name}'s processing can't be added to`)
		let n = name.trim() || k.defaultName
		if (!name.trim()) {
			let i = 2
			while (inp.blocks.some((f) => f.name === n)) n = `${k.defaultName} ${i++}`
		}
		await this.#call(`Adding ${k.label} to ${inp.name}`, (d) => d.addBlock?.(inp.id, kind, n))
		this.#stateChanged()
	}

	async removeBlock(inp: InputInfo, blockId: string): Promise<void> {
		await this.#call('Removing processing', (d) => d.removeBlock?.(inp.id, blockId))
		inp.blocks = inp.blocks.filter((f) => f.id !== blockId)
		this.host.structureChanged()
		this.#stateChanged()
	}

	setBlockEnabled(inp: InputInfo, blockId: string, on: boolean): Promise<void> {
		this.#mark(`bon:${inp.id}:${blockId}`)
		const f = inp.blocks.find((x) => x.id === blockId)
		if (f) f.enabled = on
		this.#stateChanged()
		return this.#call('Processing on/off', (d) => d.setBlockEnabled?.(inp.id, blockId, on))
	}

	setBlockParam(inp: InputInfo, blockId: string, key: string, value: unknown): Promise<void> {
		this.#mark(`b:${inp.id}:${blockId}`)
		const f = inp.blocks.find((x) => x.id === blockId)
		if (f) f.settings[key] = value
		this.#stateChanged()
		return this.#coalesced(`b:${inp.id}:${blockId}:${key}`, async () => {
			const d = this.#dev()
			if (!d.setBlockParam) throw new Error(`${this.info.label} can't change processing`)
			await d.setBlockParam(inp.id, blockId, key, value)
		})
	}

	// ---- auto level -----------------------------------------------------------

	captureTarget(inp: InputInfo): void {
		inp.autoLevel.captureTarget()
	}

	calibrate(inp: InputInfo, which: 'input' | 'module' | number): void {
		const level = which === 'input' ? this.settings(inp.id).calibrateDb : which === 'module' ? this.store.moduleCalibrateDb : which
		inp.autoLevel.calibrate(level)
	}

	setTarget(inp: InputInfo, db: number | null): void {
		const rec = inputRecord(this.store, inp.id)
		rec.target = db
		rec.refGain = db === null ? null : (inp.autoLevel.gain ?? null)
		this.#dirty()
		this.#stateChanged()
	}

	buttonDown(inp: InputInfo): void {
		this.gestures.down(inp.id)
	}

	buttonUp(inp: InputInfo): void {
		this.gestures.up(inp.id)
	}

	#gesture(id: string, g: Gesture): void {
		const inp = this.inputs.get(id)
		if (!inp) return
		if (g === 'press') this.captureTarget(inp)
		else if (g === 'double') this.calibrate(inp, 'input')
		else this.calibrate(inp, 'module')
	}

	// ---- settings -------------------------------------------------------------

	/** Set one input's setting; value undefined = back to the page-wide default */
	setInputSetting(id: string, key: string, value: unknown): void {
		if (!this.schema.fields[key]) return this.host.log('warn', `There's no input setting called "${key}"`)
		const rec = inputRecord(this.store, id)
		const before = this.settings(id)
		if (value === undefined || value === null) delete rec.overrides[key]
		else {
			const v = coerceSetting(key, value, this.schema)
			if (v === undefined) {
				this.host.log('warn', `"${String(value)}" isn't a valid ${this.schema.fields[key].label}`)
				return
			}
			rec.overrides[key] = v
		}
		this.#settingChanged(id, before, key)
		if (key === 'backupOf') this.host.structureChanged()
		this.#dirty()
		this.#stateChanged()
	}

	setDefaultSetting(key: string, value: unknown): void {
		const v = coerceSetting(key, value, this.schema)
		if (v === undefined) return
		const before = new Map([...this.inputs.keys()].map((n) => [n, this.settings(n)]))
		;(this.store.defaults as Record<string, unknown>)[key] = v
		for (const [n, b] of before) this.#settingChanged(n, b, key)
		this.#dirty()
		this.#stateChanged()
	}

	#settingChanged(id: string, before: InputSettings, key: string): void {
		const inp = this.inputs.get(id)
		if (!inp) return
		const after = this.settings(id)
		if (before[key] === after[key]) return
		const resets = key === 'controlMode' || !!this.info.inputFields?.[key]?.resetsAutoLevel
		if (resets) {
			// the measuring point changed: the old target doesn't apply
			const rec = inputRecord(this.store, id)
			rec.target = null
			rec.refGain = null
			inp.autoLevel.reset()
		}
		if (key === 'measure' || key === 'stereo') inp.autoLevel.reset()
		this.device?.settingChanged?.(id, key)
	}

	setPage(key: keyof PageSettings, value: unknown): void {
		const base = PAGE_DEFAULTS[key]
		if (base === undefined) return
		let v: unknown = value
		if (typeof base === 'number') v = Number(value)
		if (typeof base === 'boolean') v = value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
		if (typeof base === 'number' && Number.isNaN(v)) return
		if (typeof v !== typeof base) return
		if (key === 'pflMode' && v !== 'additive' && v !== 'exclusive') return
		if (key === 'layout' && v !== 'strips' && v !== 'rows') return
		if (key === 'law' && v !== 'desk' && v !== 'linear') return
		if ((key === 'faderScaleSide' || key === 'meterScaleSide') && v !== 'left' && v !== 'right') return
		if (key === 'meterPaleStrength' && ((v as number) < 0 || (v as number) > 1)) return
		if ((key === 'capColour' || key === 'capLineColour') && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v))) return
		;(this.store.page as unknown as Record<string, unknown>)[key] = v
		this.#dirty()
		this.#stateChanged()
	}

	setGestures(doubleTapMs?: number, holdMs?: number, moduleCalibrateDb?: number): void {
		if (doubleTapMs !== undefined && doubleTapMs > 0) this.store.gestures.doubleTapMs = doubleTapMs
		if (holdMs !== undefined && holdMs > 0) this.store.gestures.holdMs = holdMs
		if (moduleCalibrateDb !== undefined && !Number.isNaN(moduleCalibrateDb)) this.store.moduleCalibrateDb = moduleCalibrateDb
		this.#dirty()
		this.#stateChanged()
	}

	setSections(sections: Section[]): void {
		this.store = loadStore({ ...this.store, sections }, this.schema)
		this.#dirty()
		this.#stateChanged()
	}

	setInputSection(id: string, section: string, mode: SectionMode | null): void {
		const rec = inputRecord(this.store, id)
		if (mode === null) delete rec.sections[section]
		else rec.sections[section] = mode
		this.#dirty()
		this.#stateChanged()
	}

	setOrder(order: string[], hidden: string[]): void {
		this.store.order = order.filter((x) => typeof x === 'string')
		this.store.hidden = hidden.filter((x) => typeof x === 'string')
		this.#dirty()
		this.host.structureChanged()
		this.#stateChanged()
	}

	// ---- export / import ----------------------------------------------------

	exportJson(): string {
		const store = { ...this.store, recordings: RecordingsFeature.exportable(this.store.recordings) }
		return JSON.stringify({ app: `companion-module-${this.opts.appId}`, exported: new Date().toISOString(), store }, null, 1)
	}

	/** Apply parts of an exported file. The current settings go to the autosave first. */
	importJson(text: string, parts: ImportPart[]): string {
		let incoming: Store
		try {
			const parsed = JSON.parse(text) as { store?: unknown }
			incoming = loadStore(parsed.store ?? parsed, this.schema)
		} catch {
			throw new Error("That file isn't a settings export from this module.")
		}
		this.autosave = this.exportJson()
		applyImport(this.store, incoming, parts)
		this.#afterBulkChange()
		return `Imported ${parts.length} part${parts.length === 1 ? '' : 's'}. The previous settings are in the autosave.`
	}

	restoreAutosave(): string {
		if (!this.autosave) throw new Error('There is no autosave yet.')
		const current = this.exportJson()
		const parsed = JSON.parse(this.autosave) as { store?: unknown }
		const saved = this.store.recordings.saved
		this.store = loadStore(parsed.store ?? parsed, this.schema)
		// the upload queue and sheet copy belong to this computer, not to the settings
		this.store.recordings.saved = saved
		this.autosave = current
		this.#afterBulkChange()
		return 'Settings rolled back to the autosave (the ones just replaced are now the autosave).'
	}

	#afterBulkChange(): void {
		this.recordings.configure({})
		for (const inp of this.inputs.values()) {
			inp.autoLevel.reset()
			for (const key of Object.keys(this.info.inputFields ?? {})) this.device?.settingChanged?.(inp.id, key)
		}
		this.flushSave(true)
		this.host.structureChanged()
		this.#stateChanged()
	}

	// ---- persistence and change notices --------------------------------------

	#dirty(): void {
		if (this.#saveTimer) return
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = null
			this.host.save(JSON.stringify(this.store), this.autosave)
		}, 1000)
	}

	flushSave(force = false): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer)
			this.#saveTimer = null
			this.host.save(JSON.stringify(this.store), this.autosave)
		} else if (force) {
			this.host.save(JSON.stringify(this.store), this.autosave)
		}
	}

	#stateChanged(): void {
		if (this.#stateTimer) return
		this.#stateTimer = setTimeout(() => {
			this.#stateTimer = null
			this.host.stateChanged()
			this.emit('state')
		}, 50)
	}

	// ---- snapshots for the web page -------------------------------------------

	snapshot(): Record<string, unknown> {
		const hidden = new Set(this.store.hidden)
		return {
			connected: this.connected,
			deviceError: this.deviceError,
			versions: this.versions,
			notices: this.notices.list,
			recording: { ...this.recorder.state, plan: this.store.record, countdown: this.recorder.countdown() },
			solo: this.monitoring.solo,
			recordings: this.recordings.summary(),
			store: {
				defaults: this.store.defaults,
				page: this.store.page,
				gestures: this.store.gestures,
				moduleCalibrateDb: this.store.moduleCalibrateDb,
				sections: this.store.sections,
				order: this.store.order,
				hidden: this.store.hidden,
			},
			autosave: !!this.autosave,
			inputs: this.ordered().map((i) => {
				const rec = this.store.inputs[i.id]
				return {
					id: i.id,
					name: i.name,
					kind: i.kind,
					caps: i.caps,
					hidden: hidden.has(i.id),
					volumeDb: i.volumeDb,
					muted: i.muted,
					balance: i.balance,
					delay: i.delay,
					monitor: i.monitor,
					routing: i.routing,
					mixOption: i.mixOption,
					channels: i.channels,
					blocks: i.blocks,
					trimDb: i.trimDb,
					hasTrim: i.hasTrim,
					overrides: rec?.overrides ?? {},
					sections: rec?.sections ?? {},
					target: rec?.target ?? null,
					refGain: rec?.refGain ?? null,
					settings: this.settings(i.id),
					autoLevel: i.autoLevel.state,
					pfl: this.monitoring.pflShown(i),
					backupFor: this.backups.mainOf(i)?.id ?? null,
					onBackup: this.backups.onBackup(i.id),
				}
			}),
		}
	}

	/** Compact meter frame: id -> [postPeak[], prePeak[], autoLevel level, autoLevel state, gain reduction per block] */
	meterFrame(): Record<string, [(number | null)[], (number | null)[], number | null, AutoLevelState, Record<string, number>]> {
		const r = (d: Db) => (d === null ? null : Math.round(d * 10) / 10)
		const out: Record<string, [(number | null)[], (number | null)[], number | null, AutoLevelState, Record<string, number>]> = {}
		for (const i of this.inputs.values()) out[i.id] = [i.postPeak.map(r), i.prePeak.map(r), r(i.autoLevel.level), i.autoLevel.state, i.gainReduction]
		return out
	}

	/** Everything the page needs to know about this module and device, sent once */
	meta(): Record<string, unknown> {
		return {
			app: { id: this.opts.appId, name: this.opts.appName },
			device: { label: this.info.label, software: this.info.software.label },
			inputFields: this.schema.fields,
			inputDefaults: this.schema.defaults,
			pageDefaults: PAGE_DEFAULTS,
			gestureDefaults: GESTURE_DEFAULTS,
			controls: this.schema.controls,
			processing: this.info.processing,
			tips: this.info.tips ?? [],
		}
	}
}
