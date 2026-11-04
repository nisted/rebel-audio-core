/**
 * Finding other Rebel audio pages on the network (page joining).
 *
 * Each connection's web server says hello every few seconds with a small UDP
 * datagram, sent to a multicast group and to the local broadcast address
 * (some switches drop multicast, some routers drop broadcast; between them
 * one usually gets through). Every connection listens on the same port
 * (shared, so several connections on one computer all hear), and keeps a
 * list of who it's heard lately. The page asks its own server for that list
 * (`/api/peers`) and then talks to each one directly.
 *
 * No dependencies: node:dgram only. Nothing secret goes in a beacon: just the
 * module, the connection's name, the page's port and whether it has a PIN.
 */

import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

export const BEACON_GROUP = '239.255.42.99'
export const BEACON_PORT = 48999
/** How often a beacon goes out */
export const BEACON_EVERY_MS = 5000
/** A peer not heard for this long drops off the list */
export const PEER_TIMEOUT_MS = 17000

/** What goes in a beacon */
export interface BeaconMessage {
	rebel: 1
	/** Random per running page server, so a page can spot itself and duplicates */
	id: string
	/** Module id, e.g. 'obs-audio' */
	app: string
	appName: string
	/** The connection's name in Companion */
	name: string
	/** The page's port */
	port: number
	/** The address the page answers on, when it isn't all of them */
	bind?: string
	pin: boolean
	/** Module version */
	version: string
	/** Device label, e.g. 'OBS', 'the ATEM' */
	device: string
}

/** A page heard on the network */
export interface Peer {
	id: string
	app: string
	appName: string
	name: string
	/** Where its page is, e.g. http://192.168.1.20:8890 */
	url: string
	pin: boolean
	version: string
	device: string
	/** ms epoch */
	lastSeen: number
}

export interface BeaconOptions {
	port: number
	/** What to say. Called each time, so a renamed connection says its new name. */
	message: () => BeaconMessage
	log?: (level: 'debug' | 'info' | 'warn', msg: string) => void
	everyMs?: number
	timeoutMs?: number
	group?: string
	/** Also send to 255.255.255.255 (default on) */
	broadcast?: boolean
	now?: () => number
}

/** This computer's IPv4 addresses, loopback included */
export function ownAddresses(): Set<string> {
	const out = new Set<string>(['127.0.0.1'])
	for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4') out.add(a.address)
	return out
}

/** Parse a datagram; null if it isn't a Rebel beacon */
export function parseBeacon(buf: Buffer): BeaconMessage | null {
	if (buf.length > 2048) return null
	try {
		const m = JSON.parse(buf.toString('utf8')) as Partial<BeaconMessage>
		if (m.rebel !== 1 || typeof m.id !== 'string' || typeof m.port !== 'number' || !(m.port > 0 && m.port < 65536)) return null
		return {
			rebel: 1,
			id: m.id.slice(0, 64),
			app: String(m.app ?? '').slice(0, 64),
			appName: String(m.appName ?? '').slice(0, 64),
			name: String(m.name ?? '').slice(0, 120),
			port: Math.round(m.port),
			bind: typeof m.bind === 'string' ? m.bind : undefined,
			pin: m.pin === true,
			version: String(m.version ?? '').slice(0, 32),
			device: String(m.device ?? '').slice(0, 64),
		}
	} catch {
		return null
	}
}

/** Where a beacon's page is, as seen from here; null if it can't be reached from here */
export function peerUrl(m: BeaconMessage, from: string, own: Set<string> = ownAddresses()): string | null {
	const bind = m.bind && m.bind !== '0.0.0.0' ? m.bind : ''
	if (bind === '127.0.0.1') return own.has(from) ? `http://127.0.0.1:${m.port}` : null
	return `http://${bind || from}:${m.port}`
}

export class Beacon {
	readonly #o: BeaconOptions
	#sock: Socket | null = null
	#timer: NodeJS.Timeout | null = null
	#peers = new Map<string, Peer>()
	#own = ownAddresses()
	#ready = false

	constructor(o: BeaconOptions) {
		this.#o = o
	}

	get port(): number {
		return this.#o.port
	}

	start(): void {
		if (this.#sock || !(this.#o.port > 0)) return
		const sock = createSocket({ type: 'udp4', reuseAddr: true })
		this.#sock = sock
		sock.on('error', (e) => {
			this.#o.log?.('warn', `Page finder (UDP ${this.#o.port}): ${e.message}. Other pages can still be added by address.`)
		})
		sock.on('message', (buf, r) => this.#heard(buf, r.address))
		sock.bind(this.#o.port, () => {
			try {
				sock.setBroadcast(true)
			} catch {
				/* fine */
			}
			try {
				sock.setMulticastTTL(1)
				sock.setMulticastLoopback(true)
			} catch {
				/* fine */
			}
			try {
				sock.addMembership(this.#o.group ?? BEACON_GROUP)
			} catch (e) {
				this.#o.log?.('debug', `Page finder: couldn't join the multicast group (${(e as Error).message}); broadcast only`)
			}
			this.#ready = true
			this.announce()
		})
		this.#timer = setInterval(() => {
			this.#own = ownAddresses()
			this.announce()
			this.#expire()
		}, this.#o.everyMs ?? BEACON_EVERY_MS)
		this.#timer.unref?.()
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer)
		this.#timer = null
		this.#ready = false
		try {
			this.#sock?.close()
		} catch {
			/* already closed */
		}
		this.#sock = null
		this.#peers.clear()
	}

	/** Send a beacon now */
	announce(): void {
		const sock = this.#sock
		if (!sock || !this.#ready) return
		const buf = Buffer.from(JSON.stringify(this.#o.message()))
		const quiet = () => {}
		sock.send(buf, this.#o.port, this.#o.group ?? BEACON_GROUP, quiet)
		if (this.#o.broadcast !== false) sock.send(buf, this.#o.port, '255.255.255.255', quiet)
	}

	#heard(buf: Buffer, from: string): void {
		const m = parseBeacon(buf)
		if (!m) return
		if (m.id === this.#o.message().id) return
		const url = peerUrl(m, from, this.#own)
		if (!url) return
		const now = (this.#o.now ?? Date.now)()
		const was = this.#peers.get(m.id)
		// heard on two addresses (multicast and broadcast, two networks): keep the first one that worked
		this.#peers.set(m.id, { id: m.id, app: m.app, appName: m.appName, name: m.name, url: was?.url ?? url, pin: m.pin, version: m.version, device: m.device, lastSeen: now })
	}

	#expire(): void {
		const now = (this.#o.now ?? Date.now)()
		const limit = this.#o.timeoutMs ?? PEER_TIMEOUT_MS
		for (const [id, p] of this.#peers) if (now - p.lastSeen > limit) this.#peers.delete(id)
	}

	/** Pages heard lately, by name */
	peers(): Peer[] {
		this.#expire()
		return [...this.#peers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url))
	}
}
