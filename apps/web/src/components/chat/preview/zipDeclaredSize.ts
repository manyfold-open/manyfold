// Decompression-bomb gate for zip-based office formats (docx/xlsx): sums the
// uncompressed sizes DECLARED in the zip central directory without inflating
// anything. Known bombs (overlapping-entry style) declare their true inflated
// size here; lying headers are caught by the parse-worker timeout instead.
// Returns null when no valid central directory is found (the real parser will
// then fail with its own error), and Infinity for zip64 markers — a sub-10 MB
// agent artifact has no business being zip64.

const EOCD_SIGNATURE = 0x06054b50
const CD_SIGNATURE = 0x02014b50
const EOCD_BYTES = 22
const MAX_COMMENT_BYTES = 65_535
const ZIP64_U32 = 0xffffffff
const ZIP64_U16 = 0xffff

export const zipDeclaredInflatedSize = (data: ArrayBuffer): number | null => {
    const view = new DataView(data)
    const length = view.byteLength
    if (length < EOCD_BYTES) return null
    const floor = Math.max(0, length - EOCD_BYTES - MAX_COMMENT_BYTES)
    let eocd = -1
    for (let offset = length - EOCD_BYTES; offset >= floor; offset--) {
        if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
            eocd = offset
            break
        }
    }
    if (eocd === -1) return null
    const entryCount = view.getUint16(eocd + 10, true)
    const cdOffset = view.getUint32(eocd + 16, true)
    if (entryCount === ZIP64_U16 || cdOffset === ZIP64_U32) return Infinity
    let offset = cdOffset
    let total = 0
    for (let index = 0; index < entryCount; index++) {
        if (offset + 46 > length) return null
        if (view.getUint32(offset, true) !== CD_SIGNATURE) return null
        const uncompressed = view.getUint32(offset + 24, true)
        if (uncompressed === ZIP64_U32) return Infinity
        total += uncompressed
        const nameLength = view.getUint16(offset + 28, true)
        const extraLength = view.getUint16(offset + 30, true)
        const commentLength = view.getUint16(offset + 32, true)
        offset += 46 + nameLength + extraLength + commentLength
    }
    return total
}