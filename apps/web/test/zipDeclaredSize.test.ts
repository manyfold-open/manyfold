import assert from 'node:assert/strict'
import test from 'node:test'
import { zipDeclaredInflatedSize } from '../src/components/chat/preview/zipDeclaredSize'

const EOCD_SIGNATURE = 0x06054b50
const CD_SIGNATURE = 0x02014b50

const cdEntry = (uncompressedSize: number, name: string): Uint8Array => {
    const bytes = new Uint8Array(46 + name.length)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, CD_SIGNATURE, true)
    view.setUint32(24, uncompressedSize, true)
    view.setUint16(28, name.length, true)
    for (let index = 0; index < name.length; index++)
        bytes[46 + index] = name.charCodeAt(index)
    return bytes
}

const archive = (
    entries: Uint8Array[],
    { prefixBytes = 8, commentBytes = 0 } = {}
): ArrayBuffer => {
    const cdSize = entries.reduce((sum, entry) => sum + entry.length, 0)
    const bytes = new Uint8Array(prefixBytes + cdSize + 22 + commentBytes)
    let offset = prefixBytes
    for (const entry of entries) {
        bytes.set(entry, offset)
        offset += entry.length
    }
    const view = new DataView(bytes.buffer)
    view.setUint32(offset, EOCD_SIGNATURE, true)
    view.setUint16(offset + 8, entries.length, true)
    view.setUint16(offset + 10, entries.length, true)
    view.setUint32(offset + 12, cdSize, true)
    view.setUint32(offset + 16, prefixBytes, true)
    view.setUint16(offset + 20, commentBytes, true)
    return bytes.buffer
}

test('sums the declared uncompressed sizes of all entries', () => {
    const data = archive([cdEntry(100, 'a.xml'), cdEntry(200, 'word/b.xml')])
    assert.equal(zipDeclaredInflatedSize(data), 300)
})

test('finds the end-of-central-directory behind a trailing comment', () => {
    const data = archive([cdEntry(123, 'a.xml')], { commentBytes: 40 })
    assert.equal(zipDeclaredInflatedSize(data), 123)
})

test('declares a bomb-sized archive as huge, not as parse failure', () => {
    const data = archive([
        cdEntry(50_000_000, 'a.bin'),
        cdEntry(60_000_000, 'b.bin')
    ])
    assert.equal(zipDeclaredInflatedSize(data), 110_000_000)
})

test('treats a zip64 entry size marker as unbounded', () => {
    const data = archive([cdEntry(0xffffffff, 'a.bin')])
    assert.equal(zipDeclaredInflatedSize(data), Infinity)
})

test('treats a zip64 central-directory offset marker as unbounded', () => {
    const data = archive([cdEntry(10, 'a.xml')])
    const view = new DataView(data)
    view.setUint32(data.byteLength - 22 + 16, 0xffffffff, true)
    assert.equal(zipDeclaredInflatedSize(data), Infinity)
})

test('returns null for non-zip bytes', () => {
    assert.equal(
        zipDeclaredInflatedSize(new TextEncoder().encode('not a zip').buffer),
        null
    )
    assert.equal(zipDeclaredInflatedSize(new ArrayBuffer(0)), null)
    assert.equal(zipDeclaredInflatedSize(new ArrayBuffer(1024)), null)
})

test('returns null when the central directory is corrupt', () => {
    const data = archive([cdEntry(100, 'a.xml')])
    new DataView(data).setUint32(8, 0, true)
    assert.equal(zipDeclaredInflatedSize(data), null)
})

test('reads the central directory of a real xlsx archive', async () => {
    const mod = await import('exceljs')
    const ExcelJS = mod.default ?? mod
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    for (let row = 0; row < 50; row++) sheet.addRow(['hello', row, row * 2])
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array
    const data = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
    )
    const declared = zipDeclaredInflatedSize(data as ArrayBuffer)
    assert.notEqual(declared, null)
    assert.ok(Number.isFinite(declared))
    assert.ok((declared as number) > 0)
})