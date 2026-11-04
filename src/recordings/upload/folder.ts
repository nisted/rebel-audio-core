/** Where on the destination a recording goes: pattern from sheet columns/date, one fixed folder, or fixed + dated subfolder. */
import { cleanFileName, formatDate, tokenValue, type NameContext } from '../naming.js'
import type { NamingSettings, UploadSettings } from '../settings.js'

/** Clean each folder level; drop empty and "."/".." levels. Returns "a/b/c" ("" = top level) */
export function cleanFolderPath(p: string, naming: Pick<NamingSettings, 'replaceWith'>): string {
	return p
		.split(/[\\/]+/)
		.map((seg) => cleanFileName(seg, { replaceWith: naming.replaceWith, maxLength: 120 }))
		.filter((seg) => seg && seg !== '.' && seg !== '..')
		.join('/')
}

export function remoteFolder(s: Pick<UploadSettings, 'layout' | 'folder' | 'folderPattern' | 'datedFormat'>, ctx: NameContext, naming: NamingSettings): string {
	const now = ctx.now ?? new Date()
	switch (s.layout) {
		case 'fixed':
			return cleanFolderPath(s.folder, naming)
		case 'dated':
			return cleanFolderPath(`${s.folder}/${formatDate(now, s.datedFormat)}`, naming)
		case 'pattern': {
			const raw = s.folderPattern.replace(/\{([^{}]+)\}/g, (_, tok: string) => tokenValue(tok, { ...ctx, now }, naming).replace(/[\\/]/g, naming.replaceWith || '_'))
			return cleanFolderPath(raw, naming)
		}
	}
}
