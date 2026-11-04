/**
 * Cheap duration reading from a file's header (no ffprobe). Supported: MP4/MOV/M4A (mvhd box, top-level `moov`
 * found by walking boxes, so it works whether moov is at the start or the end) and WAV (data size / byte rate).
 * Anything else (MKV, FLV, TS, MP3, AAC…) returns null: "not cheaply available".
 * Fragmented MP4 (OBS "Fragmented MP4"): mvhd duration is often 0 while recording; we return null for 0.
 */
import { open } from 'node:fs/promises'

export const DURATION_TYPES = ['mp4', 'mov', 'm4a', 'm4v', '3gp', 'wav'] as const

export async function readDuration(path: string): Promise<number | null> {
	const ext = path.toLowerCase().split('.').pop() ?? ''
	try {
		if (ext === 'wav') return await wavDuration(path)
		if (['mp4', 'mov', 'm4a', 'm4v', '3gp'].includes(ext)) return await mp4Duration(path)
	} catch {
		/* unreadable or still being written */
	}
	return null
}

async function mp4Duration(path: string): Promise<number | null> {
	const fh = await open(path, 'r')
	try {
		const { size } = await fh.stat()
		const hdr = Buffer.alloc(16)
		const read = async (pos: number, n: number) => {
			const b = n <= 16 ? hdr : Buffer.alloc(n)
			const { bytesRead } = await fh.read(b, 0, n, pos)
			return b.subarray(0, bytesRead)
		}
		const walk = async (start: number, end: number, want: string): Promise<{ pos: number; len: number; hl: number } | null> => {
			let p = start
			for (let guard = 0; p + 8 <= end && guard < 10000; guard++) {
				const h = await read(p, 16)
				if (h.length < 8) return null
				let len = h.readUInt32BE(0)
				const type = h.toString('latin1', 4, 8)
				let hl = 8
				if (len === 1) {
					if (h.length < 16) return null
					len = Number(h.readBigUInt64BE(8))
					hl = 16
				} else if (len === 0) len = end - p
				if (len < hl) return null
				if (type === want) return { pos: p, len, hl }
				p += len
			}
			return null
		}
		const moov = await walk(0, size, 'moov')
		if (!moov) return null
		const mvhd = await walk(moov.pos + moov.hl, Math.min(size, moov.pos + moov.len), 'mvhd')
		if (!mvhd) return null
		const b = await read(mvhd.pos + mvhd.hl, 32)
		const version = b[0]
		let scale: number
		let dur: number
		if (version === 1) {
			scale = b.readUInt32BE(20)
			dur = Number(b.readBigUInt64BE(24))
		} else {
			scale = b.readUInt32BE(12)
			dur = b.readUInt32BE(16)
		}
		if (!scale || !dur || dur === 0xffffffff) return null
		return dur / scale
	} finally {
		await fh.close()
	}
}

async function wavDuration(path: string): Promise<number | null> {
	const fh = await open(path, 'r')
	try {
		const { size } = await fh.stat()
		const b = Buffer.alloc(Math.min(size, 4096))
		await fh.read(b, 0, b.length, 0)
		if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null
		let p = 12
		let byteRate = 0
		while (p + 8 <= b.length) {
			const id = b.toString('latin1', p, p + 4)
			const len = b.readUInt32LE(p + 4)
			if (id === 'fmt ') byteRate = b.readUInt32LE(p + 16)
			if (id === 'data') {
				if (!byteRate) return null
				// a WAV still being written often has 0 or 0xFFFFFFFF here: use the file size instead
				const dataLen = len === 0 || len === 0xffffffff || p + 8 + len > size ? size - (p + 8) : len
				return dataLen / byteRate
			}
			p += 8 + len + (len & 1)
		}
		return null
	} finally {
		await fh.close()
	}
}
