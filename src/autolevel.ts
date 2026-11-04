/**
 * Auto gain for one input: auto level (once called "the rider"), "this level
 * please" and calibrate.
 *
 * Where it measures:
 *   fader mode - after the fader (what's recorded), and it moves the fader.
 *   trim mode  - before the fader (after the trim), and it moves the trim,
 *                so the fader stays the operator's.
 *
 * To avoid chasing its own moves, every meter sample is turned into the
 * incoming level with the current gains taken off ("x"). The window averages
 * x, and the predicted level is that average plus today's gains, so a move
 * shows straight away instead of after the window catches up.
 */

import { type Db, clamp, dbToPow, mulToDb, powToDb } from './law.js'
import type { InputRecord, InputSettings } from './settings.js'

export type AutoLevelState = 'off' | 'holding' | 'riding' | 'frozen' | 'limit' | 'capturing' | 'calibrating'

export const AUTOLEVEL_STATES: { id: AutoLevelState; label: string }[] = [
	{ id: 'off', label: 'Off' },
	{ id: 'holding', label: 'Holding (inside the band)' },
	{ id: 'riding', label: 'Riding (moving the level)' },
	{ id: 'frozen', label: 'Frozen (quiet, muted or paused)' },
	{ id: 'limit', label: 'At a limit' },
	{ id: 'capturing', label: 'Capturing a level' },
	{ id: 'calibrating', label: 'Calibrating' },
]

/** One meter reading for an input. Levels are linear multipliers per channel. */
export interface MeterSample {
	t: number
	/** Post-fader magnitude per channel */
	mag: number[]
	/** Pre-fader peak per channel (after filters, so after the trim) */
	prePeak: number[]
	faderDb: Db
	trimDb: number
	muted: boolean
}

export interface AutoLevelIO {
	settings(): InputSettings
	record(): InputRecord
	/** The record's target/refGain changed: save it */
	saveRecord(): void
	/** Move the controlled gain (fader or trim, per settings), dB */
	setGain(db: number): void
	/** The range the controlled gain (fader or trim) can go to, dB */
	gainRange(mode: 'fader' | 'trim'): [number, number]
	/** Turn this input's auto level off (grab mode 'off') */
	autoLevelOff(): void
	log(level: 'info' | 'warn', msg: string): void
	changed(): void
}

interface Pending {
	kind: 'capture' | 'calibrate'
	until: number
	xs: number[]
	level?: number
}

function combine(values: number[], mode: 'max' | 'avg'): Db {
	if (values.length === 0) return null
	if (mode === 'max') return mulToDb(Math.max(...values))
	const p = values.reduce((a, v) => a + v * v, 0) / values.length
	return powToDb(p)
}

export class AutoLevel {
	readonly #io: AutoLevelIO
	#window: { t: number; x: number }[] = []
	#last: MeterSample | undefined
	#lastT = 0
	#riding = false
	#quietSince: number | undefined
	#pausedUntil = 0
	#touching = false
	#pending: Pending | undefined
	#calGoal: number | undefined
	state: AutoLevelState = 'off'
	/** Predicted level at the measuring point, dB, for display */
	level: Db = null
	/** Current controlled gain, dB */
	gain: number | null = null

	constructor(io: AutoLevelIO) {
		this.#io = io
	}

	/** The gain auto level moves, from a sample */
	#controlGain(s: MeterSample, set: InputSettings): number | null {
		return set.controlMode === 'trim' ? s.trimDb : s.faderDb
	}

	/** The incoming level with the gains taken off, or undefined if it can't be known */
	#x(s: MeterSample, set: InputSettings): number | undefined {
		if (set.measure === 'peak') {
			const pre = combine(s.prePeak, set.stereo)
			return pre === null ? undefined : pre - s.trimDb
		}
		const mag = combine(s.mag, set.stereo)
		if (mag === null || s.faderDb === null || s.muted) return undefined
		return mag - s.faderDb - s.trimDb
	}

	/** Level at the measuring point for an incoming level x, with the sample's gains */
	#atPoint(x: number, s: MeterSample, set: InputSettings): Db {
		if (set.controlMode === 'trim') return x + s.trimDb
		return s.faderDb === null ? null : x + s.faderDb + s.trimDb
	}

	#aggregate(xs: number[], set: InputSettings): number | undefined {
		if (xs.length === 0) return undefined
		if (set.measure === 'peak') return Math.max(...xs)
		const p = xs.reduce((a, x) => a + dbToPow(x), 0) / xs.length
		return powToDb(p) ?? undefined
	}

	#limits(set: InputSettings): [number, number] {
		const rec = this.#io.record()
		const hw = this.#io.gainRange(set.controlMode)
		let lo = Math.max(hw[0], set.floorDb)
		let hi = Math.min(hw[1], set.ceilingDb)
		if (rec.refGain !== null) {
			lo = Math.max(lo, rec.refGain - set.maxCutDb)
			hi = Math.min(hi, rec.refGain + set.maxBoostDb)
		}
		if (lo > hi) lo = hi
		return [lo, hi]
	}

	#isQuiet(s: MeterSample, set: InputSettings): boolean {
		const pre = combine(s.prePeak, set.stereo)
		if (pre === null) return true
		return pre - s.trimDb < set.quietThresholdDb
	}

	#move(to: number): void {
		this.gain = to
		this.#io.setGain(to)
	}

	/** Glide the gain towards `goal` at `rate` dB/s; true when there */
	#glide(goal: number, rate: number, dt: number): boolean {
		const g = this.gain
		if (g === null) return true
		const diff = goal - g
		if (Math.abs(diff) < 0.01) return true
		const step = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt)
		this.#move(g + step)
		return Math.abs(goal - (g + step)) < 0.01
	}

	onMeter(s: MeterSample): void {
		const set = this.#io.settings()
		const dt = this.#lastT ? Math.min(0.25, Math.max(0, (s.t - this.#lastT) / 1000)) : 0.05
		this.#lastT = s.t
		this.#last = s
		this.gain = this.#controlGain(s, set)
		const before = this.state

		const quiet = s.muted || this.#isQuiet(s, set)
		const x = quiet ? undefined : this.#x(s, set)
		if (x !== undefined) this.#window.push({ t: s.t, x })
		while (this.#window.length && s.t - this.#window[0].t > set.measureWindowMs) this.#window.shift()
		const agg = this.#aggregate(
			this.#window.map((w) => w.x),
			set,
		)
		this.level = agg === undefined ? null : this.#atPoint(agg, s, set)

		if (this.#pending) {
			if (x !== undefined) this.#pending.xs.push(x)
			if (s.t >= this.#pending.until) this.#finishPending(s, set)
			else this.state = this.#pending.kind === 'capture' ? 'capturing' : 'calibrating'
			if (this.state !== before) this.#io.changed()
			return
		}

		if (this.#calGoal !== undefined) {
			this.state = 'calibrating'
			if (this.#glide(this.#calGoal, set.calibrateRateDbPerS, dt)) this.#calGoal = undefined
			if (this.state !== before) this.#io.changed()
			return
		}

		this.state = this.#ride(s, set, quiet, agg, dt)
		if (this.state !== before) this.#io.changed()
	}

	#ride(s: MeterSample, set: InputSettings, quiet: boolean, agg: number | undefined, dt: number): AutoLevelState {
		const rec = this.#io.record()
		if (!set.autoLevelOn || rec.target === null) {
			this.#riding = false
			return 'off'
		}
		if (this.gain === null) return 'frozen' // fader at -inf: nothing to ride from
		if (s.muted || this.#touching || s.t < this.#pausedUntil) {
			this.#riding = false
			return 'frozen'
		}
		if (quiet) {
			this.#riding = false
			this.#quietSince ??= s.t
			if (set.quietMode === 'drift' && rec.refGain !== null && s.t - this.#quietSince >= set.quietDriftAfterMs) {
				this.#glide(clamp(rec.refGain, ...this.#limits(set)), set.driftRateDbPerS, dt)
			}
			return 'frozen'
		}
		this.#quietSince = undefined
		if (agg === undefined || this.#window.length < 5) return 'holding'

		const level = this.#atPoint(agg, s, set)
		if (level === null) return 'frozen'
		const err = rec.target - level
		if (!this.#riding && Math.abs(err) > set.bandDb) this.#riding = true
		if (!this.#riding) return 'holding'
		const done = set.rideBack === 'target' ? Math.abs(err) <= set.settleDb : Math.abs(err) <= set.bandDb
		if (done) {
			this.#riding = false
			return 'holding'
		}
		const [lo, hi] = this.#limits(set)
		const want = this.gain + Math.sign(err) * Math.min(Math.abs(err), set.rideRateDbPerS * dt)
		const to = clamp(want, lo, hi)
		if (Math.abs(to - this.gain) < 0.005) return 'limit'
		this.#move(to)
		return to !== want ? 'limit' : 'riding'
	}

	#finishPending(s: MeterSample, set: InputSettings): void {
		const p = this.#pending!
		this.#pending = undefined
		const agg = this.#aggregate(p.xs, set)
		if (agg === undefined) {
			this.#io.log('warn', `Nothing to measure (input quiet or muted), so the ${p.kind === 'capture' ? 'level' : 'calibrate'} wasn't taken`)
			this.state = 'off'
			return
		}
		const rec = this.#io.record()
		if (p.kind === 'capture') {
			const level = this.#atPoint(agg, s, set)
			if (level === null) {
				this.#io.log('warn', 'The fader is at -inf, so there is no level to capture')
				return
			}
			rec.target = level
			rec.refGain = this.#controlGain(s, set)
			this.#riding = false
			this.#io.saveRecord()
			this.#io.log('info', `Target set to ${level.toFixed(1)} dB`)
			return
		}
		// calibrate: the gain that puts the level at p.level
		const level = p.level!
		const other = set.controlMode === 'trim' ? 0 : s.trimDb
		const hw = this.#io.gainRange(set.controlMode)
		const goal = clamp(level - agg - other, Math.max(hw[0], set.floorDb), Math.min(hw[1], set.ceilingDb))
		if (set.calibrateMove === 'jump' || this.gain === null) this.#move(goal)
		else this.#calGoal = goal
		if (set.calibrateSetsTarget) {
			rec.target = level
			rec.refGain = goal
			this.#riding = false
			this.#io.saveRecord()
		}
		this.#io.log('info', `Calibrating to ${level.toFixed(1)} dB (gain ${goal.toFixed(1)} dB)`)
	}

	#start(kind: 'capture' | 'calibrate', level?: number): void {
		const set = this.#io.settings()
		this.#calGoal = undefined
		const now = this.#last?.t ?? Date.now()
		if (set.captureMode === 'instant') {
			// the last half second, or the latest reading
			const recent = this.#window.filter((w) => now - w.t <= 500).map((w) => w.x)
			const xs = recent.length ? recent : this.#window.slice(-1).map((w) => w.x)
			this.#pending = { kind, until: now, xs, level }
			if (this.#last) this.#finishPending(this.#last, set)
			else this.#pending = undefined
			this.#io.changed()
			return
		}
		this.#pending = { kind, until: now + set.captureWindowMs, xs: [], level }
		this.state = kind === 'capture' ? 'capturing' : 'calibrating'
		this.#io.changed()
	}

	/** "This level please" */
	captureTarget(): void {
		this.#start('capture')
	}

	calibrate(level: number): void {
		this.#start('calibrate', level)
	}

	cancel(): void {
		this.#pending = undefined
		this.#calGoal = undefined
		this.#io.changed()
	}

	/**
	 * Someone moved the controlled gain by hand (web page, Grid, the desk
	 * itself, another button). Applies the grab setting.
	 */
	manualMove(oldGain: number | null, newGain: number | null): void {
		const set = this.#io.settings()
		this.#calGoal = undefined
		if (!set.autoLevelOn) return
		const rec = this.#io.record()
		if (set.grab === 'off') {
			this.#io.autoLevelOff()
			return
		}
		if (set.grab === 'pause') {
			this.#pausedUntil = (this.#last?.t ?? Date.now()) + set.grabPauseMs
			this.#riding = false
			return
		}
		// retarget: the level follows the move, so the target moves with it
		if (rec.target !== null && oldGain !== null && newGain !== null) {
			rec.target += newGain - oldGain
			rec.refGain = newGain
			this.#riding = false
			this.#io.saveRecord()
		}
	}

	/** Web page fader touched / released: auto level holds off while it's held */
	touch(on: boolean): void {
		this.#touching = on
		if (!on) this.#pausedUntil = 0
	}

	/** Start afresh, e.g. after the control mode changes */
	reset(): void {
		this.#window = []
		this.#riding = false
		this.#pending = undefined
		this.#calGoal = undefined
		this.#quietSince = undefined
	}
}
