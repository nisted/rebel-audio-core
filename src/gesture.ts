/**
 * One button, three jobs: press, double tap, press and hold.
 * Feed it the button going down and up; it calls back once per gesture.
 * A single press waits out the double-tap window before it fires.
 */

export type Gesture = 'press' | 'double' | 'hold'

interface ButtonState {
	downAt: number
	holdTimer: NodeJS.Timeout | undefined
	held: boolean
	taps: number
	tapTimer: NodeJS.Timeout | undefined
}

export class GestureReader {
	readonly #buttons = new Map<string, ButtonState>()
	readonly #fire: (key: string, g: Gesture) => void
	readonly #timing: () => { doubleTapMs: number; holdMs: number }

	constructor(timing: () => { doubleTapMs: number; holdMs: number }, fire: (key: string, g: Gesture) => void) {
		this.#timing = timing
		this.#fire = fire
	}

	destroy(): void {
		for (const b of this.#buttons.values()) {
			if (b.holdTimer) clearTimeout(b.holdTimer)
			if (b.tapTimer) clearTimeout(b.tapTimer)
		}
		this.#buttons.clear()
	}

	#get(key: string): ButtonState {
		let b = this.#buttons.get(key)
		if (!b) {
			b = { downAt: 0, holdTimer: undefined, held: false, taps: 0, tapTimer: undefined }
			this.#buttons.set(key, b)
		}
		return b
	}

	down(key: string): void {
		const b = this.#get(key)
		const { holdMs } = this.#timing()
		b.downAt = Date.now()
		b.held = false
		if (b.holdTimer) clearTimeout(b.holdTimer)
		b.holdTimer = setTimeout(() => {
			b.holdTimer = undefined
			b.held = true
			if (b.tapTimer) clearTimeout(b.tapTimer)
			b.tapTimer = undefined
			b.taps = 0
			this.#fire(key, 'hold')
		}, holdMs)
	}

	up(key: string): void {
		const b = this.#get(key)
		if (b.holdTimer) clearTimeout(b.holdTimer)
		b.holdTimer = undefined
		if (b.held) {
			b.held = false
			return
		}
		b.taps++
		if (b.taps >= 2) {
			if (b.tapTimer) clearTimeout(b.tapTimer)
			b.tapTimer = undefined
			b.taps = 0
			this.#fire(key, 'double')
			return
		}
		const { doubleTapMs } = this.#timing()
		b.tapTimer = setTimeout(() => {
			b.tapTimer = undefined
			if (b.taps === 1) this.#fire(key, 'press')
			b.taps = 0
		}, doubleTapMs)
	}
}
