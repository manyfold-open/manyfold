import { createHash } from 'node:crypto'
import { DAEMON_FS_WRITE_CHUNK_MAX_BYTES } from '@manyfold/shared'
import type { HostSession } from './host-daemon-access'

const CALL_TIMEOUT_MS = 30_000
// One chunk is up to 4 MiB on its way into the machine.
const CHUNK_TIMEOUT_MS = 2 * 60_000
const READ_TIMEOUT_MS = 10 * 60_000

const withRoots = (
    payload: Record<string, unknown>,
    roots: readonly string[] | undefined
): Record<string, unknown> =>
    roots?.length ? { ...payload, roots: [...roots] } : payload

// A file written into a machine in chunks through its daemon
// (DAEMON_FEATURE_FS_WRITE_STREAM): an owner-only part beside the target
// takes the chunks in order and becomes the target at commit, once its size
// and sha256 match, so a failed or cut upload leaves the target as it was.
// `roots` vouch for a path outside the daemon's own (DAEMON_FEATURE_FS_ROOTS).
export const writeFileStream = async (
    session: HostSession,
    args: {
        path: string
        body: AsyncIterable<Uint8Array>
        roots?: readonly string[]
        mode?: string
    }
): Promise<{ size: number }> => {
    const begin = await session.rpc({
        method: 'fs.write.begin',
        payload: withRoots(
            { path: args.path, ...(args.mode ? { mode: args.mode } : {}) },
            args.roots
        ),
        timeoutMs: CALL_TIMEOUT_MS
    })
    const uploadId = typeof begin?.uploadId === 'string' ? begin.uploadId : ''
    if (!uploadId) throw new Error(`the daemon opened no upload for ${args.path}`)
    const limit = Math.min(
        Number(begin?.chunkMaxBytes) || DAEMON_FS_WRITE_CHUNK_MAX_BYTES,
        DAEMON_FS_WRITE_CHUNK_MAX_BYTES
    )
    const hash = createHash('sha256')
    let size = 0
    let seq = 0
    let pending: Buffer[] = []
    let pendingBytes = 0
    const flush = async (): Promise<void> => {
        const data = Buffer.concat(pending).toString('base64')
        pending = []
        pendingBytes = 0
        await session.rpc({
            method: 'fs.write.chunk',
            payload: { uploadId, seq, data },
            timeoutMs: CHUNK_TIMEOUT_MS
        })
        seq += 1
    }
    try {
        for await (const raw of args.body) {
            const piece = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
            hash.update(piece)
            size += piece.byteLength
            let rest = piece
            while (rest.byteLength > 0) {
                const head = rest.subarray(0, limit - pendingBytes)
                pending.push(head)
                pendingBytes += head.byteLength
                rest = rest.subarray(head.byteLength)
                if (pendingBytes === limit) await flush()
            }
        }
        if (pendingBytes > 0) await flush()
        await session.rpc({
            method: 'fs.write.commit',
            payload: { uploadId, size, sha256: hash.digest('hex') },
            timeoutMs: CALL_TIMEOUT_MS
        })
        return { size }
    } catch (err) {
        await session
            .rpc({
                method: 'fs.write.abort',
                payload: { uploadId },
                timeoutMs: CALL_TIMEOUT_MS
            })
            .catch(() => undefined)
        throw err
    }
}

// A file read out of a machine as its chunks arrive (fs.read, chunked). The
// stream outlives the session call that opens it, so the caller hands it the
// release of a hold it took for the read; that runs once the stream ends.
export const readFileStream = (
    session: HostSession,
    args: {
        path: string
        roots?: readonly string[]
        release: () => void
    }
): { stream: AsyncIterable<Buffer>; done: Promise<void> } => {
    const queue: Array<Buffer | null> = []
    const waiters: Array<(next: IteratorResult<Buffer>) => void> = []
    let failed: Error | null = null
    const push = (chunk: Buffer | null): void => {
        const waiter = waiters.shift()
        if (!waiter) {
            queue.push(chunk)
            return
        }
        waiter(chunk ? { value: chunk, done: false } : { value: undefined, done: true })
    }
    const stream = session.stream({
        method: 'fs.read',
        payload: withRoots({ path: args.path, chunked: true }, args.roots),
        timeoutMs: READ_TIMEOUT_MS,
        onEvent: (kind, data) => {
            if (kind === 'fs.chunk') push(Buffer.from(data, 'base64'))
        }
    })
    const done = stream.result
        .then(() => undefined)
        .catch((err: Error) => {
            failed = err
            throw err
        })
        .finally(() => {
            push(null)
            args.release()
        })
    // A consumer that stops reading must not leave the read, and the hold
    // with it, running to its deadline.
    done.catch(() => undefined)
    const iterator: AsyncIterator<Buffer> = {
        next: () =>
            new Promise<IteratorResult<Buffer>>((resolve, reject) => {
                if (queue.length > 0) {
                    const chunk = queue.shift()!
                    if (chunk) resolve({ value: chunk, done: false })
                    else if (failed) reject(failed)
                    else resolve({ value: undefined, done: true })
                    return
                }
                waiters.push((next) =>
                    next.done && failed ? reject(failed) : resolve(next)
                )
            }),
        return: async () => {
            stream.cancel()
            return { value: undefined, done: true }
        }
    }
    return { stream: { [Symbol.asyncIterator]: () => iterator }, done }
}
