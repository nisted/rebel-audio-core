/** rclone: Google Drive / Dropbox / OneDrive / anything rclone knows, plus FTP/SFTP through on-the-fly remotes. */
import { spawn, type ChildProcess } from 'node:child_process'
import { posix } from 'node:path'
import type { FtpDestination, RcloneDestination } from '../settings.js'

export const RCLONE_HELP =
	"rclone isn't installed on this computer (or isn't where the settings say). Get it from https://rclone.org/downloads/ " +
	'(Mac: "brew install rclone"; Windows: "winget install Rclone.Rclone"; Linux/Pi: "sudo -v ; curl https://rclone.org/install.sh | sudo bash"), ' +
	'then set up your Google Drive (or other) remote with "rclone config", the same way as for Companion Sync. ' +
	'If it is installed somewhere unusual, put its full path in the rclone program setting.'

export type Spawner = (cmd: string, args: string[]) => ChildProcess

export interface RcloneCheck {
	ok: boolean
	version: string | null
	/** Plain words, with how to get it if missing */
	error: string | null
}

/** Run a short rclone command and collect its output */
export function runRclone(path: string, args: string[], spawner: Spawner = (c, a) => spawn(c, a, { windowsHide: true }), timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let p: ChildProcess
		try {
			p = spawner(path, args)
		} catch (e) {
			return reject(e)
		}
		let stdout = ''
		let stderr = ''
		const t = setTimeout(() => p.kill(), timeoutMs)
		p.stdout?.on('data', (d) => (stdout += d))
		p.stderr?.on('data', (d) => (stderr += d))
		p.on('error', (e) => {
			clearTimeout(t)
			reject(e)
		})
		p.on('close', (code) => {
			clearTimeout(t)
			resolve({ code, stdout, stderr })
		})
	})
}

/** Is rclone there? */
export async function checkRclone(path: string, spawner?: Spawner): Promise<RcloneCheck> {
	try {
		const r = await runRclone(path, ['version'], spawner, 10000)
		if (r.code !== 0) return { ok: false, version: null, error: `rclone is there but didn't run properly: ${firstLine(r.stderr) || 'exit ' + r.code}` }
		return { ok: true, version: /rclone\s+(v[\w.\-]+)/.exec(r.stdout)?.[1] ?? firstLine(r.stdout), error: null }
	} catch (e: any) {
		if (e?.code === 'ENOENT') return { ok: false, version: null, error: RCLONE_HELP }
		if (e?.code === 'EACCES') return { ok: false, version: null, error: `rclone was found but this computer won't let it run (permission denied). ${RCLONE_HELP}` }
		return { ok: false, version: null, error: `Couldn't run rclone: ${e?.message ?? e}` }
	}
}

/** Remote names set up in rclone config (without the trailing colon) */
export async function listRemotes(path: string, spawner?: Spawner): Promise<string[]> {
	const r = await runRclone(path, ['listremotes'], spawner)
	return r.stdout
		.split(/\r?\n/)
		.map((l) => l.trim().replace(/:$/, ''))
		.filter(Boolean)
}

export function firstLine(s: string): string {
	return (
		s
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find(Boolean) ?? ''
	)
}

/** Quote a value for an rclone connection string (key='va,l''ue') */
export function rcloneQuote(v: string): string {
	return /^[\w.\-/@]*$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`
}

/**
 * Turn a destination into an rclone target prefix ("remote:" / "remote:base/" / ":ftp,host=…:base/").
 * FTP/SFTP passwords must be obscured for rclone: pass `obscured` (from `rclone obscure`).
 */
export function rcloneTarget(d: RcloneDestination | FtpDestination, obscuredPassword = ''): string {
	if (d.kind === 'rclone') {
		const r = d.remote.trim()
		if (!r) throw new Error('No rclone remote set. Put the remote name from "rclone config" (e.g. gdrive) in the settings')
		if (r.includes(':')) return r.endsWith(':') || r.endsWith('/') ? r : r + '/'
		return r + ':'
	}
	const parts = [`host=${rcloneQuote(d.host)}`]
	if (d.port) parts.push(`port=${d.port}`)
	if (d.user) parts.push(`user=${rcloneQuote(d.user)}`)
	if (obscuredPassword) parts.push(`pass=${rcloneQuote(obscuredPassword)}`)
	if (d.kind === 'ftp' && d.tls) parts.push('explicit_tls=true')
	const base = d.basePath.replace(/^\/+|\/+$/g, '')
	return `:${d.kind},${parts.join(',')}:${base ? base + '/' : ''}`
}

export function joinRemote(prefix: string, folder: string, name: string): string {
	const rel = posix.join(folder || '.', name).replace(/^\.\//, '')
	return prefix.endsWith(':') || prefix.endsWith('/') ? prefix + rel : prefix + '/' + rel
}

/** Pull a percentage out of rclone's --stats-one-line output */
export function parseRcloneProgress(line: string): { percent: number | null; bytes: number | null } {
	const pc = /(\d{1,3})%/.exec(line)
	const by = /([\d.]+)\s*([KMGT]i?)?B\s*\/\s*[\d.]+\s*[KMGT]?i?B/.exec(line)
	let bytes: number | null = null
	if (by) {
		const mult: Record<string, number> = { K: 1e3, Ki: 1024, M: 1e6, Mi: 1048576, G: 1e9, Gi: 1073741824, T: 1e12, Ti: 1099511627776 }
		bytes = Math.round(Number(by[1]) * (by[2] ? mult[by[2]] ?? 1 : 1))
	}
	return { percent: pc ? Math.min(100, Number(pc[1])) : null, bytes }
}

/** Plain words for common rclone failures */
export function explainRcloneError(stderr: string, code: number | null): string {
	const s = stderr
	if (/didn't find section in config file|not found in config file|NOTICE: Config file .* not found/i.test(s))
		return 'That rclone remote name isn\'t set up on this computer. Run "rclone config" to add it, or check the spelling in the settings'
	if (/couldn't fetch token|invalid_grant|token expired|oauth2/i.test(s)) return 'rclone\'s login to the cloud has run out. Run "rclone config reconnect <remote>:" on this computer'
	if (/no such host|dial tcp|i\/o timeout|connection refused|network is unreachable|TLS handshake timeout|connection reset/i.test(s)) return "Can't reach the upload server: the network looks down. It'll try again"
	if (/quota|storageQuotaExceeded|insufficient storage/i.test(s)) return 'The destination is full (out of storage quota)'
	if (/permission denied|403|forbidden|access denied|530 Login/i.test(s)) return 'The destination refused the upload: check the login details and that you can write to that folder'
	if (/directory not found|object not found/i.test(s)) return "rclone couldn't find the destination folder"
	const err = s
		.split(/\r?\n/)
		.filter((l) => /ERROR|Failed|CRITICAL/i.test(l))
		.pop()
	return `rclone failed${code !== null ? ` (exit ${code})` : ''}: ${(err ?? firstLine(s)).replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s*/, '') || 'no details'}`
}

/** Errors worth retrying (network) vs. ones that need a person (config, login, full) */
export function rcloneRetryable(msg: string): boolean {
	return /network|reach|timed out|try again|exit/i.test(msg) && !/isn't set up|run out|full|refused the upload/i.test(msg)
}
