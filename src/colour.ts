/** Companion colours (0xRRGGBB numbers) from text, as in the SQ module extension */

export function rgb(r: number, g: number, b: number): number {
	return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

/**
 * A colour from typed text or a variable's value: '#ff0000', 'ff0000',
 * '255,0,0', or a Companion colour number. Blank or unreadable = `fallback`.
 */
export function parseColour(raw: string, fallback: number | undefined): number | undefined {
	const text = raw.trim()
	const hex = /^#?([0-9a-f]{6})$/i.exec(text)
	if (hex) return parseInt(hex[1], 16)
	const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(text)
	if (m) return rgb(Math.min(255, +m[1]), Math.min(255, +m[2]), Math.min(255, +m[3]))
	if (/^\d+$/.test(text)) return Math.min(0xffffff, Number(text))
	return fallback
}

/** Scale a colour's brightness by `fraction` (0-1) */
export function scaleColour(colour: number, fraction: number): number {
	const f = Math.max(0, Math.min(1, fraction))
	return rgb(Math.round(((colour >> 16) & 0xff) * f), Math.round(((colour >> 8) & 0xff) * f), Math.round((colour & 0xff) * f))
}
