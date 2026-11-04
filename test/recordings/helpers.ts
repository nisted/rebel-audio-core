import { deflateRawSync, crc32 } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const tmp = (p = 'rec-') => mkdtempSync(join(tmpdir(), p))

/** Minimal zip writer (deflate) for building .xlsx fixtures */
export function zip(files: Record<string, string>, store = false): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let off = 0
	for (const [name, text] of Object.entries(files)) {
		const raw = Buffer.from(text, 'utf8')
		const data = store ? raw : deflateRawSync(raw)
		const nb = Buffer.from(name)
		const crc = crc32(raw)
		const lh = Buffer.alloc(30)
		lh.writeUInt32LE(0x04034b50, 0)
		lh.writeUInt16LE(20, 4)
		lh.writeUInt16LE(store ? 0 : 8, 8)
		lh.writeUInt32LE(crc, 14)
		lh.writeUInt32LE(data.length, 18)
		lh.writeUInt32LE(raw.length, 22)
		lh.writeUInt16LE(nb.length, 26)
		locals.push(lh, nb, data)
		const ch = Buffer.alloc(46)
		ch.writeUInt32LE(0x02014b50, 0)
		ch.writeUInt16LE(20, 4)
		ch.writeUInt16LE(20, 6)
		ch.writeUInt16LE(store ? 0 : 8, 10)
		ch.writeUInt32LE(crc, 16)
		ch.writeUInt32LE(data.length, 20)
		ch.writeUInt32LE(raw.length, 24)
		ch.writeUInt16LE(nb.length, 28)
		ch.writeUInt32LE(off, 42)
		centrals.push(ch, nb)
		off += 30 + nb.length + data.length
	}
	const cd = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(Object.keys(files).length, 8)
	end.writeUInt16LE(Object.keys(files).length, 10)
	end.writeUInt32LE(cd.length, 12)
	end.writeUInt32LE(off, 16)
	return Buffer.concat([...locals, cd, end])
}

/** An .xlsx like Excel writes: shared strings, a time-formatted cell, a date cell, a number, an inline string, two sheets */
export function sampleXlsx(): Buffer {
	return zip({
		'[Content_Types].xml': '<?xml version="1.0"?><Types/>',
		'xl/workbook.xml':
			'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Schedule" sheetId="1" r:id="rId1"/><sheet name="Other &amp; Stuff" sheetId="2" r:id="rId2"/></sheets></workbook>',
		'xl/_rels/workbook.xml.rels':
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
		'xl/sharedStrings.xml':
			'<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Session</t></si><si><t>Speaker</t></si><si><t>Start</t></si><si><t>Day</t></si><si><r><t>Keynote</t></r><r><t xml:space="preserve"> &amp; Q</t></r></si><si><t>Ana Smith</t></si><si><t>Tab two</t></si></sst>',
		'xl/styles.xml':
			'<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>',
		'xl/worksheets/sheet1.xml':
			'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="inlineStr"><is><t>Room</t></is></c></row>' +
			'<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" s="1"><v>0.395833333333333</v></c><c r="D2" s="2"><v>46330</v></c><c r="E2"><v>3</v></c></row>' +
			'<row r="4"><c r="A4" t="str"><v>Panel</v></c><c r="C4" s="1"><v>0.4375</v></c><c r="E4" t="b"><v>1</v></c></row>' +
			'</sheetData></worksheet>',
		'xl/worksheets/sheet2.xml': '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="B1" t="s"><v>6</v></c></row></sheetData></worksheet>',
	})
}
