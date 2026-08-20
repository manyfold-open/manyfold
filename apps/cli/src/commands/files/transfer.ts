import { createReadStream, createWriteStream } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { NcaClient } from '@manyfold/sdk'

export interface TransferTarget {
    client: NcaClient
    agentId: string
    remotePath: string
    rootId?: string
}

export interface TransferResult {
    bytes: number
}

// stderr keeps progress out of stdout and out of --json output; a pipe or CI log
// gets nothing rather than a smear of carriage returns
const progressWriter = (
    label: string
): ((loaded: number, total?: number) => void) => {
    if (!process.stderr.isTTY) return () => {}
    let last = 0
    return (loaded, total) => {
        const now = Date.now()
        if (now - last < 100 && loaded !== total) return
        last = now
        const suffix =
            total && total > 0
                ? `${Math.floor((loaded / total) * 100)}% (${loaded}/${total})`
                : `${loaded} bytes`
        process.stderr.write(`\r${label} ${suffix}`)
    }
}

const endProgress = (): void => {
    if (process.stderr.isTTY) process.stderr.write('\n')
}

const withCancellation = async <T>(
    run: (signal: AbortSignal) => Promise<T>,
    cleanup: () => Promise<void>
): Promise<T> => {
    const controller = new AbortController()
    let cancelled = false
    const onSignal = (): void => {
        cancelled = true
        controller.abort()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
        return await run(controller.signal)
    } catch (err) {
        await cleanup()
        if (cancelled) throw new Error('transfer cancelled')
        throw err
    } finally {
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
    }
}

export const uploadFile = async (
    target: TransferTarget,
    localPath: string
): Promise<TransferResult> => {
    const info = await stat(localPath).catch(() => null)
    if (!info) throw new Error(`no such local file: ${localPath}`)
    if (info.isDirectory())
        throw new Error(`${localPath} is a directory; upload a single file`)
    const report = progressWriter(`uploading ${localPath}`)
    let sent = 0
    return withCancellation(
        async (signal) => {
            // streamed off disk so peak memory stays flat regardless of size
            const source = Readable.toWeb(
                createReadStream(localPath)
            ) as ReadableStream<Uint8Array>
            const counted = source.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                        sent += chunk.byteLength
                        report(sent, info.size)
                        controller.enqueue(chunk)
                    }
                })
            )
            await target.client.files.write(
                target.agentId,
                target.remotePath,
                counted,
                {
                    rootId: target.rootId,
                    contentLength: info.size,
                    signal
                }
            )
            endProgress()
            return { bytes: info.size }
        },
        async () => {
            endProgress()
        }
    )
}

const openRemote = async (target: TransferTarget, signal: AbortSignal) => {
    const res = await target.client.files.read(
        target.agentId,
        target.remotePath,
        { rootId: target.rootId, signal }
    )
    if (!res.ok)
        throw new Error(
            `${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`
        )
    if (!res.body) throw new Error(`empty response for ${target.remotePath}`)
    return res
}

export const downloadToFile = async (
    target: TransferTarget,
    localPath: string
): Promise<TransferResult> => {
    const partPath = `${localPath}.mf-part`
    const report = progressWriter(`downloading ${target.remotePath}`)
    let received = 0
    return withCancellation(
        async (signal) => {
            const res = await openRemote(target, signal)
            const declared = Number(res.headers.get('content-length') ?? 0)
            const total =
                Number.isFinite(declared) && declared > 0 ? declared : undefined
            const source = Readable.fromWeb(
                res.body as Parameters<typeof Readable.fromWeb>[0]
            )
            source.on('data', (chunk: Buffer) => {
                received += chunk.byteLength
                report(received, total)
            })
            // land in a sibling temp file and rename, so an interrupted download
            // never leaves a half-written file at the destination
            await pipeline(source, createWriteStream(partPath))
            if (total !== undefined && received !== total)
                throw new Error(
                    `truncated download: got ${received} of ${total} bytes`
                )
            await rename(partPath, localPath)
            endProgress()
            return { bytes: received }
        },
        async () => {
            endProgress()
            await unlink(partPath).catch(() => {})
        }
    )
}

export const downloadToStdout = async (
    target: TransferTarget
): Promise<TransferResult> => {
    let received = 0
    return withCancellation(
        async (signal) => {
            const res = await openRemote(target, signal)
            const source = Readable.fromWeb(
                res.body as Parameters<typeof Readable.fromWeb>[0]
            )
            source.on('data', (chunk: Buffer) => {
                received += chunk.byteLength
            })
            await pipeline(source, process.stdout, { end: false })
            return { bytes: received }
        },
        async () => {}
    )
}
