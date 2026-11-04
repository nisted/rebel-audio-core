/**
 * File manager over one recording folder (the folder path comes from the device/module).
 * Every name the caller passes is relative to that folder and is checked so nothing outside it can be touched,
 * including through symlinks.
 */
import { createReadStream } from 'node:fs'
import { readdir, realpath, rename as fsRename, stat, unlink, lstat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readDuration } from './duration.js'
import { cleanFileName, splitExt } from './naming.js'
import type { FileSettings, NamingSettings } from './settings.js'

export interface RecordingFile {
	/** Path relative to the folder, always with "/" (just the file name unless sub-folders are listed) */
	name: string
	size: number
	/** Modified time, ms since epoch */
	modified: number
	/** Seconds, or null when not cheaply available (only MP4/MOV/M4A/WAV are read; see duration.ts) */
	duration: number | null
	/** Lower-case extension without the dot */
	ext: string
	/** Content type used when streaming */
	type: string
}

export class FileError extends Error {
	constructor(
		message: string,
		readonly code: 'not-found' | 'outside' | 'bad-name' | 'exists' | 'no-folder' | 'confirm' | 'busy' | 'io',
	) {
		super(message)
	}
	/** Matching HTTP status */
	get status(): number {
		return { 'not-found': 404, outside: 403, 'bad-name': 400, exists: 409, 'no-folder': 503, confirm: 409, busy: 423, io: 500 }[this.code]
	}
}

const TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	webm: 'video/webm',
	flv: 'video/x-flv',
	ts: 'video/mp2t',
	m3u8: 'application/vnd.apple.mpegurl',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	txt: 'text/plain; charset=utf-8',
	json: 'application/json',
	jpg: 'image/jpeg',
	png: 'image/png',
}
export function contentTypeFor(name: string): string {
	return TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

function isInside(root: string, p: string): boolean {
	const r = relative(root, p)
	return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))
}

export interface FileManagerOptions {
	/** The recording folder (or a function that returns it, since it can change when the device says so) */
	folder: string | (() => string | null)
	settings: FileSettings
	/** Used by rename(): how to clean names */
	naming?: Pick<NamingSettings, 'replaceWith' | 'maxLength'>
	now?: () => number
	/** Names currently being recorded (refuse rename/delete, mark as busy) */
	busy?: () => Iterable<string>
}

interface DeleteToken {
	name: string
	size: number
	modified: number
	expires: number
}

export class FileManager {
	private readonly opts: FileManagerOptions
	private settings: FileSettings
	private readonly now: () => number
	private readonly tokens = new Map<string, DeleteToken>()
	private readonly durCache = new Map<string, number | null>()

	constructor(opts: FileManagerOptions) {
		this.opts = opts
		this.settings = opts.settings
		this.now = opts.now ?? Date.now
	}

	configure(settings: FileSettings): void {
		this.settings = settings
	}

	/** The folder as given, or throws a plain-words error */
	folder(): string {
		const f = typeof this.opts.folder === 'function' ? this.opts.folder() : this.opts.folder
		if (!f) throw new FileError("The recording folder isn't known yet (is the device connected?)", 'no-folder')
		return resolve(f)
	}

	private async realRoot(): Promise<string> {
		const f = this.folder()
		try {
			return await realpath(f)
		} catch {
			throw new FileError(`Can't open the recording folder (${f}). Is it there, and can this computer reach it?`, 'no-folder')
		}
	}

	/**
	 * Turn a caller-supplied name into a full path inside the folder, refusing anything that would leave it:
	 * "..", absolute paths, drive letters, NUL bytes, backslashes, and symlinks pointing outside.
	 * `mustExist`: also resolve symlinks on the file itself.
	 */
	async resolveName(name: string, mustExist = true): Promise<string> {
		if (typeof name !== 'string' || !name || name.includes('\0')) throw new FileError('No file name given', 'bad-name')
		let n: string
		try {
			n = decodeURIComponent(name)
		} catch {
			n = name
		}
		if (n !== name && n.includes('\0')) throw new FileError('Bad file name', 'bad-name')
		const parts = n.split(/[\\/]/)
		if (isAbsolute(n) || /^[a-zA-Z]:/.test(n) || parts.some((p) => p === '..' || p === '.') || parts.some((p) => p === ''))
			throw new FileError("That file isn't in the recording folder", 'outside')
		if (parts.length - 1 > this.settings.depth) throw new FileError("That file isn't in the recording folder", 'outside')
		if (n.includes('\\')) throw new FileError("That file isn't in the recording folder", 'outside')
		const root = await this.realRoot()
		const full = resolve(root, ...parts)
		if (!isInside(root, full)) throw new FileError("That file isn't in the recording folder", 'outside')
		// make sure no symlinked folder (or the file itself) leads outside
		let check = mustExist ? full : dirname(full)
		try {
			check = await realpath(check)
		} catch {
			if (mustExist) throw new FileError(`There's no file called "${n}"`, 'not-found')
			throw new FileError("That folder isn't there", 'not-found')
		}
		if (!isInside(root, check)) throw new FileError("That file isn't in the recording folder", 'outside')
		return mustExist ? check : full
	}

	private wanted(name: string): boolean {
		const low = name.toLowerCase()
		if (!this.settings.showHidden && basename(name).startsWith('.')) return false
		if (!this.settings.extensions.length) return true
		return this.settings.extensions.some((e) => low.endsWith('.' + e.toLowerCase().replace(/^\./, '')))
	}

	/** Recordings in the folder, newest first */
	async list(): Promise<RecordingFile[]> {
		const root = await this.realRoot()
		const out: RecordingFile[] = []
		const walk = async (dir: string, depth: number) => {
			let ents
			try {
				ents = await readdir(dir, { withFileTypes: true })
			} catch (e: any) {
				if (dir === root) throw new FileError(`Can't read the recording folder: ${e?.code ?? e?.message}`, 'io')
				return
			}
			for (const e of ents) {
				const full = join(dir, e.name)
				if (!this.settings.showHidden && e.name.startsWith('.')) continue
				let st
				try {
					st = await stat(full)
					if (e.isSymbolicLink() && !isInside(root, await realpath(full))) continue
				} catch {
					continue
				}
				if (st.isDirectory()) {
					if (depth < this.settings.depth) await walk(full, depth + 1)
					continue
				}
				if (!st.isFile() || !this.wanted(e.name)) continue
				const rel = relative(root, full).split(sep).join('/')
				out.push({
					name: rel,
					size: st.size,
					modified: st.mtimeMs,
					duration: this.settings.readDurations ? await this.duration(full, st.size, st.mtimeMs) : null,
					ext: splitExt(e.name).ext.toLowerCase(),
					type: contentTypeFor(e.name),
				})
			}
		}
		await walk(root, 0)
		out.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))
		return out
	}

	private async duration(full: string, size: number, mtime: number): Promise<number | null> {
		const key = `${full}\0${size}\0${mtime}`
		if (this.durCache.has(key)) return this.durCache.get(key)!
		const d = await readDuration(full)
		if (this.durCache.size > 2000) this.durCache.clear()
		this.durCache.set(key, d)
		return d
	}

	/** Details of one file */
	async info(name: string): Promise<RecordingFile> {
		const full = await this.resolveName(name)
		const st = await stat(full)
		if (!st.isFile()) throw new FileError(`"${name}" isn't a file`, 'not-found')
		return {
			name: name.split('\\').join('/'),
			size: st.size,
			modified: st.mtimeMs,
			duration: this.settings.readDurations ? await this.duration(full, st.size, st.mtimeMs) : null,
			ext: splitExt(basename(full)).ext.toLowerCase(),
			type: contentTypeFor(full),
		}
	}

	private isBusy(name: string): boolean {
		for (const b of this.opts.busy?.() ?? []) if (b.toLowerCase() === name.toLowerCase()) return true
		return false
	}

	/**
	 * Rename a recording. `to` is a new file name (same folder as the original). The extension is kept if `to` has none
	 * (or has a different one: recordings keep their real type). Refuses if the new name is taken (case-insensitive).
	 * Returns the new relative name.
	 */
	async rename(from: string, to: string): Promise<string> {
		const src = await this.resolveName(from)
		if (this.isBusy(from)) throw new FileError("That file is still being recorded. Rename it after it's stopped", 'busy')
		const oldExt = extname(src)
		let base = to.trim()
		if (/[\\/]/.test(base)) throw new FileError("A new name can't have / or \\ in it", 'bad-name')
		if (oldExt && base.toLowerCase().endsWith(oldExt.toLowerCase())) base = base.slice(0, -oldExt.length)
		const cleaned = cleanFileName(base, this.opts.naming ?? { replaceWith: '_', maxLength: 200 })
		if (!cleaned) throw new FileError("That name's empty once the characters files can't have are taken out", 'bad-name')
		const newName = cleaned + oldExt
		const dst = join(dirname(src), newName)
		const relDir = dirname(from.split('\\').join('/'))
		const rel = relDir === '.' ? newName : `${relDir}/${newName}`
		if (dst === src) return rel
		const sameIgnoringCase = dst.toLowerCase() === src.toLowerCase()
		if (!sameIgnoringCase) {
			const siblings = await readdir(dirname(src))
			if (siblings.some((s) => s.toLowerCase() === newName.toLowerCase())) throw new FileError(`There's already a file called "${newName}"`, 'exists')
		}
		try {
			await fsRename(src, dst)
		} catch (e: any) {
			if (e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES') throw new FileError(`Can't rename it: the file is in use or locked (${e.code})`, 'busy')
			throw new FileError(`Couldn't rename it: ${e?.code ?? e?.message}`, 'io')
		}
		this.forgetTokens(from)
		return rel
	}

	/**
	 * Step 1 of deleting: get a confirm token for a file (valid for settings.deleteTokenMs, tied to the file's current
	 * size and modified time so a token can't delete a different file that later takes the same name).
	 */
	async requestDelete(name: string): Promise<{ token: string; expires: number; file: RecordingFile }> {
		const file = await this.info(name)
		const token = randomBytes(16).toString('hex')
		this.prune()
		this.tokens.set(token, { name: file.name, size: file.size, modified: file.modified, expires: this.now() + this.settings.deleteTokenMs })
		return { token, expires: this.now() + this.settings.deleteTokenMs, file }
	}

	/** Step 2: delete with the token from requestDelete. One token, one delete. */
	async delete(name: string, confirmToken: string): Promise<void> {
		this.prune()
		const t = typeof confirmToken === 'string' ? this.tokens.get(confirmToken) : undefined
		const n = name.split('\\').join('/')
		if (!t || t.name !== n) throw new FileError('Delete needs confirming first (or the confirmation ran out: ask again)', 'confirm')
		const full = await this.resolveName(name)
		if (this.isBusy(name)) throw new FileError("That file is still being recorded. Stop the recording first", 'busy')
		const st = await lstat(full)
		if (st.size !== t.size || st.mtimeMs !== t.modified) {
			this.tokens.delete(confirmToken)
			throw new FileError('That file has changed since you confirmed. Ask again', 'confirm')
		}
		this.tokens.delete(confirmToken)
		try {
			await unlink(full)
		} catch (e: any) {
			throw new FileError(`Couldn't delete it: ${e?.code ?? e?.message}`, e?.code === 'EBUSY' ? 'busy' : 'io')
		}
		this.forgetTokens(n)
	}

	private prune(): void {
		const now = this.now()
		for (const [k, v] of this.tokens) if (v.expires <= now) this.tokens.delete(k)
	}
	private forgetTokens(name: string): void {
		const n = name.split('\\').join('/')
		for (const [k, v] of this.tokens) if (v.name === n) this.tokens.delete(k)
	}

	/**
	 * Serve a file over HTTP with Range support (for the browser's video player and for downloads). Handles GET and HEAD.
	 * The caller does routing and any login check, then calls this with the file's name.
	 * `download`: send Content-Disposition: attachment (otherwise inline, for preview).
	 * Never throws: errors become plain-words text responses.
	 */
	async serve(req: IncomingMessage, res: ServerResponse, name: string, opts: { download?: boolean } = {}): Promise<void> {
		const fail = (status: number, msg: string, extra: Record<string, string> = {}) => {
			if (res.headersSent) return void res.destroy()
			res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
			res.end(msg)
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Only GET and HEAD here', { Allow: 'GET, HEAD' })
		let full: string
		let size: number
		let mtime: Date
		try {
			full = await this.resolveName(name)
			const st = await stat(full)
			if (!st.isFile()) throw new FileError(`"${name}" isn't a file`, 'not-found')
			size = st.size
			mtime = st.mtime
		} catch (e: any) {
			return fail(e instanceof FileError ? e.status : 500, e?.message ?? 'Error')
		}
		const etag = `W/"${size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}"`
		const fname = basename(full)
		const ascii = fname.replace(/[^\x20-\x7e]|["\\]/g, '_')
		const headers: Record<string, string> = {
			'Content-Type': contentTypeFor(full),
			'Accept-Ranges': 'bytes',
			'Last-Modified': mtime.toUTCString(),
			ETag: etag,
			'Cache-Control': 'no-cache',
			'Content-Disposition': `${opts.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
		}
		let start = 0
		let end = size - 1
		let status = 200
		const range = req.headers.range
		const ifRange = req.headers['if-range']
		const rangeOk = range && (!ifRange || ifRange === etag || ifRange === headers['Last-Modified'])
		if (rangeOk) {
			const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
			if (!m || (m[1] === '' && m[2] === '')) {
				if (!/,/.test(String(range))) return fail(416, 'Bad Range header', { 'Content-Range': `bytes */${size}` })
				// multiple ranges: not supported, send the whole file (allowed by RFC 9110)
			} else {
				if (m[1] === '') {
					const n = Number(m[2])
					start = Math.max(0, size - n)
				} else {
					start = Number(m[1])
					end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
				}
				if (start >= size || start > end || (m[1] === '' && Number(m[2]) === 0)) return fail(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` })
				status = 206
				headers['Content-Range'] = `bytes ${start}-${end}/${size}`
			}
		}
		if (status === 200 && req.headers['if-none-match'] === etag) {
			res.writeHead(304, { ETag: etag })
			return void res.end()
		}
		headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
		res.writeHead(status, headers)
		if (req.method === 'HEAD' || size === 0) return void res.end()
		const stream = createReadStream(full, { start, end })
		stream.on('error', () => res.destroy())
		res.on('close', () => stream.destroy())
		stream.pipe(res)
	}
}
