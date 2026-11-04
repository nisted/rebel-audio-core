/**
 * The Device interface: what a mixer (OBS, an ATEM, a classic desk...) has to
 * provide so the core Engine, auto level, pickup, page and the rest can drive
 * it. One adapter per device type lives in its module (e.g. OBS Audio's
 * `src/obs-device.ts`); the core never talks to a device any other way.
 *
 * The deal, in short:
 *  - The engine calls `start(host)` / `stop()`. The device connects (and keeps
 *    reconnecting) by itself, and reports everything through the `DeviceHost`
 *    callbacks: connected / disconnected, the input list, changes to an
 *    input, meters, and recording state.
 *  - The engine calls the setters. They resolve when the device has taken the
 *    change, and reject with an Error whose message is fit for a log.
 *  - Each input says what it can do in `caps`. Anything an input hasn't got
 *    (no trim, no monitoring, no processing...) is simply left out, and the
 *    page, actions and auto level hide or skip it.
 *  - Processing (filters, EQ, dynamics) is described by a table of
 *    `ProcessingKind`s, so the page and actions render any block generically.
 *
 * Levels are dB with `null` = -inf, as everywhere in the core (see law.ts).
 */

import type { Db } from './law.js'

// ---- describing a device -------------------------------------------------------

/** One setting of a processing block (a filter's threshold, an EQ band's gain...) */
export interface ProcessingParam {
	key: string
	label: string
	type: 'number' | 'choice' | 'text' | 'bool'
	min?: number
	max?: number
	step?: number
	unit?: string
	default: number | string | boolean
	choices?: { id: string; label: string }[]
}

/** A kind of processing block: OBS's compressor filter, a Fairlight EQ, a gate... */
export interface ProcessingKind {
	/** Stable id, used in section controls, actions and store */
	kind: string
	label: string
	/** Name given to a new block of this kind (devices that add blocks) */
	defaultName: string
	params: ProcessingParam[]
	/** This kind reports gain reduction (dB) in the meters, shown as a GR meter */
	gainReduction?: boolean
	/** Left out of the starter "Processing" section (e.g. OBS's plain Gain filter) */
	inStarter?: boolean
}

/** A software release to check for updates (the device's own firmware or app) */
export interface SoftwareInfo {
	/** e.g. 'OBS Studio' */
	label: string
	/** GitHub 'owner/repo' whose releases are checked, or '' for no check */
	repo: string
	/** Where to download it */
	download: string
}

/** A per-input setting a device adds to the core's auto level / backup settings */
export interface DeviceField {
	label: string
	type: 'bool' | 'number' | 'choice' | 'text'
	min?: number
	max?: number
	step?: number
	unit?: string
	choices?: { id: string; label: string }[]
	help: string
	group: string
	default: boolean | number | string
	/** Changing it moves auto level's measuring point, so the target is cleared */
	resetsAutoLevel?: boolean
}

export interface DeviceInfo {
	/** Short name in plain words: 'OBS', 'the ATEM' */
	label: string
	software: SoftwareInfo
	/** Every kind of processing block this device can have */
	processing: ProcessingKind[]
	/** Extra per-input settings (stored with the core's, same rules) */
	inputFields?: Record<string, DeviceField>
	/** Extra tips for the page's tip of the day */
	tips?: string[]
}

// ---- describing an input ------------------------------------------------------

/** What one input can do. Leave a control out and it's hidden for that input. */
export interface InputCaps {
	/** The main fader. Every input has one (a master or monitor bus too). */
	fader: { minDb: number; maxDb: number }
	/** A gain stage before the fader that auto level can ride instead of the fader */
	trim?: { minDb: number; maxDb: number; label: string }
	mute?: boolean
	/** Balance / pan, 0 = left, 0.5 = centre, 1 = right */
	balance?: boolean
	/** Input delay, in the device's own unit */
	delay?: { unit: 'ms' | 'frames' | 'samples'; min: number; max: number; step: number; label: string }
	/**
	 * Monitoring / PFL. `choices` are the device's monitoring states; `off` is
	 * the one that means "not in the headphones" and `pfl` the one PFL sets.
	 * Solo is built on this (it never touches the programme output).
	 */
	monitor?: { choices: { id: string; label: string }[]; off: string; pfl: string }
	/** Where the input goes: OBS's recording tracks, a desk's buses... */
	routing?: { label: string; targets: { id: string; label: string }[] }
	/** A mix mode such as the ATEM's on / off / audio-follow-video */
	mixOption?: { label: string; choices: { id: string; label: string }[] }
	/**
	 * Processing: which kinds this input can have, and whether blocks are added
	 * and removed (OBS filters) or fixed (a Fairlight channel's EQ and dynamics).
	 */
	processing?: { kinds: string[]; addable: boolean }
	/** Which meters the device gives: post-fader always; pre-fader if true */
	preMeter?: boolean
	/** A bus rather than a channel: shown as its own strip, labelled */
	role?: 'master' | 'monitor' | 'talkback'
}

/** One processing block on an input */
export interface BlockInfo {
	/** Stable id within the input (OBS: the filter name) */
	id: string
	name: string
	/** A ProcessingKind.kind */
	kind: string
	enabled: boolean
	settings: Record<string, unknown>
	/** The block the device uses as this input's trim: hidden from processing lists */
	isTrim?: boolean
}

/** An input's state as the device reports it */
export interface DeviceInputState {
	/** Stable key. Store, order and page use it. */
	id: string
	/** What it's called on the device */
	name: string
	/** Device-specific type, for information only */
	kind: string
	channels: number
	caps: InputCaps
	volumeDb: Db
	/** 0 when there's no trim */
	trimDb: number
	/** False when the trim stage doesn't exist yet (OBS adds it on first use) */
	hasTrim: boolean
	muted: boolean
	balance: number
	delay: number
	/** One of caps.monitor.choices, or '' without monitoring */
	monitor: string
	routing: Record<string, boolean>
	mixOption: string
	blocks: BlockInfo[]
}

/**
 * One meter reading for an input. Levels are linear multipliers (1 = 0 dBFS)
 * per channel, as auto level averages them in the power domain.
 */
export interface DeviceMeter {
	id: string
	/** Post-fader magnitude (RMS-ish) per channel */
	postMag: number[]
	/** Post-fader peak per channel */
	postPeak: number[]
	/** Pre-fader peak per channel, after any trim (empty if the device has none) */
	prePeak: number[]
	/** Gain reduction per block id, dB (0 = none, positive = reducing) */
	gainReduction?: Record<string, number>
}

export interface DeviceRecordEvent {
	active: boolean
	paused: boolean
	/** The file just written, when the device says */
	lastFile?: string
	/** True when a take has just started or stopped (worth re-counting files) */
	edge?: boolean
}

/** Recording, for devices that record */
export interface DeviceRecording {
	status(): Promise<{ active: boolean; paused: boolean; timecode: string }>
	/** Where it records to and what the files are called, as far as known */
	details(): Promise<{ directory?: string; fileName?: string }>
	start(): Promise<void>
	stop(): Promise<void>
	pause?(on: boolean): Promise<void>
	setFolder?(dir: string): Promise<void>
	/** The device's file name (or name format), set before a take starts */
	setFileName?(name: string): Promise<void>
	/**
	 * Optional: set a plain file name (no extension) for the next take. Sheet
	 * naming uses this when it's there, otherwise setFileName. Give it when the
	 * device's file name setting has codes of its own that a plain name must
	 * not trip (OBS's %CCYY...). Either way, once the take has started the
	 * device's previous file name setting is put back with setFileName (if
	 * the user leaves "put it back" on).
	 */
	setTakeName?(name: string): Promise<void>
}

// ---- the two sides ------------------------------------------------------------

/** What the engine gives a device to report back on */
export interface DeviceHost {
	log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void
	/** Connected and ready: the engine calls refresh() next */
	connected(): void
	/** Lost (or failed) the connection; `reason` in plain words; `was` = had been connected */
	disconnected(reason: string, was: boolean): void
	/** The whole input list, in the device's order (after refresh, or adds/removes) */
	inputs(list: DeviceInputState[]): void
	/** One input was added (appended to the order) */
	inputAdded(input: DeviceInputState): void
	inputRemoved(id: string): void
	/** An input's id and/or name changed (OBS: renamed). Settings follow it. */
	inputRenamed(oldId: string, newId: string, name: string): void
	/**
	 * Part of an input changed. `blocksChanged` = blocks were added, removed or
	 * renamed (not just a setting), so actions and variables get redone.
	 */
	inputChanged(id: string, patch: Partial<DeviceInputState>, blocksChanged?: boolean): void
	meters(list: DeviceMeter[]): void
	record(ev: DeviceRecordEvent): void
	/** A per-input setting (core or the device's own fields) */
	setting(id: string, key: string): unknown
	/** The device's version string became known */
	version(v: string): void
}

export interface Device {
	readonly info: DeviceInfo
	readonly connected: boolean
	/** Why it isn't connected, in plain words, or '' */
	readonly lastError: string
	/** Start connecting (and keep reconnecting) */
	start(host: DeviceHost): void
	stop(): void
	/** Re-read everything; reports through host.inputs() */
	refresh(): Promise<void>

	setVolume(id: string, db: Db): Promise<void>
	setTrim?(id: string, db: number): Promise<void>
	setMute?(id: string, muted: boolean): Promise<void>
	setBalance?(id: string, balance: number): Promise<void>
	setDelay?(id: string, value: number): Promise<void>
	setMonitor?(id: string, value: string): Promise<void>
	setRouting?(id: string, changes: Record<string, boolean>): Promise<void>
	setMixOption?(id: string, value: string): Promise<void>
	/** Add a block (devices with addable processing). Returns the new block's id. */
	addBlock?(id: string, kind: string, name: string): Promise<string>
	removeBlock?(id: string, blockId: string): Promise<void>
	setBlockEnabled?(id: string, blockId: string, on: boolean): Promise<void>
	setBlockParam?(id: string, blockId: string, key: string, value: unknown): Promise<void>

	/**
	 * A per-input setting changed (core or one of info.inputFields). Devices
	 * whose behaviour hangs off a setting (OBS: which filter is the trim)
	 * re-read it here and report any change through host.inputChanged().
	 */
	settingChanged?(id: string, key: string): void

	recording?: DeviceRecording
}
