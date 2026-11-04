/**
 * Every value the recordings library uses, with defaults. Callers keep a (partial) settings object
 * per connection and pass it through `recordingSettings()` to fill in anything missing.
 */

export type SheetKind = 'none' | 'google' | 'file'

export interface SheetSettings {
	/** Where the rows come from: a Google Sheet link, an uploaded CSV/Excel file, or nothing */
	kind: SheetKind
	/** The Google Sheet link as copied from the browser (edit, share or published link) */
	googleUrl: string
	/** Which tab: blank = the tab in the link (or the first), a number = gid, anything else = tab name */
	tab: string
	/** How often to re-read a Google Sheet, in seconds (0 = only when asked) */
	pollSeconds: number
	/** Give up on one fetch after this long (ms) */
	fetchTimeoutMs: number
	/** Which row holds the column names (1 = the first row) */
	headerRow: number
	/** Drop rows where every cell is blank */
	skipBlankRows: boolean
	/** Excel files: which sheet (blank = first; a number = position from 1; otherwise its name) */
	excelSheet: string
}

export type CollisionMode = 'suffix' | 'take'

export interface NamingSettings {
	/**
	 * Free-form pattern, e.g. "{Session} - {Speaker} {date}". When blank, `parts` are joined with `separator`.
	 * Tokens: {Column name} or {col:Column name}, {date}, {time}, {source}, {take}, {row}, {var:name}.
	 */
	template: string
	/** Name built from these parts, in order (used when `template` is blank). Same tokens without braces. */
	parts: string[]
	/** Put between parts (empty parts are skipped) */
	separator: string
	/** Date format for {date}: YYYY, YY, MM, DD tokens */
	dateFormat: string
	/** Time format for {time}: HH, mm, ss tokens */
	timeFormat: string
	/** Take numbers padded to this many digits (0 or 1 = no padding) */
	takePad: number
	/** First take number */
	takeStart: number
	/** When a name is already used: add " (2)" or add a take number */
	collision: CollisionMode
	/** Label put before the take number when `collision` is 'take' and the pattern has no {take} */
	takeLabel: string
	/** Characters that can't go in a file name are replaced with this */
	replaceWith: string
	/** Longest name allowed, not counting the extension */
	maxLength: number
	/** Used when everything else came out blank */
	fallbackName: string
}

export type RowMode = 'manual' | 'time'
export type OverrideHold = 'untilReleased' | 'untilNextSlot'

export interface RowSettings {
	/** 'manual': rows are picked / stepped; 'time': the row whose start/end times cover now is live */
	mode: RowMode
	/** Column used to find a row by value (e.g. a session code) */
	keyColumn: string
	/** Step to the next row after each recording stops */
	autoAdvance: boolean
	/** Wrap from the last row back to the first when stepping */
	wrap: boolean
	/** Time matching: column holding the start time */
	startColumn: string
	/** Time matching: column holding the end time (blank = each row runs until the next row's start) */
	endColumn: string
	/** Time matching: optional column holding the date (blank = times without a date mean today) */
	dateColumn: string
	/** How dates are written in the sheet when ambiguous (04/11/2026): day first (UK) or month first (US) */
	dateOrder: 'dmy' | 'mdy'
	/** Time matching: a manual pick holds until released, or until the next time slot starts */
	overrideHold: OverrideHold
	/** Time matching: when no slot covers now, keep the last matched row (true) or show no row (false) */
	keepLastWhenNoSlot: boolean
	/** Time matching: start a slot this many seconds early */
	leadSeconds: number
}

export interface RenameSettings {
	/** Set the file name on the device before recording starts */
	nameAtStart: boolean
	/** After stop, rename the file if the row changed during the take */
	renameAfterStop: boolean
	/** After stop, how often to check the file has finished being written (ms) */
	stablePollMs: number
	/** The file size must stay the same for this many checks in a row */
	stableChecks: number
	/** Give up waiting for the file to settle after this long (ms) */
	stableTimeoutMs: number
	/** Rename attempts if the file is still locked */
	renameRetries: number
	/** Wait between rename attempts (ms) */
	renameRetryMs: number
}

export interface FileSettings {
	/** File types listed in the file manager (lower case, no dot). Empty = everything */
	extensions: string[]
	/** Include files whose names start with a dot */
	showHidden: boolean
	/** Look into sub-folders of the recording folder (this many levels; 0 = just the folder) */
	depth: number
	/** Read the length of mp4/mov/mkv/wav files (cheap header read) */
	readDurations: boolean
	/** A delete confirm token stays valid this long (ms) */
	deleteTokenMs: number
}

export type UploadWhen = 'afterStop' | 'manual' | 'scheduled'
export type FolderLayout = 'pattern' | 'fixed' | 'dated'

export interface RcloneDestination {
	kind: 'rclone'
	/** An rclone remote name you've already set up (e.g. "gdrive" or "gdrive:Shows"), or an on-the-fly string like ":webdav,url='https://…':" */
	remote: string
}
export interface FtpDestination {
	kind: 'ftp' | 'sftp'
	host: string
	/** Blank = 21 for FTP, 22 for SFTP */
	port: number
	user: string
	password: string
	/** FTP only: use explicit TLS (FTPS) */
	tls: boolean
	/** Folder on the server everything goes under */
	basePath: string
}
export interface ShareDestination {
	kind: 'share'
	/** Mounted network share / NAS path, e.g. /Volumes/Media or \\\\nas\\media (must already be reachable) */
	path: string
}
export interface HttpDestination {
	kind: 'http'
	/** Address to send to. May hold {path} (folder/name) and {name}. For PUT without tokens, /folder/name is added */
	url: string
	method: 'POST' | 'PUT'
	/** POST: multipart form (like a browser upload) or the raw file as the body */
	postFormat: 'multipart' | 'raw'
	/** Multipart form field name for the file */
	fieldName: string
	user: string
	password: string
	/** Extra headers, e.g. { Authorization: 'Bearer …' } */
	headers: Record<string, string>
}
export interface WebdavDestination {
	kind: 'webdav'
	/** Base address of the WebDAV folder */
	url: string
	user: string
	password: string
	/** Make missing folders (MKCOL) before uploading */
	createFolders: boolean
	headers: Record<string, string>
}

export type DestinationKind = Destination['kind']
export type Destination = { id: string; name: string; enabled: boolean } & (
	| RcloneDestination
	| FtpDestination
	| ShareDestination
	| HttpDestination
	| WebdavDestination
)

export interface UploadSettings {
	/** Master switch */
	enabled: boolean
	/** Where uploads go (several allowed; each file goes to each enabled one) */
	destinations: Destination[]
	/** After each stop (queued), only when asked, or at a set time of day */
	when: UploadWhen
	/** 'scheduled': time of day, 24h "HH:MM" local time */
	at: string
	/** Remote folder: pattern from sheet columns/date, one fixed folder, or fixed folder + a folder per day */
	layout: FolderLayout
	/** 'fixed' and 'dated': the folder (blank = top level) */
	folder: string
	/** 'pattern': folder pattern with naming tokens; "/" makes sub-folders, e.g. "{Event}/{date}" */
	folderPattern: string
	/** 'dated': date format for the day folder */
	datedFormat: string
	/** Uploads at once */
	concurrency: number
	/** Tries before giving up on a file (0 = keep trying) */
	maxAttempts: number
	/** First retry wait (ms); doubles each time */
	retryBaseMs: number
	/** Longest retry wait (ms) */
	retryMaxMs: number
	/** rclone program (name on PATH or full path) */
	rclonePath: string
	/** Extra rclone arguments, e.g. ["--drive-chunk-size", "64M"] */
	rcloneArgs: string[]
	/** Give up on an HTTP/WebDAV upload that has sent nothing for this long (ms) */
	stallTimeoutMs: number
}

export interface RecordingSettings {
	sheet: SheetSettings
	naming: NamingSettings
	rows: RowSettings
	rename: RenameSettings
	files: FileSettings
	upload: UploadSettings
}

export const DEFAULTS: RecordingSettings = {
	sheet: {
		kind: 'none',
		googleUrl: '',
		tab: '',
		pollSeconds: 30,
		fetchTimeoutMs: 15000,
		headerRow: 1,
		skipBlankRows: true,
		excelSheet: '',
	},
	naming: {
		template: '',
		parts: ['date', 'time'],
		separator: ' - ',
		dateFormat: 'YYYY-MM-DD',
		timeFormat: 'HH-mm-ss',
		takePad: 2,
		takeStart: 1,
		collision: 'suffix',
		takeLabel: 'Take ',
		replaceWith: '_',
		maxLength: 120,
		fallbackName: 'Recording',
	},
	rows: {
		mode: 'manual',
		keyColumn: '',
		autoAdvance: false,
		wrap: false,
		startColumn: 'Start',
		endColumn: 'End',
		dateColumn: '',
		dateOrder: 'dmy',
		overrideHold: 'untilNextSlot',
		keepLastWhenNoSlot: false,
		leadSeconds: 0,
	},
	rename: {
		nameAtStart: true,
		renameAfterStop: true,
		stablePollMs: 500,
		stableChecks: 3,
		stableTimeoutMs: 120000,
		renameRetries: 10,
		renameRetryMs: 1000,
	},
	files: {
		extensions: ['mp4', 'mov', 'mkv', 'flv', 'ts', 'm3u8', 'm4a', 'mp3', 'wav', 'aac', 'webm', 'fragmented.mp4'],
		showHidden: false,
		depth: 0,
		readDurations: true,
		deleteTokenMs: 60000,
	},
	upload: {
		enabled: false,
		destinations: [],
		when: 'afterStop',
		at: '23:00',
		layout: 'dated',
		folder: 'Recordings',
		folderPattern: '{date}',
		datedFormat: 'YYYY-MM-DD',
		concurrency: 1,
		maxAttempts: 0,
		retryBaseMs: 5000,
		retryMaxMs: 300000,
		rclonePath: 'rclone',
		rcloneArgs: [],
		stallTimeoutMs: 60000,
	},
}

export type PartialSettings = { [K in keyof RecordingSettings]?: Partial<RecordingSettings[K]> }

/** Fill in defaults for anything missing (one level deep per section; arrays replace). */
export function recordingSettings(over: PartialSettings = {}): RecordingSettings {
	const out = {} as RecordingSettings
	for (const k of Object.keys(DEFAULTS) as (keyof RecordingSettings)[]) {
		;(out as any)[k] = { ...structuredClone(DEFAULTS[k]), ...(over[k] ?? {}) }
	}
	return out
}
