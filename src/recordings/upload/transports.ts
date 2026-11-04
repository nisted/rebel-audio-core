/** How files actually get sent. Each transport copies one local file to one destination. */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink, access } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import type { Destination, HttpDestination, ShareDestination, UploadSettings, WebdavDestination, FtpDestination, RcloneDestination } from '../settings.js'
import { checkRclone, explainRcloneError, joinRemote, parseRcloneProgress, rcloneRetryable, rcloneTarget, runRclone, type Spawner } from './rclone.js'
import { spawn } from 'node:child_process'

export class UploadError extends Error {
	constructor(
		message: string,
		/** Worth trying again later (network trouble) rather than needing someone to fix a setting */
		readonly retryable: boolean,
	) {
		super(message)
	}
}

export interface TransferJob {
	localPath: string
	/** "a/b" or "" (top level), always "/" separated */
	remoteFolder: string
	remoteName: string
	size: number
}

export interface TransferContext {
	signal: AbortSignal
	/** Bytes sent so far */
	progress: (bytes: number) => void
	settings: UploadSettings
}

export interface Transport {
	upload(job: TransferJob, dest: Destination, ctx: TransferContext): Promise<{ remote: string }>
}

// ---------- network share / NAS: plain copy ----------

export const shareTransport: Transport = {
	async upload(job, dest, ctx) {
		const d = dest as ShareDestination & Destination
		if (!d.path) throw new UploadError('No network share folder set', false)
		const root = resolve(d.path)
		try {
			await access(root)
		} catch (e: any) {
			throw new UploadError(`Can't reach the network share (${d.path}): is it mounted / connected? (${e?.code ?? e})`, true)
		}
		const dir = join(root, ...job.remoteFolder.split('/').filter(Boolean))
		const final = join(dir, job.remoteName)
		const tmp = join(dir, `.${job.remoteName}.${randomBytes(4).toString('hex')}.partial`)
		try {
			await mkdir(dir, { recursive: true })
			let sent = 0
			const counter = new Transform({
				transform(chunk, _e, cb) {
					sent += chunk.length
					ctx.progress(sent)
					cb(null, chunk)
				},
			})
			await pipeline(createReadStream(job.localPath), counter, createWriteStream(tmp), { signal: ctx.signal })
			await rename(tmp, final)
			return { remote: final }
		} catch (e: any) {
			await unlink(tmp).catch(() => {})
			if (e instanceof UploadError) throw e
			if (ctx.signal.aborted) throw new UploadError('Stopped', true)
			const code = e?.code ?? ''
			if (code === 'ENOENT' && !(await exists(job.localPath))) throw new UploadError("The recording isn't there any more (moved or deleted?)", false)
			if (code === 'ENOSPC') throw new UploadError('The network share is full', false)
			if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new UploadError("Not allowed to write to the network share (check it's not read-only and the login can write)", false)
			throw new UploadError(`Copy to the network share failed (${code || e?.message}). It'll try again`, true)
		}
	},
}

async function exists(p: string) {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

// ---------- HTTP POST/PUT and WebDAV ----------

function basicAuth(user: string, pass: string): Record<string, string> {
	return user || pass ? { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } : {}
}

function encodePath(p: string): string {
	return p
		.split('/')
		.filter(Boolean)
		.map(encodeURIComponent)
		.join('/')
}

function joinUrl(base: string, path: string): string {
	return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

interface SendOpts {
	method: string
	url: string
	headers: Record<string, string>
	body?: { path: string; size: number; before?: Buffer; after?: Buffer }
	signal: AbortSignal
	progress?: (b: number) => void
	stallMs: number
}

function send(o: SendOpts): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
	return new Promise((resolveP, reject) => {
		let u: URL
		try {
			u = new URL(o.url)
		} catch {
			return reject(new UploadError(`That upload address isn't a proper URL: ${o.url}`, false))
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new UploadError(`Upload addresses must start http:// or https:// (got ${u.protocol})`, false))
		const auth = u.username || u.password ? basicAuth(decodeURIComponent(u.username), decodeURIComponent(u.password)) : {}
		u.username = ''
		u.password = ''
		const len = o.body ? o.body.size + (o.body.before?.length ?? 0) + (o.body.after?.length ?? 0) : 0
		const headers: Record<string, string> = { ...auth, ...o.headers }
		if (o.body || o.method === 'PUT' || o.method === 'POST') headers['Content-Length'] = String(len)
		const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: o.method, headers, signal: o.signal, agent: false })
		let stall: ReturnType<typeof setTimeout> | null = null
		const poke = () => {
			if (stall) clearTimeout(stall)
			stall = setTimeout(() => req.destroy(new UploadError(`The upload stalled (nothing sent for ${Math.round(o.stallMs / 1000)} s)`, true)), o.stallMs)
		}
		const unstall = () => {
			if (stall) clearTimeout(stall)
			stall = null
		}
		req.on('close', unstall)
		poke()
		req.on('response', (res) => {
			let body = ''
			res.setEncoding('utf8')
			res.on('data', (d) => {
				if (body.length < 4000) body += d
			})
			unstall()
			res.on('end', () => {
				resolveP({ status: res.statusCode ?? 0, body, headers: res.headers })
			})
			res.on('error', reject)
		})
		req.on('error', (e: any) => {
			if (stall) clearTimeout(stall)
			if (e instanceof UploadError) return reject(e)
			if (o.signal.aborted) return reject(new UploadError('Stopped', true))
			reject(netError(e, u.host))
		})
		if (!o.body) return void req.end()
		if (o.body.before) req.write(o.body.before)
		let sent = 0
		const rs = createReadStream(o.body.path)
		rs.on('data', (chunk) => {
			sent += chunk.length
			if (req.destroyed || req.writableEnded) return void rs.destroy()
			poke()
			o.progress?.(sent)
			if (!req.write(chunk)) {
				rs.pause()
				req.once('drain', () => rs.resume())
			}
		})
		rs.on('end', () => {
			if (o.body!.after) req.write(o.body!.after)
			req.end()
		})
		rs.on('error', (e: any) => req.destroy(e?.code === 'ENOENT' ? new UploadError("The recording isn't there any more (moved or deleted?)", false) : new UploadError(`Couldn't read the recording (${e?.code})`, true)))
	})
}

function netError(e: any, host: string): UploadError {
	const code = e?.code ?? ''
	if (/ENOTFOUND|EAI_AGAIN/.test(code)) return new UploadError(`Can't find ${host} on the network (no internet or a typo in the address). It'll try again`, true)
	if (code === 'ECONNREFUSED') return new UploadError(`${host} isn't accepting connections (is the server running? right port?). It'll try again`, true)
	if (/ECONNRESET|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up/.test(code + (e?.message ?? ''))) return new UploadError(`The connection to ${host} dropped (${code || 'hang up'}). It'll try again`, true)
	if (/CERT|SSL|TLS/i.test(code)) return new UploadError(`${host}'s security certificate isn't trusted (${code})`, false)
	return new UploadError(`Upload to ${host} failed: ${e?.message ?? e}`, true)
}

function httpStatusError(status: number, body: string, what: string): UploadError {
	const detail = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
	if (status === 401 || status === 403) return new UploadError(`${what} refused the login (${status}). Check the user name and password`, false)
	if (status === 404) return new UploadError(`${what} says that address doesn't exist (404). Check the URL / folder`, false)
	if (status === 405) return new UploadError(`${what} doesn't allow that kind of upload here (405). Try POST instead of PUT, or check the URL`, false)
	if (status === 409) return new UploadError(`${what} says the folder isn't there (409). Turn on "make missing folders" or create it`, false)
	if (status === 413) return new UploadError(`${what} says the file is too big (413)`, false)
	if (status === 507) return new UploadError(`${what} is full (507)`, false)
	if (status >= 500 || status === 408 || status === 429) return new UploadError(`${what} had a problem (${status}${detail ? ': ' + detail : ''}). It'll try again`, true)
	return new UploadError(`${what} said no (${status}${detail ? ': ' + detail : ''})`, false)
}

export const httpTransport: Transport = {
	async upload(job, dest, ctx) {
		const d = dest as HttpDestination & Destination
		if (!d.url) throw new UploadError('No upload address set', false)
		const rel = job.remoteFolder ? `${job.remoteFolder}/${job.remoteName}` : job.remoteName
		const hasTokens = /\{(path|name|folder)\}/.test(d.url)
		const url = hasTokens
			? d.url.replace(/\{path\}/g, encodePath(rel)).replace(/\{name\}/g, encodeURIComponent(job.remoteName)).replace(/\{folder\}/g, encodePath(job.remoteFolder))
			: d.method === 'PUT'
				? joinUrl(d.url, encodePath(rel))
				: d.url
		const headers: Record<string, string> = { ...basicAuth(d.user, d.password), ...d.headers }
		let body: SendOpts['body']
		if (d.method === 'POST' && d.postFormat === 'multipart') {
			const boundary = '----rebel' + randomBytes(12).toString('hex')
			const q = (s: string) => s.replace(/["\r\n\\]/g, '_')
			const before = Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="folder"\r\n\r\n${job.remoteFolder}\r\n` +
					`--${boundary}\r\nContent-Disposition: form-data; name="${q(d.fieldName || 'file')}"; filename="${q(job.remoteName)}"; filename*=UTF-8''${encodeURIComponent(job.remoteName)}\r\nContent-Type: application/octet-stream\r\n\r\n`,
			)
			const after = Buffer.from(`\r\n--${boundary}--\r\n`)
			headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
			body = { path: job.localPath, size: job.size, before, after }
		} else {
			headers['Content-Type'] ??= 'application/octet-stream'
			if (d.method === 'POST') {
				headers['X-File-Name'] = encodeURIComponent(job.remoteName)
				headers['X-Folder'] = encodeURIComponent(job.remoteFolder)
			}
			body = { path: job.localPath, size: job.size }
		}
		const r = await send({ method: d.method, url, headers, body, signal: ctx.signal, progress: ctx.progress, stallMs: ctx.settings.stallTimeoutMs })
		if (r.status < 200 || r.status >= 300) throw httpStatusError(r.status, r.body, 'The upload server')
		return { remote: url }
	},
}

export const webdavTransport: Transport = {
	async upload(job, dest, ctx) {
		const d = dest as WebdavDestination & Destination
		if (!d.url) throw new UploadError('No WebDAV address set', false)
		const headers = { ...basicAuth(d.user, d.password), ...d.headers }
		if (d.createFolders && job.remoteFolder) {
			let path = ''
			for (const seg of job.remoteFolder.split('/').filter(Boolean)) {
				path += '/' + encodeURIComponent(seg)
				const r = await send({ method: 'MKCOL', url: joinUrl(d.url, path), headers, signal: ctx.signal, stallMs: ctx.settings.stallTimeoutMs })
				// 201 made, 405 already there; some servers say 301/409 oddly
				if (!(r.status === 201 || r.status === 405 || r.status === 301 || (r.status >= 200 && r.status < 300))) throw httpStatusError(r.status, r.body, 'The WebDAV server')
			}
		}
		const url = joinUrl(d.url, encodePath(job.remoteFolder ? `${job.remoteFolder}/${job.remoteName}` : job.remoteName))
		const r = await send({ method: 'PUT', url, headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: { path: job.localPath, size: job.size }, signal: ctx.signal, progress: ctx.progress, stallMs: ctx.settings.stallTimeoutMs })
		if (r.status < 200 || r.status >= 300) throw httpStatusError(r.status, r.body, 'The WebDAV server')
		return { remote: url }
	},
}

// ---------- rclone (cloud, FTP, SFTP) ----------

export function rcloneTransport(spawner: Spawner = (c, a) => spawn(c, a, { windowsHide: true })): Transport {
	let checked: { path: string; ok: boolean; error: string | null } | null = null
	const obscured = new Map<string, string>()
	return {
		async upload(job, dest, ctx) {
			const s = ctx.settings
			if (!checked || checked.path !== s.rclonePath) {
				const c = await checkRclone(s.rclonePath, spawner)
				checked = { path: s.rclonePath, ok: c.ok, error: c.error }
			}
			if (!checked.ok) {
				const err = checked.error!
				checked = null // check again next time (they may have installed it)
				throw new UploadError(err, false)
			}
			let pass = ''
			const d = dest as Destination & (RcloneDestination | FtpDestination)
			if (d.kind !== 'rclone' && d.password) {
				pass = obscured.get(d.password) ?? ''
				if (!pass) {
					const r = await runRclone(s.rclonePath, ['obscure', '-'], (c, a) => {
						const p = spawner(c, a)
						p.stdin?.end(d.password)
						return p
					})
					pass = r.stdout.trim()
					if (r.code !== 0 || !pass) throw new UploadError("rclone couldn't prepare the password", false)
					obscured.set(d.password, pass)
				}
			}
			let target: string
			try {
				target = joinRemote(rcloneTarget(d, pass), job.remoteFolder, job.remoteName)
			} catch (e: any) {
				throw new UploadError(e.message, false)
			}
			const args = ['copyto', job.localPath, target, '--stats', '1s', '--stats-one-line', '--stats-log-level', 'NOTICE', '--retries', '1', '--low-level-retries', '3', ...s.rcloneArgs]
			if (d.kind === 'sftp' && !d.port) {
				/* rclone defaults to 22 */
			}
			return await new Promise((resolveP, reject) => {
				let p
				try {
					p = spawner(s.rclonePath, args)
				} catch (e: any) {
					return reject(new UploadError(`Couldn't start rclone: ${e?.message}`, false))
				}
				let stderr = ''
				const onLine = (line: string) => {
					const pr = parseRcloneProgress(line)
					if (pr.bytes !== null) ctx.progress(pr.bytes)
					else if (pr.percent !== null) ctx.progress(Math.round((job.size * pr.percent) / 100))
				}
				let buf = ''
				p.stderr?.on('data', (dch: Buffer) => {
					const t = dch.toString()
					if (stderr.length < 20000) stderr += t
					buf += t
					const lines = buf.split(/\r?\n|\r/)
					buf = lines.pop() ?? ''
					lines.forEach(onLine)
				})
				p.stdout?.on('data', (dch: Buffer) => dch.toString().split(/\r?\n|\r/).forEach(onLine))
				const abort = () => p.kill()
				ctx.signal.addEventListener('abort', abort, { once: true })
				p.on('error', (e: any) => {
					ctx.signal.removeEventListener('abort', abort)
					reject(new UploadError(e?.code === 'ENOENT' ? checkRcloneMissing() : `rclone failed to start: ${e?.message}`, false))
				})
				p.on('close', (code) => {
					ctx.signal.removeEventListener('abort', abort)
					if (ctx.signal.aborted) return reject(new UploadError('Stopped', true))
					if (code === 0) {
						ctx.progress(job.size)
						return resolveP({ remote: target.replace(/pass=('(?:[^']|'')*'|[^,:]*)/, 'pass=***') })
					}
					const msg = explainRcloneError(stderr, code)
					reject(new UploadError(msg, rcloneRetryable(msg)))
				})
			})
		},
	}
}

function checkRcloneMissing(): string {
	return "rclone isn't installed on this computer. Get it from https://rclone.org/downloads/ and set up your remote with \"rclone config\""
}

export interface TransportSet {
	rclone: Transport
	share: Transport
	http: Transport
	webdav: Transport
}

export function defaultTransports(spawner?: Spawner): TransportSet {
	return { rclone: rcloneTransport(spawner), share: shareTransport, http: httpTransport, webdav: webdavTransport }
}

export function transportFor(set: TransportSet, d: Destination): Transport {
	switch (d.kind) {
		case 'rclone':
		case 'ftp':
		case 'sftp':
			return set.rclone
		case 'share':
			return set.share
		case 'http':
			return set.http
		case 'webdav':
			return set.webdav
	}
}
