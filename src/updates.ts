/**
 * Checks GitHub for the latest release of the module and of the device's own
 * software (OBS Studio, ATEM firmware...), so the page and Companion can say
 * when an update is out. Repo names are passed in by the module.
 */

export interface UpdateSources {
	/** The module's GitHub 'owner/repo' (pre-releases count) */
	moduleRepo: string
	/** The device software's 'owner/repo' (full releases only), or '' for no check */
	deviceRepo: string
	moduleDownload: string
	deviceDownload: string
	/** Sent as the User-Agent */
	userAgent: string
}

export interface VersionInfo {
	moduleVersion: string
	moduleLatest: string | null
	moduleUpdate: boolean
	/** The device software's version (e.g. OBS Studio's) */
	deviceVersion: string | null
	deviceLatest: string | null
	deviceUpdate: boolean
	/** e.g. 'OBS Studio' */
	deviceLabel: string
	checkedAt: string | null
	error: string | null
	moduleDownload: string
	deviceDownload: string
}

/** Compare '1.2.3' style versions (a leading 'v' and anything after '-' or '+' ignored). -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) =>
		v
			.trim()
			.replace(/^v/i, '')
			.split(/[-+]/)[0]
			.split('.')
			.map((n) => parseInt(n, 10) || 0)
	const x = parts(a)
	const y = parts(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d) return d > 0 ? 1 : -1
	}
	return 0
}

async function github<T>(path: string, userAgent: string, timeoutMs: number): Promise<T | null> {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), timeoutMs)
	try {
		const r = await fetch(`https://api.github.com/repos/${path}`, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
			signal: ac.signal,
		})
		if (r.status === 404) return null
		if (!r.ok) throw new Error(`GitHub said ${r.status}`)
		return (await r.json()) as T
	} finally {
		clearTimeout(timer)
	}
}

/** The latest full release's tag on a GitHub repo, or null if it has none */
export async function latestRelease(repo: string, userAgent = 'rebel-audio-core', timeoutMs = 10000): Promise<string | null> {
	const j = await github<{ tag_name?: string }>(`${repo}/releases/latest`, userAgent, timeoutMs)
	return j?.tag_name ? j.tag_name.replace(/^v/i, '') : null
}

/** The highest version among a repo's published releases, pre-releases included (drafts skipped) */
export async function newestRelease(repo: string, userAgent = 'rebel-audio-core', timeoutMs = 10000): Promise<string | null> {
	const j = await github<{ tag_name?: string; draft?: boolean }[]>(`${repo}/releases?per_page=30`, userAgent, timeoutMs)
	return j ? pickNewest(j) : null
}

export function pickNewest(releases: { tag_name?: string; draft?: boolean }[]): string | null {
	let best: string | null = null
	for (const rel of releases) {
		if (rel.draft || !rel.tag_name) continue
		const v = rel.tag_name.replace(/^v/i, '')
		if (best === null || compareVersions(v, best) > 0) best = v
	}
	return best
}

export function newVersionInfo(moduleVersion: string, src: Pick<UpdateSources, 'moduleDownload' | 'deviceDownload'>, deviceLabel: string): VersionInfo {
	return {
		moduleVersion,
		moduleLatest: null,
		moduleUpdate: false,
		deviceVersion: null,
		deviceLatest: null,
		deviceUpdate: false,
		deviceLabel,
		checkedAt: null,
		error: null,
		moduleDownload: src.moduleDownload,
		deviceDownload: src.deviceDownload,
	}
}

export function recompute(v: VersionInfo): void {
	v.moduleUpdate = !!v.moduleLatest && compareVersions(v.moduleLatest, v.moduleVersion) > 0
	v.deviceUpdate = !!v.deviceLatest && !!v.deviceVersion && compareVersions(v.deviceLatest, v.deviceVersion) > 0
}
