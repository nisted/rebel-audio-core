/**
 * The module's own web server: the fader and meter page, a live feed
 * (Server-Sent Events, which OBS's browser docks handle well) and a small
 * command API. Optional PIN: sent as ?pin= or an X-Rebel-Pin header.
 *
 * The page is the same for every device: it draws each strip from the
 * input's capabilities and the device's processing table (see device.ts).
 *
 * Page joining: every API answer carries CORS headers, so a page served by
 * one connection can open the live feed of, and send commands to, any other
 * (OBS Audio, ATEM Audio: same API). The server also says hello on the
 * network (discovery.ts) and lists who it has heard at /api/peers.
 *
 * Endpoints (all but / and /api/info need the PIN when one is set):
 *   GET  /               the page
 *   GET  /api/info       who this is (name, module, device, PIN or not)
 *   GET  /api/peers      other pages heard on the network
 *   GET  /events         live feed (SSE): meta, state, meters
 *   POST /cmd            commands (JSON {cmd, ...})
 *   GET  /export         settings export
 *   GET  /rec/state      recordings: everything the Recordings tab shows
 *   GET  /rec/files      recordings: the file list
 *   GET  /rec/file?name= recordings: one file (Range-capable; &download=1 to save it)
 *   POST /rec/sheet?name= recordings: a CSV or Excel file as the body, used as the sheet
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Beacon, BEACON_PORT, type BeaconMessage } from './discovery.js'
import { FileError } from './recordings/files.js'
import type { Engine } from './engine.js'
import { PAGE_HTML } from './page.js'
import { parseDb } from './law.js'
import type { ImportPart, PageSettings, Section, SectionMode } from './settings.js'

/** The page with this module's name filled in */
export function pageHtml(appId: string, appName: string): string {
	const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
	return PAGE_HTML.replaceAll('%APP_NAME_UPPER%', esc(appName.toUpperCase())).replaceAll('%APP_NAME%', esc(appName)).replaceAll('%APP_ID%', esc(appId))
}

export interface WebOptions {
	port: number
	bind: string
	pin: string
	/**
	 * Announce this page on the network so other pages can join it, and
	 * listen for theirs. Leave out (or port 0) for off. Default port: BEACON_PORT.
	 */
	beacon?: { port: number; everyMs?: number; group?: string; broadcast?: boolean }
	/** The connection's name as people know it (Companion's connection label). Called each time it's needed. */
	name?: () => string
}

export { BEACON_PORT }

const MAX_BODY = 4 * 1024 * 1024
const MAX_SHEET = 20 * 1024 * 1024

/** CORS headers on every API answer, so pages on other connections can join this one */
const CORS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Rebel-Pin, Range',
	'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
	'Access-Control-Max-Age': '600',
}

export class WebServer {
	#server: Server | null = null
	#clients = new Set<ServerResponse>()
	#engine: Engine
	#opts: WebOptions
	#meterTimer: NodeJS.Timeout | null = null
	#onState = () => this.#broadcast('state', this.#engine.snapshot())
	#onStatus = this.#onState
	#log: (level: 'info' | 'warn' | 'error', msg: string) => void
	#html: string
	#beacon: Beacon | null = null
	/** Random per running server: how pages tell sources apart (and spot themselves) */
	readonly id = randomBytes(6).toString('hex')

	constructor(engine: Engine, opts: WebOptions, log: (level: 'info' | 'warn' | 'error', msg: string) => void) {
		this.#engine = engine
		this.#opts = opts
		this.#log = log
		this.#html = pageHtml(engine.opts.appId, engine.opts.appName)
	}

	start(): void {
		const server = createServer((req, res) => void this.#handle(req, res))
		server.on('error', (e) => this.#log('error', `Web page server: ${e.message}`))
		server.listen(this.#opts.port, this.#opts.bind || '0.0.0.0', () => {
			this.#log('info', `Fader page on port ${this.port}`)
			const b = this.#opts.beacon
			if (b && b.port > 0) {
				this.#beacon = new Beacon({
					port: b.port,
					everyMs: b.everyMs,
					group: b.group,
					broadcast: b.broadcast,
					message: () => this.#beaconMessage(),
					log: (l, m) => this.#log(l === 'debug' ? 'info' : l, m),
				})
				this.#beacon.start()
			}
		})
		this.#server = server
		this.#engine.on('state', this.#onState)
		this.#engine.on('status', this.#onStatus)
		this.#restartMeters()
	}

	/** The port actually listened on (useful when 0 was asked for) */
	get port(): number {
		const a = this.#server?.address()
		return a && typeof a === 'object' ? a.port : 0
	}

	#restartMeters(): void {
		if (this.#meterTimer) clearInterval(this.#meterTimer)
		const hz = Math.max(1, Math.min(30, this.#engine.store.page.meterRateHz || 20))
		this.#meterTimer = setInterval(() => {
			if (this.#clients.size) this.#broadcast('meters', this.#engine.meterFrame())
		}, 1000 / hz)
	}

	/** Who this is, for beacons and /api/info */
	info(): BeaconMessage {
		const e = this.#engine
		const bind = this.#opts.bind && this.#opts.bind !== '0.0.0.0' ? this.#opts.bind : undefined
		return {
			rebel: 1,
			id: this.id,
			app: e.opts.appId,
			appName: e.opts.appName,
			name: this.#opts.name?.() || e.sourceName || e.opts.appName,
			port: this.port,
			bind,
			pin: !!this.#opts.pin,
			version: e.opts.moduleVersion,
			device: e.info.label,
		}
	}

	#beaconMessage(): BeaconMessage {
		return this.info()
	}

	/** Pages heard on the network (empty when the finder is off) */
	peers() {
		return this.#beacon?.peers() ?? []
	}

	stop(): void {
		this.#beacon?.stop()
		this.#beacon = null
		if (this.#meterTimer) clearInterval(this.#meterTimer)
		this.#meterTimer = null
		this.#engine.off('state', this.#onState)
		this.#engine.off('status', this.#onStatus)
		for (const c of this.#clients) c.end()
		this.#clients.clear()
		this.#server?.close()
		this.#server = null
	}

	#pinOk(url: URL, req?: IncomingMessage): boolean {
		if (!this.#opts.pin) return true
		const h = req?.headers['x-rebel-pin']
		const given = (Array.isArray(h) ? h[0] : h) ?? url.searchParams.get('pin') ?? ''
		const a = Buffer.from(given)
		const b = Buffer.from(this.#opts.pin)
		return a.length === b.length && timingSafeEqual(a, b)
	}

	#broadcast(event: string, data: unknown): void {
		const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
		for (const c of this.#clients) c.write(text)
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://x')
		const json = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
			res.end(JSON.stringify(body))
		}
		for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
		try {
			if (req.method === 'OPTIONS') {
				// preflight; Chrome's private network check asks for this one too
				if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true')
				res.writeHead(204)
				res.end()
				return
			}
			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
				res.end(this.#html)
				return
			}
			if (req.method === 'GET' && url.pathname === '/api/info') return json(200, this.info())
			if (!this.#pinOk(url, req)) {
				res.writeHead(401, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ error: 'pin' }))
				return
			}
			if (req.method === 'GET' && url.pathname === '/api/peers') return json(200, { self: this.info(), finder: !!this.#beacon, peers: this.peers() })
			if (url.pathname.startsWith('/rec/')) return await this.#rec(req, res, url, json)
			if (req.method === 'GET' && url.pathname === '/events') {
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-store',
					Connection: 'keep-alive',
					'X-Accel-Buffering': 'no',
				})
				res.write(`event: meta\ndata: ${JSON.stringify(this.#engine.meta())}\n\n`)
				res.write(`event: state\ndata: ${JSON.stringify(this.#engine.snapshot())}\n\n`)
				this.#clients.add(res)
				const ping = setInterval(() => res.write(': ping\n\n'), 15000)
				req.on('close', () => {
					clearInterval(ping)
					this.#clients.delete(res)
				})
				return
			}
			if (req.method === 'GET' && url.pathname === '/export') {
				res.writeHead(200, {
					'Content-Type': 'application/json',
					'Content-Disposition': `attachment; filename="${this.#engine.opts.appId}-settings-${new Date().toISOString().slice(0, 10)}.json"`,
				})
				res.end(this.#engine.exportJson())
				return
			}
			if (req.method === 'POST' && url.pathname === '/cmd') {
				const body = await readBody(req)
				const result = await this.#command(JSON.parse(body) as Record<string, unknown>)
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ ok: true, message: result ?? '' }))
				return
			}
			res.writeHead(404)
			res.end()
		} catch (e) {
			if (res.headersSent) return void res.end()
			res.writeHead(e instanceof FileError ? e.status : 400, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
		}
	}

	async #rec(req: IncomingMessage, res: ServerResponse, url: URL, json: (s: number, b: unknown) => void): Promise<void> {
		const r = this.#engine.recordings
		const p = url.pathname
		if (req.method === 'GET' && p === '/rec/state') return json(200, r.pageState())
		if (req.method === 'GET' && p === '/rec/files') {
			try {
				return json(200, { ok: true, folder: r.folder(), files: await r.rec.files.list(), busy: r.rec.namer.take?.startName ?? null })
			} catch (e) {
				return json(200, { ok: false, folder: r.folder(), files: [], error: (e as Error).message })
			}
		}
		if ((req.method === 'GET' || req.method === 'HEAD') && p === '/rec/file') {
			return r.rec.files.serve(req, res, url.searchParams.get('name') ?? '', { download: url.searchParams.get('download') === '1' })
		}
		if (req.method === 'POST' && p === '/rec/sheet') {
			const bytes = await readBytes(req, MAX_SHEET)
			r.loadSheetFile(bytes, url.searchParams.get('name') || 'uploaded file')
			return json(200, { ok: true, message: `Loaded ${r.rec.sheet.status.rowCount} rows from ${r.rec.sheet.status.label}` })
		}
		res.writeHead(404)
		res.end()
	}

	async #command(c: Record<string, unknown>): Promise<string | void> {
		const e = this.#engine
		const cmd = String(c.cmd ?? '')
		const input = () => {
			const inp = e.inputs.get(String(c.input ?? ''))
			if (!inp) throw new Error(`No input "${String(c.input)}"`)
			return inp
		}
		const block = (inp: ReturnType<typeof input>) => {
			const b = inp.blocks.find((x) => x.id === String(c.block))
			if (!b) throw new Error(`${inp.name} has no "${String(c.block)}"`)
			return b
		}
		switch (cmd) {
			case 'volume': {
				const db = c.db === null ? null : Number(c.db)
				if (db !== null && Number.isNaN(db)) throw new Error('Bad level')
				const inp = input()
				e.setVolume(inp, db)
				e.userChange({ kind: 'volume', input: inp.id, db })
				return
			}
			case 'pfl':
				return void (await e.monitoring.setPfl(input(), !!c.value))
			case 'solo':
				return void (await e.monitoring.setSolo(input(), !!c.value))
			case 'notice':
				return (await e.noticeAction(String(c.id), String(c.action))) ?? undefined
			case 'backupSwitch': {
				const inp = input()
				if (c.to === 'main') e.backups.switchToMain(inp)
				else e.backups.switchToBackup(inp, 'it was switched by hand')
				return
			}
			case 'recordStart':
				return void (await e.recorder.start())
			case 'recordStop':
				return void (await e.recorder.stop())
			case 'recordPause':
				return void (await e.recorder.pause(!!c.value))
			case 'recordPlan':
				e.recorder.setPlan(c.nextStart ? String(c.nextStart) : null, !!c.autoStart)
				return
			case 'recordFolder':
				return void (await e.recorder.setDirectory(String(c.value ?? '')))
			case 'recordName':
				return void (await e.recorder.setFileName(String(c.value ?? '')))
			case 'touch':
				e.touch(input(), !!c.value)
				return
			case 'mute': {
				const inp = input()
				e.userChange({ kind: 'mute', input: inp.id, muted: !!c.value })
				return void (await e.setMute(inp, !!c.value))
			}
			case 'balance': {
				const inp = input()
				e.userChange({ kind: 'balance', input: inp.id, balance: Number(c.value) })
				return void (await e.setBalance(inp, Number(c.value)))
			}
			case 'delay': {
				const inp = input()
				e.userChange({ kind: 'delay', input: inp.id, value: Number(c.value) })
				return void (await e.setDelay(inp, Number(c.value)))
			}
			case 'monitor':
				return void (await e.setMonitor(input(), String(c.value)))
			case 'mixOption': {
				const inp = input()
				e.userChange({ kind: 'mixOption', input: inp.id, value: String(c.value) })
				return void (await e.setMixOption(inp, String(c.value)))
			}
			case 'routing': {
				const inp = input()
				e.userChange({ kind: 'routing', input: inp.id, target: String(c.target), on: !!c.value })
				return void (await e.setRouting(inp, { [String(c.target)]: !!c.value }))
			}
			case 'trim': {
				const inp = input()
				e.setTrim(inp, Number(c.value))
				e.userChange({ kind: 'trim', input: inp.id, db: Number(c.value) })
				return
			}
			case 'blockAdd':
				return void (await e.addBlock(input(), String(c.kind), String(c.name ?? '')))
			case 'blockRemove':
				return void (await e.removeBlock(input(), String(c.block)))
			case 'blockEnable': {
				const inp = input()
				const b = block(inp)
				e.userChange({ kind: 'blockEnabled', input: inp.id, block: b, on: !!c.value })
				return void (await e.setBlockEnabled(inp, b.id, !!c.value))
			}
			case 'blockSet': {
				const inp = input()
				const b = block(inp)
				e.userChange({ kind: 'blockParam', input: inp.id, block: b, key: String(c.key), value: c.value })
				return void (await e.setBlockParam(inp, b.id, String(c.key), c.value))
			}
			case 'autoLevel':
				e.setInputSetting(input().id, 'autoLevelOn', !!c.value)
				return
			case 'capture':
				e.captureTarget(input())
				return
			case 'calibrate': {
				const w = c.level
				e.calibrate(input(), w === 'module' ? 'module' : w === 'input' || w === undefined ? 'input' : Number(w))
				return
			}
			case 'setTarget': {
				const db = parseDb(c.value)
				e.setTarget(input(), db === undefined ? null : db)
				return
			}
			case 'inputSetting':
				e.setInputSetting(input().id, String(c.key), c.value ?? undefined)
				return
			case 'defaultSetting':
				e.setDefaultSetting(String(c.key), c.value)
				return
			case 'page':
				e.setPage(String(c.key) as keyof PageSettings, c.value)
				if (c.key === 'meterRateHz') this.#restartMeters()
				return
			case 'gestures':
				e.setGestures(num(c.doubleTapMs), num(c.holdMs), num(c.moduleCalibrateDb))
				return
			case 'sections':
				e.setSections((c.sections as Section[]) ?? [])
				return
			case 'inputSection':
				e.setInputSection(String(c.input), String(c.section), (c.mode as SectionMode | null) ?? null)
				return
			case 'order':
				e.setOrder((c.order as string[]) ?? [], (c.hidden as string[]) ?? [])
				return
			case 'import':
				return e.importJson(String(c.data ?? ''), ((c.parts as ImportPart[]) ?? []).filter((p) => typeof p === 'string'))
			case 'restoreAutosave':
				return e.restoreAutosave()
			// ---- recordings ----
			case 'recEnable':
				return void e.recordings.setEnabled(!!c.value)
			case 'recFolderOverride':
				return void e.recordings.setFolderOverride(String(c.value ?? ''))
			case 'recRestoreName':
				return void e.recordings.setRestoreName(!!c.value)
			case 'recConfigure':
				return void e.recordings.configure((c.settings ?? {}) as Parameters<typeof e.recordings.configure>[0])
			case 'recPreview':
				return await e.recordings.previewWith((c.naming ?? {}) as Parameters<typeof e.recordings.previewWith>[0])
			case 'recRow': {
				const r = e.recordings
				const how = String(c.how ?? 'auto') as 'auto' | 'key' | 'number'
				const ok =
					c.op === 'next' ? r.rowNext() : c.op === 'previous' ? r.rowPrevious() : c.op === 'pick' ? r.rowPick(Number(c.index)) : c.op === 'release' ? (r.rowRelease(), true) : c.op === 'set' ? r.rowSet(String(c.value ?? ''), how) : false
				if (!ok) throw new Error(c.op === 'next' || c.op === 'previous' ? 'No row that way' : "Couldn't find that row")
				return
			}
			case 'recSheetRefresh':
				await e.recordings.refreshSheet()
				return e.recordings.rec.sheet.status.error ?? `Sheet read: ${e.recordings.rec.sheet.status.rowCount} rows`
			case 'recUploadNow':
				return `${e.recordings.uploadNow(!!c.includeFailed)} file(s) on their way`
			case 'recUploadFile':
				return `Queued ${(await e.recordings.uploadFile(String(c.name ?? ''))).length} upload(s)`
			case 'recRetry':
				if (c.id) return void e.recordings.retry(String(c.id))
				return `${e.recordings.retryFailed()} upload(s) trying again`
			case 'recRemove':
				return void e.recordings.removeUpload(String(c.id ?? ''))
			case 'recClear':
				return `Cleared ${e.recordings.clearFinished(!!c.includeFailed)}`
			case 'recRename': {
				const to = await e.recordings.rec.files.rename(String(c.name ?? ''), String(c.to ?? ''))
				return `Renamed to ${to}`
			}
			case 'recDeleteAsk': {
				const t = await e.recordings.rec.files.requestDelete(String(c.name ?? ''))
				return JSON.stringify({ token: t.token, expires: t.expires })
			}
			case 'recDelete':
				await e.recordings.rec.files.delete(String(c.name ?? ''), String(c.token ?? ''))
				return 'Deleted'
			default:
				throw new Error(`Unknown command "${cmd}"`)
		}
	}
}

function num(v: unknown): number | undefined {
	if (v === undefined || v === null || v === '') return undefined
	const n = Number(v)
	return Number.isNaN(n) ? undefined : n
}

function readBytes(req: IncomingMessage, max: number): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => {
			size += c.length
			if (size > max) {
				reject(new Error('That file is too big'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
		req.on('error', reject)
	})
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => {
			size += c.length
			if (size > MAX_BODY) {
				reject(new Error('Too big'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}
