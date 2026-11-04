/**
 * A pretend mixer for core tests: implements Device directly (no network),
 * with a synthetic signal per input and meters at 20 Hz. Its caps can be
 * anything, so it stands in for an OBS, an ATEM or a plain classic desk.
 */
import type { Db } from '../src/law.js'
import type { BlockInfo, Device, DeviceHost, DeviceInfo, DeviceInputState, DeviceRecording, InputCaps } from '../src/device.js'

export const FULL_CAPS: InputCaps = {
	fader: { minDb: -100, maxDb: 10 },
	trim: { minDb: -20, maxDb: 20, label: 'Trim' },
	mute: true,
	balance: true,
	delay: { unit: 'frames', min: 0, max: 8, step: 1, label: 'Delay' },
	monitor: { choices: [{ id: 'off', label: 'Off' }, { id: 'pfl', label: 'PFL' }], off: 'off', pfl: 'pfl' },
	mixOption: { label: 'Mix', choices: [{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }, { id: 'afv', label: 'AFV' }] },
	processing: { kinds: ['comp'], addable: false },
	preMeter: true,
}

/** A classic desk channel: gain (fader) and balance only */
export const CLASSIC_CAPS: InputCaps = { fader: { minDb: -60, maxDb: 6 }, balance: true }

export const FAKE_INFO: DeviceInfo = {
	label: 'the fake desk',
	software: { label: 'Fake OS', repo: '', download: 'https://example.invalid' },
	processing: [{ kind: 'comp', label: 'Compressor', defaultName: 'Comp', gainReduction: true, params: [{ key: 'threshold', label: 'Threshold', type: 'number', min: -60, max: 0, step: 0.5, unit: 'dB', default: -20 }] }],
}

export interface FakeInput extends DeviceInputState {
	/** Incoming signal, dB RMS (peak is +6), null = silence */
	signalDb: number | null
}

const mul = (db: number) => Math.pow(10, db / 20)

export class FakeDevice implements Device {
	readonly info = FAKE_INFO
	connected = false
	lastError = 'Not started'
	host: DeviceHost | null = null
	inputs: FakeInput[] = []
	calls: string[] = []
	rec = { active: false, name: '' }
	#timer: NodeJS.Timeout | null = null
	readonly recording: DeviceRecording = {
		status: async () => ({ active: this.rec.active, paused: false, timecode: this.rec.active ? '00:00:01' : '' }),
		details: async () => ({ fileName: this.rec.name }),
		start: async () => {
			this.rec.active = true
			this.host?.record({ active: true, paused: false, edge: true })
		},
		stop: async () => {
			this.rec.active = false
			this.host?.record({ active: false, paused: false, edge: true, lastFile: `${this.rec.name || 'take'}.wav` })
		},
		setFileName: async (n) => {
			this.rec.name = n
		},
	}

	add(id: string, signalDb: number | null, caps: InputCaps = FULL_CAPS): FakeInput {
		const blocks: BlockInfo[] = caps.processing ? [{ id: 'comp', name: 'Comp', kind: 'comp', enabled: true, settings: { threshold: -20 } }] : []
		const i: FakeInput = {
			id,
			name: id.toUpperCase(),
			kind: 'fake',
			channels: 2,
			caps,
			volumeDb: 0,
			trimDb: 0,
			hasTrim: !!caps.trim,
			muted: false,
			balance: 0.5,
			delay: 0,
			monitor: caps.monitor?.off ?? '',
			routing: {},
			mixOption: caps.mixOption ? 'on' : '',
			blocks,
			signalDb,
		}
		this.inputs.push(i)
		return i
	}

	get(id: string): FakeInput {
		const i = this.inputs.find((x) => x.id === id)
		if (!i) throw new Error(`no input ${id}`)
		return i
	}

	#state(i: FakeInput): DeviceInputState {
		const { signalDb: _s, ...rest } = i
		return { ...rest, routing: { ...i.routing }, blocks: i.blocks.map((b) => ({ ...b, settings: { ...b.settings } })) }
	}

	start(host: DeviceHost): void {
		this.host = host
		setTimeout(() => {
			this.connected = true
			this.lastError = ''
			host.version('1.0.0')
			host.connected()
		}, 10)
		this.#timer = setInterval(() => this.#meters(), 50)
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer)
		this.connected = false
	}

	async refresh(): Promise<void> {
		this.host?.inputs(this.inputs.map((i) => this.#state(i)))
	}

	/** Change something "on the desk itself" */
	external(id: string, patch: Partial<DeviceInputState>): void {
		Object.assign(this.get(id), patch)
		this.host?.inputChanged(id, patch)
	}

	#meters(): void {
		this.host?.meters(
			this.inputs.map((i) => {
				const sig = i.signalDb === null ? 0 : mul(i.signalDb + i.trimDb + (Math.random() - 0.5) * 0.5)
				const vol = i.muted || i.volumeDb === null ? 0 : mul(i.volumeDb)
				const ch = [sig * vol, sig * vol]
				return { id: i.id, postMag: ch, postPeak: ch.map((x) => x * 2), prePeak: i.caps.preMeter ? [sig * 2, sig * 2] : [], gainReduction: i.caps.processing ? { comp: 3 } : undefined }
			}),
		)
	}

	#echo(id: string, patch: Partial<DeviceInputState>): void {
		Object.assign(this.get(id), patch)
		setTimeout(() => this.host?.inputChanged(id, patch), 5)
	}

	async setVolume(id: string, db: Db): Promise<void> {
		this.calls.push(`volume ${id}`)
		this.#echo(id, { volumeDb: db })
	}
	async setTrim(id: string, db: number): Promise<void> {
		this.calls.push(`trim ${id}`)
		this.#echo(id, { trimDb: db })
	}
	async setMute(id: string, muted: boolean): Promise<void> {
		this.#echo(id, { muted })
	}
	async setBalance(id: string, balance: number): Promise<void> {
		this.#echo(id, { balance })
	}
	async setDelay(id: string, delay: number): Promise<void> {
		this.#echo(id, { delay })
	}
	async setMonitor(id: string, monitor: string): Promise<void> {
		this.#echo(id, { monitor })
	}
	async setMixOption(id: string, mixOption: string): Promise<void> {
		this.#echo(id, { mixOption })
	}
	async setBlockEnabled(id: string, blockId: string, on: boolean): Promise<void> {
		const i = this.get(id)
		this.#echo(id, { blocks: i.blocks.map((b) => (b.id === blockId ? { ...b, enabled: on } : b)) })
	}
	async setBlockParam(id: string, blockId: string, key: string, value: unknown): Promise<void> {
		const i = this.get(id)
		this.#echo(id, { blocks: i.blocks.map((b) => (b.id === blockId ? { ...b, settings: { ...b.settings, [key]: value } } : b)) })
	}
}
