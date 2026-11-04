/**
 * One connection's recordings feature, wired together: sheet → row → name → rename after stop → upload queue,
 * plus the file manager. The device/module supplies the recording folder and calls `beforeStart()` / `afterStop()`.
 * Nothing here knows about OBS or ATEM.
 */
import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import { SheetSource, type FetchLike, type SheetStatus } from './sheet.js'
import { RowSelector, type RowState } from './rows.js'
import { RecordingNamer, type StopResult } from './rename.js'
import { FileManager } from './files.js'
import { UploadQueue, type UploadItem, type UploadQueueState } from './upload/queue.js'
import { remoteFolder } from './upload/folder.js'
import type { TransportSet } from './upload/transports.js'
import { recordingSettings, type PartialSettings, type RecordingSettings } from './settings.js'
import type { NameContext } from './naming.js'
import type { Table } from './table.js'

export interface RecordingsEvents {
	row: [RowState]
	sheet: [SheetStatus]
	upload: [UploadItem]
	/** Save `saved()` now if you persist things */
	persist: []
	log: [string]
}

export interface RecordingsOptions {
	settings?: PartialSettings
	/** The device's recording folder (null while unknown) */
	folder: () => string | null
	/** Source/device name for {source}, Companion variable values for {var:…} */
	context?: () => Omit<NameContext, 'row' | 'rowNumber' | 'take'>
	/** Names being recorded right now (the file manager won't rename/delete them) */
	busy?: () => Iterable<string>
	fetch?: FetchLike
	transports?: TransportSet
	now?: () => number
}

/** What a module should save (in its settings store) and hand back on start */
export interface RecordingsSaved {
	upload: UploadQueueState
	/** Last good sheet copy, so names still work if the sheet can't be reached after a restart */
	table: Table | null
	tableLabel: string
	rowIndex: number | null
}

export class Recordings extends EventEmitter<RecordingsEvents> {
	settings: RecordingSettings
	readonly sheet: SheetSource
	readonly rows: RowSelector
	readonly namer: RecordingNamer
	readonly files: FileManager
	readonly uploads: UploadQueue
	private readonly o: RecordingsOptions

	constructor(o: RecordingsOptions) {
		super()
		this.o = o
		this.settings = recordingSettings(o.settings)
		const now = o.now ?? Date.now
		this.sheet = new SheetSource(this.settings.sheet, { fetch: o.fetch, now })
		this.rows = new RowSelector(this.settings.rows, { now })
		this.namer = new RecordingNamer({
			rows: this.rows,
			naming: () => this.settings.naming,
			rename: () => this.settings.rename,
			folder: o.folder,
			context: o.context,
			now,
			log: (m) => this.emit('log', m),
		})
		this.files = new FileManager({ folder: o.folder, settings: this.settings.files, naming: this.settings.naming, now, busy: o.busy })
		this.uploads = new UploadQueue({ settings: () => this.settings.upload, transports: o.transports, now, log: (m) => this.emit('log', m) })
		this.sheet.on('table', (t) => this.rows.setTable(t))
		this.sheet.on('status', (s) => {
			this.emit('sheet', s)
			if (s.ok) this.emit('persist')
		})
		this.rows.on('change', (s) => {
			this.emit('row', s)
			this.emit('persist')
		})
		this.uploads.on('item', (i) => this.emit('upload', i))
		this.uploads.on('change', () => this.emit('persist'))
	}

	/** Apply new settings (partial is fine: missing values get defaults) */
	configure(over: PartialSettings): void {
		this.settings = recordingSettings(over)
		this.sheet.configure(this.settings.sheet)
		this.rows.configure(this.settings.rows)
		this.files.configure(this.settings.files)
	}

	start(saved?: Partial<RecordingsSaved> | null): void {
		if (saved?.table) {
			this.sheet.restore(saved.table, saved.tableLabel || 'saved copy')
			if (saved.rowIndex != null && this.settings.rows.mode === 'manual') this.rows.pick(saved.rowIndex)
		}
		if (saved?.upload) this.uploads.restore(saved.upload)
		this.sheet.start()
		this.rows.start()
		this.uploads.start()
	}

	stop(): void {
		this.sheet.stop()
		this.rows.stop()
		this.uploads.stop()
	}

	saved(): RecordingsSaved {
		return { upload: this.uploads.state, table: this.sheet.table, tableLabel: this.sheet.status.label, rowIndex: this.rows.state.index }
	}

	/** Call before the device starts recording. Returns the file name (no extension) to set, or null if naming at start is off. */
	async beforeStart(): Promise<string | null> {
		const name = await this.namer.nameForStart()
		return this.settings.rename.nameAtStart ? name : null
	}

	/**
	 * Call after the device stops, with the finished file's full path (if the device knows it).
	 * Renames if needed, auto-advances the row if set, and queues the upload.
	 */
	async afterStop(path: string | null): Promise<{ stop: StopResult | null; uploads: UploadItem[] }> {
		let stop: StopResult | null = null
		const rowForUpload = this.rows.state
		if (path) stop = await this.namer.stopped(path)
		this.rows.recordingStopped()
		let uploads: UploadItem[] = []
		const finalPath = stop?.path ?? path
		if (finalPath && this.settings.upload.enabled) uploads = this.queueUpload(finalPath, rowForUpload)
		return { stop, uploads }
	}

	/** Queue one file for upload (an "upload this" button, or after stop). `force` ignores the when setting. */
	queueUpload(path: string, row: RowState = this.rows.state, force = false): UploadItem[] {
		const extra = this.o.context?.() ?? {}
		const folder = remoteFolder(this.settings.upload, { ...extra, row: row.row, rowNumber: row.number, now: extra.now ?? new Date((this.o.now ?? Date.now)()) }, this.settings.naming)
		return this.uploads.add(path, { remoteFolder: folder, remoteName: basename(path), force })
	}
}
