import { createHash, randomUUID, type Hash } from 'node:crypto'
import {
    closeSync,
    fchmodSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    writeSync
} from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DAEMON_FS_WRITE_CHUNK_MAX_BYTES } from '@manyfold/shared'
import { daemonPaths } from './config'

// A file too large for one RPC frame, written in chunks
// (DAEMON_FEATURE_FS_WRITE_STREAM). begin opens an owner-only part file
// beside the target, chunks append in order, and commit checks size and
// sha256, applies the mode and renames the part over the target, so nothing
// ever reads a half-written file. The target is checked again at commit: a
// directory swapped for a link between begin and commit must not steer the
// rename. A part outlives its daemon only as an entry in the uploads index,
// which the next one clears.

export const UPLOAD_IDLE_MS = 60 * 60 * 1000
const UPLOADS_MAX = 32
const PART_PREFIX = '.mf-part-'

interface UploadResult {
    ok: boolean
    payload?: Record<string, unknown>
    error?: string
}

interface Upload {
    id: string
    part: string
    fd: number
    hash: Hash
    size: number
    nextSeq: number
    mode: number | null
    // What the umask leaves of 0666: the mode a plain fs.write would give.
    defaultMode: number
    // The target, contained again right before the rename.
    target: () => string
    touchedAt: number
}

interface IndexEntry {
    id: string
    part: string
}

const uploads = new Map<string, Upload>()

const readIndex = (): IndexEntry[] => {
    try {
        const parsed = JSON.parse(
            readFileSync(daemonPaths.uploadsIndexPath, 'utf8')
        ) as unknown
        return Array.isArray(parsed)
            ? parsed.filter(
                  (e): e is IndexEntry =>
                      typeof e?.id === 'string' && typeof e?.part === 'string'
              )
            : []
    } catch {
        return []
    }
}

const saveIndex = (): void => {
    mkdirSync(daemonPaths.baseDir, { recursive: true, mode: 0o700 })
    const entries: IndexEntry[] = [...uploads.values()].map((u) => ({
        id: u.id,
        part: u.part
    }))
    const tmp = `${daemonPaths.uploadsIndexPath}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
    renameSync(tmp, daemonPaths.uploadsIndexPath)
}

// Parts in the index that no upload of this daemon owns: their writer is
// gone, and nothing else can finish them.
const clearOrphans = (): number => {
    let removed = 0
    for (const entry of readIndex()) {
        if (uploads.has(entry.id)) continue
        rmSync(entry.part, { force: true })
        removed += 1
    }
    return removed
}

const discard = (upload: Upload): void => {
    uploads.delete(upload.id)
    try {
        closeSync(upload.fd)
    } catch {}
    rmSync(upload.part, { force: true })
    saveIndex()
}

const octalMode = (raw: unknown): number | null =>
    typeof raw === 'string' && /^0?[0-7]{3}$/.test(raw)
        ? parseInt(raw, 8)
        : null

export const beginUpload = async (args: {
    target: string
    mode: unknown
    revalidate: () => string
}): Promise<UploadResult> => {
    await mkdir(dirname(args.target), { recursive: true })
    clearOrphans()
    if (uploads.size >= UPLOADS_MAX) return { ok: false, error: 'upload_limit' }
    const id = randomUUID()
    const part = join(dirname(args.target), `${PART_PREFIX}${id}`)
    // wx: a planted file or link at the part's name is never written through.
    // The part is owner-only before its first byte; the mode the umask gave
    // it is kept for a target that asks for none.
    const fd = openSync(part, 'wx', 0o666)
    const defaultMode = fstatSync(fd).mode & 0o777
    fchmodSync(fd, 0o600)
    uploads.set(id, {
        id,
        part,
        fd,
        hash: createHash('sha256'),
        size: 0,
        nextSeq: 0,
        mode: octalMode(args.mode),
        defaultMode,
        target: args.revalidate,
        touchedAt: Date.now()
    })
    saveIndex()
    return {
        ok: true,
        payload: {
            uploadId: id,
            chunkMaxBytes: DAEMON_FS_WRITE_CHUNK_MAX_BYTES
        }
    }
}

export const writeUploadChunk = (
    payload: Record<string, unknown>
): UploadResult => {
    const upload = uploads.get(String(payload.uploadId ?? ''))
    if (!upload) return { ok: false, error: 'upload_unknown' }
    if (payload.seq !== upload.nextSeq)
        return {
            ok: false,
            payload: { nextSeq: upload.nextSeq },
            error: 'upload_seq_mismatch'
        }
    const data = String(payload.data ?? '')
    if (data.length > Math.ceil(DAEMON_FS_WRITE_CHUNK_MAX_BYTES / 3) * 4) {
        discard(upload)
        return { ok: false, error: 'upload_chunk_too_large' }
    }
    const buf = Buffer.from(data, 'base64')
    try {
        for (let off = 0; off < buf.length; )
            off += writeSync(upload.fd, buf, off, buf.length - off)
    } catch (err) {
        discard(upload)
        return {
            ok: false,
            error: `upload_write_failed: ${(err as Error).message}`
        }
    }
    upload.hash.update(buf)
    upload.size += buf.length
    upload.nextSeq += 1
    upload.touchedAt = Date.now()
    return { ok: true, payload: { size: upload.size } }
}

export const commitUpload = async (
    payload: Record<string, unknown>
): Promise<UploadResult> => {
    const upload = uploads.get(String(payload.uploadId ?? ''))
    if (!upload) return { ok: false, error: 'upload_unknown' }
    try {
        fsyncSync(upload.fd)
    } catch (err) {
        discard(upload)
        return {
            ok: false,
            error: `upload_write_failed: ${(err as Error).message}`
        }
    }
    const sha256 = upload.hash.digest('hex')
    if (
        (payload.size !== undefined && payload.size !== upload.size) ||
        (payload.sha256 !== undefined && payload.sha256 !== sha256)
    ) {
        discard(upload)
        return { ok: false, error: 'upload_integrity_mismatch' }
    }
    let target: string
    try {
        target = upload.target()
    } catch (err) {
        discard(upload)
        return { ok: false, error: (err as Error).message }
    }
    uploads.delete(upload.id)
    try {
        closeSync(upload.fd)
        await chmod(upload.part, upload.mode ?? upload.defaultMode)
        await rename(upload.part, target)
    } catch (err) {
        await rm(upload.part, { force: true })
        saveIndex()
        return { ok: false, error: (err as Error).message }
    }
    saveIndex()
    syncDir(dirname(target))
    return { ok: true, payload: { size: upload.size, sha256 } }
}

export const abortUpload = (payload: Record<string, unknown>): UploadResult => {
    const upload = uploads.get(String(payload.uploadId ?? ''))
    if (upload) discard(upload)
    return { ok: true }
}

// The rename is durable only once its directory is: POSIX only, a no-op
// where a directory cannot be opened for it.
const syncDir = (dir: string): void => {
    if (process.platform === 'win32') return
    let fd: number | null = null
    try {
        fd = openSync(dir, 'r')
        fsyncSync(fd)
    } catch {
    } finally {
        if (fd !== null) closeSync(fd)
    }
}

// Uploads nobody has written to within the hour, and parts a previous daemon
// left: the platform restarts an upload rather than resuming a stale one.
export const sweepUploads = (now = Date.now()): number => {
    let removed = 0
    for (const upload of [...uploads.values()])
        if (now - upload.touchedAt > UPLOAD_IDLE_MS) {
            discard(upload)
            removed += 1
        }
    removed += clearOrphans()
    saveIndex()
    return removed
}
