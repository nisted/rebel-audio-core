/**
 * Everything a module remembers: module-wide settings, the page-wide
 * defaults each input starts from, per-input overrides and per-input state.
 * The module saves it into its Companion connection's config, so it survives
 * restarts, travels with a Companion export and with Companion Sync.
 *
 * The core owns the auto level, calibrate and backup settings; a device adds
 * its own per-input settings (DeviceInfo.inputFields), stored the same way.
 * Everything is checked against a StoreSchema made from both.
 *
 * Store versions: 1 = before the rename (riderOn, 'sync'/'tracks' controls);
 * 2 = auto level. loadStore() migrates a version 1 store by itself.
 */

import type { LawKind } from './law.js'
import type { DeviceField, DeviceInfo } from './device.js'

export type ControlMode = 'fader' | 'trim'
export type Measure = 'rms' | 'peak'
export type StereoMode = 'max' | 'avg'
export type CaptureMode = 'average' | 'instant'
export type RideBack = 'target' | 'band'
export type QuietMode = 'freeze' | 'drift'
export type MoveMode = 'glide' | 'jump'
export type GrabMode = 'retarget' | 'pause' | 'off'
export type SectionMode = 'hidden' | 'open' | 'collapsible'

/** Per-input settings from the core. The defaults hold every one; inputs override some. */
export interface CoreInputSettings {
	autoLevelOn: boolean
	controlMode: ControlMode
	measure: Measure
	measureWindowMs: number
	stereo: StereoMode
	captureMode: CaptureMode
	captureWindowMs: number
	bandDb: number
	rideBack: RideBack
	rideRateDbPerS: number
	settleDb: number
	maxBoostDb: number
	maxCutDb: number
	floorDb: number
	ceilingDb: number
	quietMode: QuietMode
	quietThresholdDb: number
	quietDriftAfterMs: number
	driftRateDbPerS: number
	calibrateDb: number
	calibrateSetsTarget: boolean
	calibrateMove: MoveMode
	calibrateRateDbPerS: number
	grab: GrabMode
	grabPauseMs: number
	backupOf: string
	backupAuto: boolean
	backupDeadDb: number
	backupDeviationDb: number
	backupDetectMs: number
	backupFadeMs: number
	backupRecoverMs: number
	backupSnoozeMs: number
}

/** Core settings plus the device's own (looked up by key) */
export type InputSettings = CoreInputSettings & { [key: string]: unknown }

export const INPUT_DEFAULTS: CoreInputSettings = {
	autoLevelOn: false,
	controlMode: 'fader',
	measure: 'rms',
	measureWindowMs: 2000,
	stereo: 'max',
	captureMode: 'average',
	captureWindowMs: 3000,
	bandDb: 3,
	rideBack: 'target',
	rideRateDbPerS: 2,
	settleDb: 0.5,
	maxBoostDb: 6,
	maxCutDb: 10,
	floorDb: -40,
	ceilingDb: 10,
	quietMode: 'freeze',
	quietThresholdDb: -50,
	quietDriftAfterMs: 10000,
	driftRateDbPerS: 1,
	calibrateDb: -18,
	calibrateSetsTarget: true,
	calibrateMove: 'glide',
	calibrateRateDbPerS: 6,
	grab: 'retarget',
	grabPauseMs: 3000,
	backupOf: '',
	backupAuto: false,
	backupDeadDb: -60,
	backupDeviationDb: 12,
	backupDetectMs: 1500,
	backupFadeMs: 500,
	backupRecoverMs: 5000,
	backupSnoozeMs: 300000,
}

export interface FieldInfo {
	label: string
	type: 'bool' | 'number' | 'choice' | 'text' | 'input'
	min?: number
	max?: number
	step?: number
	unit?: string
	choices?: { id: string; label: string }[]
	/** Tooltip: what it does, in plain words */
	help: string
	/** Which group it's shown in on the page */
	group: string
}

/** Labels, ranges, choices and tooltips for each input setting: used by actions and the web page */
export const INPUT_FIELDS: Record<keyof CoreInputSettings, FieldInfo> = {
	autoLevelOn: { label: 'Auto level on', type: 'bool', group: 'autolevel', help: 'Keeps this input near its target level by moving the fader (or trim) for you. Like having an op ride it, minus the tea breaks.' },
	controlMode: {
		label: 'Auto gain moves',
		type: 'choice',
		group: 'autolevel',
		choices: [
			{ id: 'fader', label: 'Fader' },
			{ id: 'trim', label: 'Trim' },
		],
		help: 'What auto gain gets its hands on. Fader: rides the fader and measures after it. Trim: rides the trim before the fader, so the fader stays yours.',
	},
	measure: {
		label: 'Auto level listens to',
		type: 'choice',
		group: 'autolevel',
		choices: [
			{ id: 'rms', label: 'Average level' },
			{ id: 'peak', label: 'Peaks' },
		],
		help: 'Average level follows loudness the way your ears do and shrugs off single loud moments. Peaks reacts to every transient, so it moves more often.',
	},
	measureWindowMs: { label: 'Listening window', type: 'number', group: 'autolevel', min: 100, max: 30000, step: 100, unit: 'ms', help: 'How much recent audio auto level averages before it makes its mind up. Longer = calmer, but slower to react.' },
	stereo: {
		label: 'Stereo',
		type: 'choice',
		group: 'autolevel',
		choices: [
			{ id: 'max', label: 'Louder side' },
			{ id: 'avg', label: 'Both sides averaged' },
		],
		help: 'For stereo inputs: follow the louder side (keeps the image, moves both together) or the average of both.',
	},
	bandDb: { label: 'Leave alone within ±', type: 'number', group: 'autolevel', min: 0, max: 30, step: 0.5, unit: 'dB', help: 'How far the level can wander from the target before auto level steps in. Inside this band, nothing moves.' },
	rideBack: {
		label: 'When it rides, go back',
		type: 'choice',
		group: 'autolevel',
		choices: [
			{ id: 'target', label: 'All the way to the target' },
			{ id: 'band', label: 'Just inside the band' },
		],
		help: 'All the way: rides until the level is back on the target. Just inside: stops as soon as it\'s back in the band (smaller, fewer moves).',
	},
	rideRateDbPerS: { label: 'Riding speed', type: 'number', group: 'autolevel', min: 0.1, max: 60, step: 0.1, unit: 'dB/s', help: 'How fast auto level moves the fader. Slow is gentle and harder to hear; fast catches big changes sooner.' },
	settleDb: { label: 'Close enough within', type: 'number', group: 'autolevel', min: 0.1, max: 10, step: 0.1, unit: 'dB', help: 'How close to the target counts as close enough, so it can stop moving.' },
	grab: {
		label: 'If you move the fader',
		type: 'choice',
		group: 'autolevel',
		choices: [
			{ id: 'retarget', label: 'Where you leave it is the new target' },
			{ id: 'pause', label: 'Auto level pauses, same target' },
			{ id: 'off', label: 'Auto level switches off' },
		],
		help: 'What happens when you (or anyone else) move the fader while auto level is on.',
	},
	grabPauseMs: { label: 'Pause after an outside move', type: 'number', group: 'autolevel', min: 0, max: 60000, step: 100, unit: 'ms', help: 'With "Auto level pauses": how long it waits after someone else moves the fader before it starts riding again.' },
	captureMode: {
		label: '"This level please" takes',
		type: 'choice',
		group: 'capture',
		choices: [
			{ id: 'average', label: 'An average over a few seconds' },
			{ id: 'instant', label: 'The level right now' },
		],
		help: 'How the target is captured when you press "This level please" (or calibrate). An average won\'t be thrown by one loud or quiet moment.',
	},
	captureWindowMs: { label: 'Averaging time', type: 'number', group: 'capture', min: 100, max: 30000, step: 100, unit: 'ms', help: 'How long it listens for when capturing an average.' },
	maxBoostDb: { label: 'Never boost more than', type: 'number', group: 'limits', min: 0, max: 60, step: 0.5, unit: 'dB', help: 'The most auto level will push up from where the target was set. Stops it chasing a dead mic all the way to full gain.' },
	maxCutDb: { label: 'Never cut more than', type: 'number', group: 'limits', min: 0, max: 100, step: 0.5, unit: 'dB', help: 'The most auto level will pull down from where the target was set.' },
	floorDb: { label: 'Never below', type: 'number', group: 'limits', min: -100, max: 26, step: 0.5, unit: 'dB', help: 'The lowest fader (or trim) setting auto level is ever allowed, full stop.' },
	ceilingDb: { label: 'Never above', type: 'number', group: 'limits', min: -100, max: 26, step: 0.5, unit: 'dB', help: 'The highest fader (or trim) setting auto level is ever allowed, full stop.' },
	quietMode: {
		label: 'When the input goes quiet',
		type: 'choice',
		group: 'quiet',
		choices: [
			{ id: 'freeze', label: 'Hold still' },
			{ id: 'drift', label: 'Hold, then drift back to the set point' },
		],
		help: 'In pauses (nobody talking) auto level holds still rather than cranking up into silence. Drift back slowly returns it to where the target was set if the quiet goes on.',
	},
	quietThresholdDb: { label: 'Quiet means below', type: 'number', group: 'quiet', min: -100, max: 0, step: 1, unit: 'dB', help: 'Below this incoming level (peak, before trim and fader), the input counts as quiet.' },
	quietDriftAfterMs: { label: 'Drift back after', type: 'number', group: 'quiet', min: 0, max: 600000, step: 500, unit: 'ms', help: 'With "Hold, then drift back": how long it has to stay quiet before drifting.' },
	driftRateDbPerS: { label: 'Drift speed', type: 'number', group: 'quiet', min: 0.1, max: 60, step: 0.1, unit: 'dB/s', help: 'How fast it drifts back. Gently does it.' },
	calibrateDb: { label: 'Calibrate this input to', type: 'number', group: 'calibrate', min: -60, max: 10, step: 0.5, unit: 'dB', help: 'The level a double tap (or the "Cal" button) brings this input to.' },
	calibrateSetsTarget: { label: 'Calibrate also sets the target', type: 'bool', group: 'calibrate', help: 'After calibrating, auto level holds that level (until you next press "This level please").' },
	calibrateMove: {
		label: 'Calibrate moves by',
		type: 'choice',
		group: 'calibrate',
		choices: [
			{ id: 'glide', label: 'Gliding there' },
			{ id: 'jump', label: 'Jumping there' },
		],
		help: 'Glide moves the fader smoothly; jump gets it there straight away.',
	},
	calibrateRateDbPerS: { label: 'Calibrate glide speed', type: 'number', group: 'calibrate', min: 0.1, max: 100, step: 0.5, unit: 'dB/s', help: 'How fast a calibrate glides.' },
	backupOf: { label: 'This is the backup for', type: 'input', group: 'backup', help: 'Make this input the backup feed for another input (the main). Its fader normally sits down; on a switch, it takes over.' },
	backupAuto: { label: 'Switch to backup automatically', type: 'bool', group: 'backup', help: 'If the main drops out, or goes very high or low while this backup looks healthy, I crossfade to this backup and tell you what happened. I never switch back by myself.' },
	backupDeadDb: { label: 'Main counts as dropped below', type: 'number', group: 'backup', min: -100, max: 0, step: 1, unit: 'dB', help: 'If the main\'s incoming level stays below this while the backup is above it, the main counts as dropped.' },
	backupDeviationDb: { label: 'Or differs from backup by more than', type: 'number', group: 'backup', min: 1, max: 60, step: 1, unit: 'dB', help: 'Main and backup normally sit at a steady difference. If the main strays this far from that (very high or very low), something\'s up.' },
	backupDetectMs: { label: 'For at least', type: 'number', group: 'backup', min: 100, max: 60000, step: 100, unit: 'ms', help: 'How long the main has to look wrong before switching, so one little glitch doesn\'t set it off.' },
	backupFadeMs: { label: 'Crossfade time', type: 'number', group: 'backup', min: 0, max: 10000, step: 50, unit: 'ms', help: 'How long the crossfade between main and backup takes (no clicks, please).' },
	backupRecoverMs: { label: 'Main counts as back after', type: 'number', group: 'backup', min: 500, max: 600000, step: 500, unit: 'ms', help: 'How long the main has to look healthy again before I ask whether you want it back.' },
	backupSnoozeMs: { label: 'Snooze asks again after', type: 'number', group: 'backup', min: 10000, max: 3600000, step: 10000, unit: 'ms', help: 'When you snooze the "main is back" question, how long before I ask again.' },
}

export const INPUT_SETTING_KEYS = Object.keys(INPUT_DEFAULTS) as (keyof CoreInputSettings)[]

/** Generic controls that can be placed in strip sections. Processing kinds come from the device. */
export const CORE_CONTROLS: { id: string; label: string }[] = [
	{ id: 'mute', label: 'Mute' },
	{ id: 'monitor', label: 'Monitoring' },
	{ id: 'balance', label: 'Balance' },
	{ id: 'delay', label: 'Delay / sync offset' },
	{ id: 'trim', label: 'Trim' },
	{ id: 'mixOption', label: 'Mix option (on / off / AFV)' },
	{ id: 'backup', label: 'Backup feed' },
	{ id: 'routing', label: 'Routing / recording tracks' },
]

/** Control ids renamed in store version 2 */
const CONTROL_RENAMES: Record<string, string> = { sync: 'delay', tracks: 'routing' }

export interface Section {
	id: string
	name: string
	controls: string[]
	mode: SectionMode
}

/** What the store is checked against: the core's settings plus a device's */
export interface StoreSchema {
	fields: Record<string, FieldInfo>
	defaults: InputSettings
	controls: { id: string; label: string }[]
	starter: Section[]
}

/** The schema for a device (none = the core's settings only) */
export function makeSchema(info?: Pick<DeviceInfo, 'processing' | 'inputFields'> & { routingLabel?: string }): StoreSchema {
	const extra: Record<string, DeviceField> = info?.inputFields ?? {}
	const fields: Record<string, FieldInfo> = { ...INPUT_FIELDS }
	const defaults: InputSettings = { ...INPUT_DEFAULTS }
	for (const [k, f] of Object.entries(extra)) {
		const { default: def, resetsAutoLevel: _r, ...field } = f
		fields[k] = field
		defaults[k] = def
	}
	const processing = info?.processing ?? []
	const controls = [...CORE_CONTROLS, ...processing.map((p) => ({ id: p.kind, label: p.label }))]
	const starter: Section[] = [
		{ id: 'input', name: 'Input', controls: ['trim', 'balance', 'delay', 'mixOption', 'backup'], mode: 'collapsible' },
	]
	const proc = processing.filter((p) => p.inStarter !== false).map((p) => p.kind)
	if (proc.length) starter.push({ id: 'processing', name: 'Processing', controls: proc, mode: 'collapsible' })
	starter.push({ id: 'tracks', name: info?.routingLabel ?? 'Routing', controls: ['routing'], mode: 'collapsible' })
	return { fields, defaults, controls, starter }
}

const CORE_SCHEMA = makeSchema()

export interface PageSettings {
	layout: 'strips' | 'rows'
	law: LawKind
	faderTopDb: number
	faderBottomDb: number
	meterFloorDb: number
	meterTopDb: number
	showPre: boolean
	showPost: boolean
	peakHoldMs: number
	peakFallDbPerS: number
	greenToDb: number
	yellowToDb: number
	greenColour: string
	yellowColour: string
	redColour: string
	bandColour: string
	ridingColour: string
	targetColour: string
	meterRateHz: number
	fineRatio: number
	doubleTapUnity: boolean
	accentColour: string
	pflMode: 'additive' | 'exclusive'
	soloLatch: boolean
	tooltips: boolean
	tipsOnOpen: boolean
	recordLeadMin: number
	recordSnoozeMin: number
	/** Unlit parts of the meters show their colour zones faintly */
	meterPaleBack: boolean
	/** How strong the faint zone colours are (0 = black, 1 = full colour) */
	meterPaleStrength: number
	/** The fader's dB markings: left or right of the fader */
	faderScaleSide: 'left' | 'right'
	/** The meters' dB markings: left or right of the meters */
	meterScaleSide: 'left' | 'right'
	/** The fader cap's colour */
	capColour: string
	/** The bright line across the middle of the fader cap */
	capLineColour: string
}

export const PAGE_DEFAULTS: PageSettings = {
	layout: 'strips',
	law: 'desk',
	faderTopDb: 10,
	faderBottomDb: -60,
	meterFloorDb: -60,
	meterTopDb: 0,
	showPre: true,
	showPost: true,
	peakHoldMs: 2000,
	peakFallDbPerS: 20,
	greenToDb: -18,
	yellowToDb: -6,
	greenColour: '#4fe07a',
	yellowColour: '#ffd84a',
	redColour: '#ff5a4a',
	bandColour: '#7a2fe0',
	ridingColour: '#5cd8f5',
	targetColour: '#ffffff',
	meterRateHz: 20,
	fineRatio: 0.2,
	doubleTapUnity: true,
	accentColour: '#7a2fe0',
	pflMode: 'additive',
	soloLatch: false,
	tooltips: true,
	tipsOnOpen: true,
	recordLeadMin: 10,
	recordSnoozeMin: 5,
	meterPaleBack: true,
	meterPaleStrength: 0.22,
	faderScaleSide: 'left',
	meterScaleSide: 'right',
	capColour: '#7a2fe0',
	capLineColour: '#ffffff',
}

export interface GestureSettings {
	doubleTapMs: number
	holdMs: number
}

export const GESTURE_DEFAULTS: GestureSettings = { doubleTapMs: 300, holdMs: 800 }

/** What's remembered for each input, keyed by the input's id */
export interface InputRecord {
	/** Only the settings that differ from the page-wide defaults */
	overrides: Partial<InputSettings>
	/** Per-input overrides of section modes: section id -> mode */
	sections: Record<string, SectionMode>
	/** Auto level target, dB at the measuring point (post-fader in fader mode, pre-fader in trim mode) */
	target: number | null
	/** Control gain when the target was set: the relative limits are measured from here */
	refGain: number | null
}

export const STORE_VERSION = 2

export interface Store {
	version: 2
	defaults: InputSettings
	page: PageSettings
	gestures: GestureSettings
	/** Calibrate level for press-and-hold */
	moduleCalibrateDb: number
	sections: Section[]
	/** Input display order (ids); inputs not listed follow in the device's order */
	order: string[]
	hidden: string[]
	inputs: Record<string, InputRecord>
	/** The next planned recording start, if any */
	record: RecordPlan
	/** Recordings: sheet naming, file manager and upload settings, plus the saved queue (see recordings-feature.ts) */
	recordings: RecordingsStore
}

/**
 * What's kept for recordings. `settings` is the recordings library's (partial,
 * defaults fill the rest); `saved` is its queue, last good sheet copy and row.
 */
export interface RecordingsStore {
	/** Name, rename and upload recordings (off = the device names its files as it always has) */
	enabled: boolean
	/** Where this computer finds the recordings folder, when it isn't where the device says (blank = the device's folder) */
	folderOverride: string
	/** After a take has started with our name, put the device's own file name setting back */
	restoreName: boolean
	settings: Record<string, Record<string, unknown>>
	saved: Record<string, unknown> | null
}

export const RECORDINGS_STORE_DEFAULTS: RecordingsStore = { enabled: false, folderOverride: '', restoreName: true, settings: {}, saved: null }

export interface RecordPlan {
	/** ISO time the recording is due to (re)start, or null */
	nextStart: string | null
	/** Start it automatically at that time */
	autoStart: boolean
	/** The "Start recording?" prompt is snoozed until this ISO time */
	snoozedUntil: string | null
	/** The prompt was dismissed for this nextStart */
	dismissed: boolean
}

export const RECORD_DEFAULTS: RecordPlan = { nextStart: null, autoStart: false, snoozedUntil: null, dismissed: false }

export function newStore(schema: StoreSchema = CORE_SCHEMA): Store {
	return {
		version: STORE_VERSION,
		defaults: { ...schema.defaults },
		page: { ...PAGE_DEFAULTS },
		gestures: { ...GESTURE_DEFAULTS },
		moduleCalibrateDb: -18,
		sections: schema.starter.map((s) => ({ ...s, controls: [...s.controls] })),
		order: [],
		hidden: [],
		inputs: {},
		record: { ...RECORD_DEFAULTS },
		recordings: { ...RECORDINGS_STORE_DEFAULTS, settings: {} },
	}
}

function obj(x: unknown): Record<string, unknown> {
	return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
}

/** Keep only known keys of the right type, filling the rest from `base` */
function sanitize<T extends object>(raw: unknown, base: T, partial = false): Partial<T> {
	const src = obj(raw)
	const out: Partial<T> = partial ? {} : { ...base }
	for (const key of Object.keys(base) as (keyof T)[]) {
		const v = src[key as string]
		if (v === undefined) continue
		if (typeof v === typeof base[key]) out[key] = v as T[keyof T]
	}
	return out
}

export function sanitizeInputOverrides(raw: unknown, schema: StoreSchema = CORE_SCHEMA): Partial<InputSettings> {
	return sanitize(raw, schema.defaults, true)
}

function sanitizeSection(raw: unknown, i: number, schema: StoreSchema): Section | null {
	const s = obj(raw)
	const mode = s.mode === 'hidden' || s.mode === 'open' || s.mode === 'collapsible' ? s.mode : 'collapsible'
	const known = new Set(schema.controls.map((c) => c.id))
	return {
		id: typeof s.id === 'string' && s.id ? s.id : `section${i + 1}`,
		name: typeof s.name === 'string' ? s.name : `Section ${i + 1}`,
		controls: Array.isArray(s.controls) ? s.controls.filter((c): c is string => typeof c === 'string' && known.has(c)) : [],
		mode,
	}
}

function sanitizeRecord(raw: unknown, schema: StoreSchema): InputRecord {
	const r = obj(raw)
	const sections: Record<string, SectionMode> = {}
	for (const [k, v] of Object.entries(obj(r.sections))) {
		if (v === 'hidden' || v === 'open' || v === 'collapsible') sections[k] = v
	}
	return {
		overrides: sanitizeInputOverrides(r.overrides, schema),
		sections,
		target: typeof r.target === 'number' ? r.target : null,
		refGain: typeof r.refGain === 'number' ? r.refGain : null,
	}
}

/** Rename a key in an object, if it's there and the new one isn't */
function renameKey(o: unknown, from: string, to: string): void {
	const x = obj(o)
	if (from in x) {
		if (!(to in x)) x[to] = x[from]
		delete x[from]
	}
}

/**
 * Bring an older store up to date (in place, on a parsed copy). Version 1 had
 * the "rider": riderOn becomes autoLevelOn, and the 'sync' / 'tracks' section
 * controls become 'delay' / 'routing'.
 */
export function migrateStore(src: Record<string, unknown>): Record<string, unknown> {
	const version = typeof src.version === 'number' ? src.version : 1
	if (version < 2) {
		renameKey(src.defaults, 'riderOn', 'autoLevelOn')
		for (const rec of Object.values(obj(src.inputs))) renameKey(obj(rec).overrides, 'riderOn', 'autoLevelOn')
		if (Array.isArray(src.sections)) {
			for (const sec of src.sections) {
				const s = obj(sec)
				if (Array.isArray(s.controls)) s.controls = s.controls.map((c) => (typeof c === 'string' ? (CONTROL_RENAMES[c] ?? c) : c))
			}
		}
	}
	src.version = STORE_VERSION
	return src
}

export function loadStore(raw: unknown, schema: StoreSchema = CORE_SCHEMA): Store {
	let parsed: unknown = raw
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw)
		} catch {
			parsed = {}
		}
	} else {
		parsed = JSON.parse(JSON.stringify(raw ?? {}))
	}
	const src = migrateStore(obj(parsed))
	const store = newStore(schema)
	store.defaults = sanitize(src.defaults, schema.defaults) as InputSettings
	store.page = sanitize(src.page, PAGE_DEFAULTS) as PageSettings
	store.gestures = sanitize(src.gestures, GESTURE_DEFAULTS) as GestureSettings
	if (typeof src.moduleCalibrateDb === 'number') store.moduleCalibrateDb = src.moduleCalibrateDb
	if (Array.isArray(src.sections)) {
		store.sections = src.sections.map((x, i) => sanitizeSection(x, i, schema)).filter((s): s is Section => s !== null)
	}
	if (Array.isArray(src.order)) store.order = src.order.filter((x): x is string => typeof x === 'string')
	if (Array.isArray(src.hidden)) store.hidden = src.hidden.filter((x): x is string => typeof x === 'string')
	for (const [name, rec] of Object.entries(obj(src.inputs))) store.inputs[name] = sanitizeRecord(rec, schema)
	const r = obj(src.record)
	store.record = {
		nextStart: typeof r.nextStart === 'string' ? r.nextStart : null,
		autoStart: r.autoStart === true,
		snoozedUntil: typeof r.snoozedUntil === 'string' ? r.snoozedUntil : null,
		dismissed: r.dismissed === true,
	}
	const rs = obj(src.recordings)
	const sets: Record<string, Record<string, unknown>> = {}
	for (const [k, v] of Object.entries(obj(rs.settings))) if (v && typeof v === 'object' && !Array.isArray(v)) sets[k] = { ...(v as Record<string, unknown>) }
	store.recordings = {
		enabled: rs.enabled === true,
		folderOverride: typeof rs.folderOverride === 'string' ? rs.folderOverride : '',
		restoreName: rs.restoreName !== false,
		settings: sets,
		saved: rs.saved && typeof rs.saved === 'object' && !Array.isArray(rs.saved) ? (rs.saved as Record<string, unknown>) : null,
	}
	return store
}

export function inputRecord(store: Store, name: string): InputRecord {
	let rec = store.inputs[name]
	if (!rec) {
		rec = { overrides: {}, sections: {}, target: null, refGain: null }
		store.inputs[name] = rec
	}
	return rec
}

export function effectiveSettings(store: Store, name: string): InputSettings {
	return { ...store.defaults, ...(store.inputs[name]?.overrides ?? {}) }
}

/** Turn typed text into a value for an input setting; undefined if it doesn't fit */
export function coerceSetting(key: string, raw: unknown, schema: StoreSchema = CORE_SCHEMA): unknown {
	const field = schema.fields[key]
	if (!field) return undefined
	if (field.type === 'bool') {
		if (typeof raw === 'boolean') return raw
		const t = String(raw).trim().toLowerCase()
		if (['1', 'true', 'on', 'yes'].includes(t)) return true
		if (['0', 'false', 'off', 'no'].includes(t)) return false
		return undefined
	}
	if (field.type === 'number') {
		const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
		if (String(raw).trim() === '' || Number.isNaN(n)) return undefined
		return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, n))
	}
	if (field.type === 'choice') {
		const t = String(raw).trim()
		const c = field.choices?.find((c) => c.id === t || c.label.toLowerCase() === t.toLowerCase())
		return c?.id
	}
	return String(raw)
}

/** Parts of an export that can be picked on import */
export type ImportPart = 'page' | 'sections' | 'defaults' | 'gestures' | 'order' | 'recordings' | `input:${string}`

export function applyImport(store: Store, incoming: Store, parts: ImportPart[]): void {
	for (const part of parts) {
		if (part === 'page') store.page = { ...incoming.page }
		else if (part === 'sections') store.sections = incoming.sections.map((s) => ({ ...s, controls: [...s.controls] }))
		else if (part === 'defaults') store.defaults = { ...incoming.defaults }
		else if (part === 'gestures') {
			store.gestures = { ...incoming.gestures }
			store.moduleCalibrateDb = incoming.moduleCalibrateDb
		} else if (part === 'order') {
			store.order = [...incoming.order]
			store.hidden = [...incoming.hidden]
		} else if (part === 'recordings') {
			// settings only: the upload queue and sheet copy stay this computer's. Passwords left blank in an export are kept.
			const keep = store.recordings.settings
			const next = JSON.parse(JSON.stringify(incoming.recordings.settings)) as Record<string, Record<string, unknown>>
			const oldDest = Array.isArray(keep.upload?.destinations) ? (keep.upload.destinations as Record<string, unknown>[]) : []
			if (Array.isArray(next.upload?.destinations)) {
				for (const d of next.upload.destinations as Record<string, unknown>[]) {
					const was = oldDest.find((o) => o.id === d.id)
					if (was && !d.password && was.password) d.password = was.password
				}
			}
			store.recordings = { ...store.recordings, enabled: incoming.recordings.enabled, folderOverride: incoming.recordings.folderOverride, restoreName: incoming.recordings.restoreName, settings: next }
		} else if (part.startsWith('input:')) {
			const name = part.slice(6)
			const rec = incoming.inputs[name]
			if (rec) store.inputs[name] = JSON.parse(JSON.stringify(rec)) as InputRecord
		}
	}
}
