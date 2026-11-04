/**
 * Catch / latch / override / release (CLOR) for hardware faders such as the
 * Intech Grid's, carried over from Nige's SQ module extension (3.1.1-grid.7).
 * "The desk" below is whatever device the module drives (OBS, an ATEM...).
 *
 *   waiting  - the fader isn't at the desk level. Nothing is sent.
 *   dwelling - inside the catch band around the desk level. Still nothing sent.
 *              If it stays in the band for the dwell time it latches; if it
 *              leaves first (a quick sweep through), it goes back to waiting.
 *   tracking - latched: the desk follows the fader, whatever the fader does.
 *
 * Release: only the desk level being moved elsewhere (the desk itself, the web
 * page, another button, auto level in fader mode) breaks the latch: the desk
 * level is further than the release band from everything sent in the last
 * ECHO_WINDOW_MS, for the release time.
 */

export const DEFAULT_BAND = 3
export const DEFAULT_DWELL_MS = 1000
export const DEFAULT_FLASH_MS = 250
export const DEFAULT_RELEASE_BAND = 6
export const DEFAULT_RELEASE_MS = 0
/** A release band this wide never releases */
export const NEVER_RELEASE_BAND = 127

const ECHO_WINDOW_MS = 1500

type Phase = 'waiting' | 'dwelling' | 'tracking'

export interface PickupSettings {
	band: number
	dwellMs: number
	releaseBand: number
	releaseMs: number
}

export const PICKUP_DEFAULTS: PickupSettings = {
	band: DEFAULT_BAND,
	dwellMs: DEFAULT_DWELL_MS,
	releaseBand: DEFAULT_RELEASE_BAND,
	releaseMs: DEFAULT_RELEASE_MS,
}

interface PickupState {
	phase: Phase
	lastIn: number | undefined
	recentSent: { position: number; at: number }[]
	outsideSince: number | undefined
	dwellTimer: NodeJS.Timeout | undefined
	settings: PickupSettings
	apply: ((position: number) => void) | undefined
}

export type PickupLed = 'below' | 'above' | 'catch' | 'tracking'

export class PickupManager {
	readonly #states = new Map<string, PickupState>()
	/** Current desk fader position for a key, 0-127, or undefined if unknown */
	readonly #desk: (key: string) => number | undefined
	readonly #changed: () => void
	readonly #now: () => number

	constructor(desk: (key: string) => number | undefined, changed: () => void, now: () => number = Date.now) {
		this.#desk = desk
		this.#changed = changed
		this.#now = now
	}

	destroy(): void {
		for (const s of this.#states.values()) if (s.dwellTimer) clearTimeout(s.dwellTimer)
		this.#states.clear()
	}

	/** Call regularly (e.g. 8 times a second) to notice the desk level moving while the fader sits still */
	tick(): void {
		for (const [key, state] of this.#states) this.#checkRelease(key, state)
	}

	/** Forget a key, e.g. when its input goes away */
	forget(key: string): void {
		const s = this.#states.get(key)
		if (s?.dwellTimer) clearTimeout(s.dwellTimer)
		this.#states.delete(key)
	}

	phase(key: string): Phase | undefined {
		return this.#states.get(key)?.phase
	}

	#state(key: string): PickupState {
		let s = this.#states.get(key)
		if (!s) {
			s = {
				phase: 'waiting',
				lastIn: undefined,
				recentSent: [],
				outsideSince: undefined,
				dwellTimer: undefined,
				settings: { ...PICKUP_DEFAULTS },
				apply: undefined,
			}
			this.#states.set(key, s)
		}
		return s
	}

	#sent(s: PickupState, position: number): void {
		const now = this.#now()
		s.recentSent.push({ position, at: now })
		while (s.recentSent.length > 1 && now - s.recentSent[0].at > ECHO_WINDOW_MS) s.recentSent.shift()
	}

	#checkRelease(key: string, s: PickupState): void {
		if (s.phase !== 'tracking') return
		const { releaseBand, releaseMs } = s.settings
		const desk = this.#desk(key)
		if (desk === undefined || releaseBand >= NEVER_RELEASE_BAND || s.recentSent.length === 0) {
			s.outsideSince = undefined
			return
		}
		const now = this.#now()
		const ours = s.recentSent.filter((x, i) => i === s.recentSent.length - 1 || now - x.at <= ECHO_WINDOW_MS)
		const outside = !ours.some((x) => Math.abs(x.position - desk) <= releaseBand)
		if (!outside) {
			s.outsideSince = undefined
			return
		}
		s.outsideSince ??= now
		if (now - s.outsideSince >= releaseMs) {
			s.phase = 'waiting'
			s.recentSent = []
			s.outsideSince = undefined
			this.#changed()
		}
	}

	#inBand(s: PickupState, key: string, position: number): boolean {
		const desk = this.#desk(key)
		if (desk === undefined) return true
		return Math.abs(position - desk) <= s.settings.band
	}

	#stopDwell(s: PickupState): void {
		if (s.dwellTimer) clearTimeout(s.dwellTimer)
		s.dwellTimer = undefined
	}

	/** A new fader position (0-127). Returns true if it should be sent to the desk now. */
	handle(key: string, incoming: number, settings: PickupSettings, apply: (position: number) => void): boolean {
		const s = this.#state(key)
		s.apply = apply
		s.settings = settings
		s.lastIn = incoming

		if (this.#desk(key) === undefined) {
			this.#stopDwell(s)
			s.phase = 'tracking'
		} else {
			this.#checkRelease(key, s)
		}

		if (s.phase !== 'tracking') {
			if (this.#inBand(s, key, incoming)) {
				if (s.phase === 'waiting') this.#startDwell(key, s)
			} else {
				this.#stopDwell(s)
				s.phase = 'waiting'
			}
		}
		this.#changed()
		if (s.phase !== 'tracking') return false
		this.#sent(s, incoming)
		return true
	}

	#startDwell(key: string, s: PickupState): void {
		this.#stopDwell(s)
		s.phase = 'dwelling'
		s.dwellTimer = setTimeout(() => {
			s.dwellTimer = undefined
			if (s.phase !== 'dwelling') return
			if (s.lastIn === undefined || !this.#inBand(s, key, s.lastIn)) {
				s.phase = 'waiting'
			} else {
				s.phase = 'tracking'
				s.recentSent = []
				s.outsideSince = undefined
				this.#sent(s, s.lastIn)
				s.apply?.(s.lastIn)
			}
			this.#changed()
		}, s.settings.dwellMs)
	}

	ledState(key: string, incoming: number | undefined): { led: PickupLed; position: number } {
		const s = this.#states.get(key)
		const position = Math.max(0, Math.min(127, incoming ?? s?.lastIn ?? 0))
		if (s?.phase === 'tracking') return { led: 'tracking', position }
		if (s?.phase === 'dwelling') return { led: 'catch', position }
		const desk = this.#desk(key)
		if (desk === undefined || (incoming === undefined && s?.lastIn === undefined)) return { led: 'tracking', position }
		const band = s?.settings.band ?? DEFAULT_BAND
		if (Math.abs(position - desk) <= band) return { led: 'catch', position }
		return { led: position > desk ? 'above' : 'below', position }
	}
}
