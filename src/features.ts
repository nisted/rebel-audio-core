/**
 * Show features on top of the basic device link: pop-up notices, PFL and solo
 * (monitoring only), backup feeds with automatic switch-over, and recording
 * with a planned restart. All of it goes through the Device interface.
 */

import { readdir } from 'node:fs/promises'
import type { Db } from './law.js'
import type { InputInfo } from './engine.js'
import type { InputSettings, RecordPlan } from './settings.js'
import type { DeviceRecordEvent, DeviceRecording } from './device.js'

// ---- what the features need from the engine --------------------------------

export interface FeatureHost {
	inputs: Map<string, InputInfo>
	settings(name: string): InputSettings
	setMonitor(inp: InputInfo, m: string): Promise<void>
	/** Move a fader as part of an automatic switch (not a hand move) */
	fadeTo(inp: InputInfo, db: Db, ms: number): void
	setInputSetting(name: string, key: string, value: unknown): void
	/** The device's recording, if it records */
	recording(): DeviceRecording | undefined
	connected(): boolean
	pflMode(): 'additive' | 'exclusive'
	plan(): RecordPlan
	savePlan(): void
	recordLeadMin(): number
	recordSnoozeMin(): number
	log(level: 'info' | 'warn' | 'debug', msg: string): void
	changed(): void
}

// ---- notices (pop-ups on the page, variables in Companion) ------------------

export interface Notice {
	id: string
	kind: 'backup-switched' | 'backup-back' | 'record-due' | 'info'
	input?: string
	title: string
	message: string
	actions: { id: string; label: string }[]
	at: string
}

export class Notices {
	list: Notice[] = []
	#n = 0
	constructor(private readonly changed: () => void) {}

	add(n: Omit<Notice, 'id' | 'at'>): Notice {
		// one of each kind per input at a time
		this.list = this.list.filter((x) => !(x.kind === n.kind && x.input === n.input))
		const full: Notice = { ...n, id: `n${++this.#n}`, at: new Date().toISOString() }
		this.list.push(full)
		this.changed()
		return full
	}

	remove(id: string): void {
		const before = this.list.length
		this.list = this.list.filter((x) => x.id !== id)
		if (this.list.length !== before) this.changed()
	}

	removeKind(kind: Notice['kind'], input?: string): void {
		const before = this.list.length
		this.list = this.list.filter((x) => !(x.kind === kind && (input === undefined || x.input === input)))
		if (this.list.length !== before) this.changed()
	}

	get(id: string): Notice | undefined {
		return this.list.find((x) => x.id === id)
	}
}

// ---- PFL and solo (monitoring only: the stream and recording are never touched) ----

/** Whether an input's monitoring state counts as PFL on (anything but the device's "off") */
export const pflOn = (inp: InputInfo, m: string = inp.monitor) => !!inp.caps.monitor && m !== inp.caps.monitor.off
const pflState = (inp: InputInfo, on: boolean) => (on ? inp.caps.monitor!.pfl : inp.caps.monitor!.off)

export class Monitoring {
	/** The input being soloed, and everyone's monitoring before it started */
	solo: string | null = null
	#saved = new Map<string, string>()

	constructor(private readonly host: FeatureHost) {}

	async setPfl(inp: InputInfo, on: boolean): Promise<void> {
		if (!inp.caps.monitor) return
		if (this.solo) {
			// while soloed, change what comes back afterwards
			this.#saved.set(inp.id, pflState(inp, on))
			this.host.changed()
			return
		}
		if (on && this.host.pflMode() === 'exclusive') {
			for (const other of this.host.inputs.values()) {
				if (other !== inp && pflOn(other)) await this.host.setMonitor(other, pflState(other, false))
			}
		}
		await this.host.setMonitor(inp, pflState(inp, on))
	}

	async setSolo(inp: InputInfo, on: boolean): Promise<void> {
		if (!inp.caps.monitor) return
		if (on) {
			if (this.solo === inp.id) return
			if (!this.solo) {
				this.#saved.clear()
				for (const i of this.host.inputs.values()) if (i.caps.monitor) this.#saved.set(i.id, i.monitor)
			}
			this.solo = inp.id
			for (const i of this.host.inputs.values()) {
				if (!i.caps.monitor) continue
				const want = pflState(i, i === inp)
				if (i.monitor !== want) await this.host.setMonitor(i, want)
			}
		} else {
			if (this.solo !== inp.id) return
			this.solo = null
			for (const i of this.host.inputs.values()) {
				if (!i.caps.monitor) continue
				const back = this.#saved.get(i.id) ?? i.caps.monitor.off
				if (i.monitor !== back) await this.host.setMonitor(i, back)
			}
			this.#saved.clear()
		}
		this.host.changed()
	}

	/** The PFL state to show for an input (while soloed, what comes back afterwards) */
	pflShown(inp: InputInfo): boolean {
		if (!inp.caps.monitor) return false
		if (this.solo) return pflOn(inp, this.#saved.get(inp.id) ?? inp.caps.monitor.off)
		return pflOn(inp)
	}
}

// ---- backup feeds ------------------------------------------------------------

interface Pair {
	/** backup input name -> its state */
	state: 'normal' | 'on-backup'
	reason: string
	since: number | undefined
	healthySince: number | undefined
	askedAt: number | undefined
	snoozedUntil: number
	/** smoothed incoming levels and the usual difference between them */
	m: number | null
	b: number | null
	offset: number | null
	mainLevel: Db
	backupLevel: Db
}

const peakOf = (inp: InputInfo): Db => inp.prePeak.reduce<Db>((a, x) => (x !== null && (a === null || x > a) ? x : a), null)

export class Backups {
	pairs = new Map<string, Pair>()
	#lastT = 0

	constructor(
		private readonly host: FeatureHost,
		private readonly notices: Notices,
	) {}

	/** The main input a backup is for, if it exists */
	mainOf(backup: InputInfo): InputInfo | undefined {
		const id = String(this.host.settings(backup.id).backupOf ?? '')
		return id && id !== backup.id ? this.host.inputs.get(id) : undefined
	}

	#pair(backupName: string): Pair {
		let p = this.pairs.get(backupName)
		if (!p) {
			p = { state: 'normal', reason: '', since: undefined, healthySince: undefined, askedAt: undefined, snoozedUntil: 0, m: null, b: null, offset: null, mainLevel: 0, backupLevel: null }
			this.pairs.set(backupName, p)
		}
		return p
	}

	/** Called on each meter update */
	check(t: number): void {
		const dt = this.#lastT ? Math.min(1, (t - this.#lastT) / 1000) : 0.05
		this.#lastT = t
		for (const backup of this.host.inputs.values()) {
			const main = this.mainOf(backup)
			if (!main) {
				this.pairs.delete(backup.id)
				continue
			}
			const set = this.host.settings(backup.id)
			const p = this.#pair(backup.id)
			const smooth = (prev: number | null, v: Db) => (v === null ? null : prev === null ? v : prev + (v - prev) * Math.min(1, dt / 0.3))
			p.m = smooth(p.m, peakOf(main))
			p.b = smooth(p.b, peakOf(backup))
			const mainDead = p.m === null || p.m < set.backupDeadDb
			const backupAlive = p.b !== null && p.b >= set.backupDeadDb
			let deviating = false
			if (!mainDead && backupAlive && p.m !== null && p.b !== null) {
				const diff = p.m - p.b
				if (p.offset === null) p.offset = diff
				deviating = Math.abs(diff - p.offset) > set.backupDeviationDb
				if (!deviating && p.state === 'normal') p.offset += (diff - p.offset) * Math.min(1, dt / 10)
			}
			const wrong = backupAlive && (mainDead || deviating)

			if (p.state === 'normal') {
				if (!wrong || !set.backupAuto) {
					p.since = undefined
					continue
				}
				p.since ??= t
				if (t - p.since >= set.backupDetectMs) {
					const why = mainDead ? 'the main dropped out (no signal)' : `the main went ${p.m! - p.b! > (p.offset ?? 0) ? 'much louder' : 'much quieter'} than the backup`
					this.switchToBackup(backup, why)
				}
			} else {
				const healthy = !mainDead && !deviating
				if (!healthy) {
					p.healthySince = undefined
					continue
				}
				p.healthySince ??= t
				if (t - p.healthySince >= set.backupRecoverMs && !p.askedAt && Date.now() >= p.snoozedUntil) {
					p.askedAt = t
					this.notices.add({
						kind: 'backup-back',
						input: backup.id,
						title: `${main.name} is back`,
						message: `${main.name} has looked healthy for ${Math.round(set.backupRecoverMs / 1000)} s. You're still on the backup, ${backup.name}. I won't switch back unless you say so.`,
						actions: [
							{ id: 'take', label: `Take ${main.name}` },
							{ id: 'snooze', label: 'Snooze' },
							{ id: 'swap', label: 'Swap roles' },
							{ id: 'dismiss', label: 'Dismiss' },
						],
					})
				}
			}
		}
	}

	switchToBackup(backup: InputInfo, why: string): void {
		const main = this.mainOf(backup)
		if (!main) return
		const p = this.#pair(backup.id)
		if (p.state === 'on-backup') return
		const set = this.host.settings(backup.id)
		p.state = 'on-backup'
		p.reason = why
		p.mainLevel = main.volumeDb
		p.backupLevel = backup.volumeDb
		p.healthySince = undefined
		p.askedAt = undefined
		p.since = undefined
		this.host.fadeTo(main, null, set.backupFadeMs)
		this.host.fadeTo(backup, p.mainLevel ?? 0, set.backupFadeMs)
		this.host.log('warn', `Switched ${main.name} over to its backup, ${backup.name}: ${why}`)
		this.notices.removeKind('backup-back', backup.id)
		this.notices.add({
			kind: 'backup-switched',
			input: backup.id,
			title: `Switched to the backup: ${backup.name}`,
			message: `${main.name} → ${backup.name} at ${new Date().toLocaleTimeString()}, because ${why}.`,
			actions: [{ id: 'dismiss', label: 'OK' }],
		})
		this.host.changed()
	}

	switchToMain(backup: InputInfo): void {
		const main = this.mainOf(backup)
		const p = this.pairs.get(backup.id)
		if (!main || !p || p.state !== 'on-backup') return
		const set = this.host.settings(backup.id)
		this.host.fadeTo(main, p.mainLevel ?? 0, set.backupFadeMs)
		this.host.fadeTo(backup, p.backupLevel, set.backupFadeMs)
		p.state = 'normal'
		p.since = undefined
		p.offset = null
		this.notices.removeKind('backup-back', backup.id)
		this.notices.removeKind('backup-switched', backup.id)
		this.host.log('info', `Back on ${main.name} again (from the backup, ${backup.name})`)
		this.host.changed()
	}

	/** The backup becomes the main and the main becomes its backup. Nothing moves. */
	swap(backup: InputInfo): void {
		const main = this.mainOf(backup)
		const p = this.pairs.get(backup.id)
		if (!main || !p) return
		const auto = this.host.settings(backup.id).backupAuto
		this.host.setInputSetting(backup.id, 'backupOf', '')
		this.host.setInputSetting(main.id, 'backupOf', backup.id)
		this.host.setInputSetting(main.id, 'backupAuto', auto)
		this.pairs.delete(backup.id)
		const np = this.#pair(main.id)
		np.state = 'normal'
		np.mainLevel = p.backupLevel
		this.notices.removeKind('backup-back', backup.id)
		this.notices.removeKind('backup-switched', backup.id)
		this.host.log('info', `Swapped roles: ${backup.name} is now the main, with ${main.name} as its backup`)
		this.host.changed()
	}

	snooze(backup: InputInfo): void {
		const p = this.pairs.get(backup.id)
		if (!p) return
		p.snoozedUntil = Date.now() + this.host.settings(backup.id).backupSnoozeMs
		p.askedAt = undefined
		p.healthySince = undefined
		this.notices.removeKind('backup-back', backup.id)
	}

	onBackup(backupId: string): boolean {
		return this.pairs.get(backupId)?.state === 'on-backup'
	}
}

// ---- recording ---------------------------------------------------------------

const RECORDING_EXT = /\.(mkv|mp4|mov|flv|ts|m3u8|fmp4|hybrid_mp4|webm|wav|mp3|aac|m4a)$/i

export interface RecordState {
	/** The device can record at all */
	available: boolean
	active: boolean
	paused: boolean
	timecode: string
	lastFile: string
	directory: string
	/** The device's file name (OBS: its file name format) */
	fileName: string
	fileCount: number | null
}

export class Recorder {
	state: RecordState = { available: false, active: false, paused: false, timecode: '', lastFile: '', directory: '', fileName: '', fileCount: null }
	#timer: NodeJS.Timeout
	#promptShownFor = ''

	constructor(
		private readonly host: FeatureHost,
		private readonly notices: Notices,
	) {
		this.state.available = !!host.recording()
		this.#timer = setInterval(() => void this.#tick(), 1000)
	}

	destroy(): void {
		clearInterval(this.#timer)
	}

	#rec(): DeviceRecording {
		const r = this.host.recording()
		if (!r) throw new Error("This device can't record")
		return r
	}

	async refresh(): Promise<void> {
		const r = this.host.recording()
		this.state.available = !!r
		if (!r) return
		try {
			const st = await r.status()
			this.state.active = st.active
			this.state.paused = st.paused
			this.state.timecode = st.timecode
		} catch {
			/* not essential */
		}
		try {
			const d = await r.details()
			if (d.directory !== undefined) this.state.directory = d.directory
			if (d.fileName !== undefined) this.state.fileName = d.fileName
		} catch {
			/* not essential */
		}
		await this.#countFiles()
		this.host.changed()
	}

	async #countFiles(): Promise<void> {
		const dir = this.state.directory
		if (!dir) {
			this.state.fileCount = null
			return
		}
		try {
			const names = await readdir(dir)
			this.state.fileCount = names.filter((n) => RECORDING_EXT.test(n)).length
		} catch {
			this.state.fileCount = null // the device is elsewhere, or the folder can't be read from here
		}
	}

	onEvent(ev: DeviceRecordEvent): void {
		this.state.active = ev.active
		this.state.paused = ev.paused
		if (ev.lastFile) this.state.lastFile = ev.lastFile
		if (ev.edge) void this.#countFiles().then(() => this.host.changed())
		if (this.state.active) {
			// a start satisfies any plan
			const plan = this.host.plan()
			if (plan.nextStart) {
				plan.nextStart = null
				plan.dismissed = false
				plan.snoozedUntil = null
				this.host.savePlan()
			}
			this.notices.removeKind('record-due')
		}
		this.host.changed()
	}

	start(): Promise<void> {
		return Promise.resolve().then(() => this.#rec().start())
	}

	stop(): Promise<void> {
		return Promise.resolve().then(() => this.#rec().stop())
	}

	pause(on: boolean): Promise<void> {
		return Promise.resolve().then(() => {
			const r = this.#rec()
			if (!r.pause) throw new Error("This device can't pause a recording")
			return r.pause(on)
		})
	}

	/** Plan the next start: ISO time (or null to clear), and whether to start by itself */
	setPlan(nextStart: string | null, autoStart: boolean): void {
		const plan = this.host.plan()
		plan.nextStart = nextStart
		plan.autoStart = autoStart
		plan.snoozedUntil = null
		plan.dismissed = false
		this.#promptShownFor = ''
		this.notices.removeKind('record-due')
		this.host.savePlan()
		this.host.changed()
	}

	snoozePrompt(): void {
		const plan = this.host.plan()
		plan.snoozedUntil = new Date(Date.now() + this.host.recordSnoozeMin() * 60000).toISOString()
		this.#promptShownFor = ''
		this.notices.removeKind('record-due')
		this.host.savePlan()
	}

	dismissPrompt(): void {
		const plan = this.host.plan()
		plan.dismissed = true
		this.notices.removeKind('record-due')
		this.host.savePlan()
	}

	async setDirectory(dir: string): Promise<void> {
		const r = this.#rec()
		if (!r.setFolder) throw new Error("This device's recording folder can't be set from here")
		await r.setFolder(dir)
		this.state.directory = dir
		await this.#countFiles()
		this.host.changed()
	}

	/** The device's file name (OBS: a format, e.g. 'Conference %CCYY-%MM-%DD %hh-%mm-%ss') */
	async setFileName(name: string): Promise<void> {
		const r = this.#rec()
		if (!r.setFileName) throw new Error("This device's file name can't be set from here")
		await r.setFileName(name)
		this.state.fileName = name
		this.host.changed()
	}

	/** Seconds until the planned start, or null */
	countdown(): number | null {
		const plan = this.host.plan()
		if (!plan.nextStart) return null
		return Math.round((Date.parse(plan.nextStart) - Date.now()) / 1000)
	}

	async #tick(): Promise<void> {
		const r = this.host.recording()
		if (!r || !this.host.connected()) return
		if (this.state.active) {
			try {
				const st = await r.status()
				this.state.timecode = st.timecode
				this.state.paused = st.paused
				this.host.changed()
			} catch {
				/* next time */
			}
			return
		}
		const plan = this.host.plan()
		if (!plan.nextStart) return
		const due = Date.parse(plan.nextStart)
		const now = Date.now()
		if (plan.autoStart) {
			if (now >= due) {
				this.host.log('info', 'Starting the planned recording, as booked')
				try {
					await this.start()
				} catch (e) {
					this.host.log('warn', `Couldn't start the planned recording, so it's not rolling: ${(e as Error).message}`)
				}
			}
			return
		}
		const lead = this.host.recordLeadMin() * 60000
		const snoozed = plan.snoozedUntil && Date.parse(plan.snoozedUntil) > now
		if (now >= due - lead && !plan.dismissed && !snoozed && this.#promptShownFor !== plan.nextStart + (plan.snoozedUntil ?? '')) {
			this.#promptShownFor = plan.nextStart + (plan.snoozedUntil ?? '')
			const at = new Date(due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			this.notices.add({
				kind: 'record-due',
				title: 'Start recording?',
				message: now >= due ? `Recording was due to start at ${at}. Shall we?` : `Recording is due to start at ${at}.`,
				actions: [
					{ id: 'start', label: 'Start recording' },
					{ id: 'snooze', label: `Snooze ${this.host.recordSnoozeMin()} min` },
					{ id: 'newtime', label: 'Set a new time' },
					{ id: 'dismiss', label: 'Dismiss' },
				],
			})
		}
	}
}
