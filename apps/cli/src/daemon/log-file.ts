import {
    appendFile,
    open,
    rename,
    stat,
    truncate,
    unlink,
    writeFile
} from 'node:fs/promises'

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_BACKUPS = 5
const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_CHUNK_SIZE = 64 * 1024

interface DaemonLogOptions {
    maxBytes?: number
    maxBackups?: number
    maxAgeDays?: number
    echo?: NodeJS.WritableStream
    onError?: (message: string) => void
}

export interface DaemonLog {
    log(message: string): Promise<void>
    close(): Promise<void>
}

const errorKey = (context: string, err: unknown): string => {
    const code = (err as NodeJS.ErrnoException).code
    return `${context}: ${code ?? (err as Error).message ?? 'unknown error'}`
}

export const createDaemonLog = async (
    path: string,
    options: DaemonLogOptions = {}
): Promise<DaemonLog> => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS
    const maxAgeMs =
        (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
    const reportedErrors = new Set<string>()
    const report = (context: string, err: unknown): void => {
        const detail = errorKey(context, err)
        if (reportedErrors.has(detail)) return
        reportedErrors.add(detail)
        try {
            options.onError?.(`daemon log ${detail}`)
        } catch {}
    }

    const purgeOldBackups = async (): Promise<void> => {
        const cutoff = Date.now() - maxAgeMs
        for (let index = 1; index <= maxBackups; index += 1) {
            const backup = `${path}.${index}`
            try {
                const info = await stat(backup)
                if (info.mtimeMs < cutoff) await unlink(backup)
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
                    report(`backup purge failed for ${backup}`, err)
            }
        }
    }

    let size = 0
    try {
        size = (await stat(path)).size
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
            report(`stat failed for ${path}`, err)
    }
    await purgeOldBackups()

    const rotate = async (): Promise<void> => {
        await purgeOldBackups()
        try {
            for (let index = maxBackups - 1; index >= 1; index -= 1) {
                try {
                    await rename(`${path}.${index}`, `${path}.${index + 1}`)
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw err
                }
            }
            try {
                await rename(path, `${path}.1`)
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            }
            size = 0
        } catch (err) {
            report(`rotation failed for ${path}`, err)
        }
    }

    let closed = false
    let queue = Promise.resolve()
    const log = (message: string): Promise<void> => {
        if (closed) return Promise.resolve()
        const line = `${new Date().toISOString()} ${message}\n`
        const bytes = Buffer.byteLength(line)
        queue = queue.then(async () => {
            try {
                options.echo?.write(line)
            } catch (err) {
                report('echo failed', err)
            }
            if (size > 0 && size + bytes > maxBytes) await rotate()
            try {
                await appendFile(path, line, 'utf8')
                size += bytes
            } catch (err) {
                report(`write failed for ${path}`, err)
            }
        })
        return queue
    }

    const close = async (): Promise<void> => {
        closed = true
        await queue
    }

    return { log, close }
}

interface ReadLastLinesOptions {
    chunkSize?: number
    onChunk?: (bytes: number) => void
}

export const readLastLines = async (
    path: string,
    count = 50,
    options: ReadLastLinesOptions = {}
): Promise<Buffer> => {
    if (count === 0) return Buffer.alloc(0)
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    const handle = await open(path, 'r')
    try {
        const size = (await handle.stat()).size
        if (size === 0) return Buffer.alloc(0)
        let position = size
        let newlineCount = 0
        let targetNewlines = count
        let firstChunk = true
        const laterChunks: Buffer[] = []

        while (position > 0) {
            const length = Math.min(chunkSize, position)
            position -= length
            const buffer = Buffer.allocUnsafe(length)
            const { bytesRead } = await handle.read(buffer, 0, length, position)
            const chunk = buffer.subarray(0, bytesRead)
            options.onChunk?.(bytesRead)
            if (firstChunk) {
                firstChunk = false
                if (chunk[chunk.length - 1] === 0x0a) targetNewlines += 1
            }
            for (let index = chunk.length - 1; index >= 0; index -= 1) {
                if (chunk[index] !== 0x0a) continue
                newlineCount += 1
                if (newlineCount === targetNewlines)
                    return Buffer.concat([
                        chunk.subarray(index + 1),
                        ...laterChunks
                    ])
            }
            laterChunks.unshift(chunk)
        }
        return Buffer.concat(laterChunks)
    } finally {
        await handle.close()
    }
}

interface FollowFileOptions {
    pollMs?: number
    signal?: AbortSignal
}

const waitForPoll = async (
    pollMs: number,
    signal?: AbortSignal
): Promise<void> => {
    if (signal?.aborted) return
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs)
        const onAbort = (): void => done()
        function done(): void {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export const followFile = async (
    path: string,
    fromPosition: number,
    onData: (data: Buffer) => void | Promise<void>,
    options: FollowFileOptions = {}
): Promise<void> => {
    const pollMs = options.pollMs ?? 300
    let position = fromPosition
    let inode: number | undefined

    while (!options.signal?.aborted) {
        let info
        try {
            info = await stat(path)
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            position = 0
            inode = undefined
            await waitForPoll(pollMs, options.signal)
            continue
        }

        if (
            inode !== undefined &&
            inode !== 0 &&
            info.ino !== 0 &&
            info.ino !== inode
        )
            position = 0
        inode = info.ino
        if (info.size < position) position = 0

        if (info.size > position) {
            let handle
            try {
                handle = await open(path, 'r')
                while (position < info.size) {
                    const length = Math.min(
                        DEFAULT_CHUNK_SIZE,
                        info.size - position
                    )
                    const buffer = Buffer.allocUnsafe(length)
                    const { bytesRead } = await handle.read(
                        buffer,
                        0,
                        length,
                        position
                    )
                    if (bytesRead === 0) break
                    position += bytesRead
                    await onData(buffer.subarray(0, bytesRead))
                }
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
                position = 0
                inode = undefined
            } finally {
                await handle?.close()
            }
        }
        await waitForPoll(pollMs, options.signal)
    }
}

interface BoundErrSinkOptions {
    maxBytes?: number
}

export const boundErrSink = async (
    path: string,
    options: BoundErrSinkOptions = {}
): Promise<void> => {
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    let size: number
    try {
        size = (await stat(path)).size
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
    }
    if (size <= maxBytes) return

    const handle = await open(path, 'r')
    let tail: Buffer
    try {
        tail = Buffer.allocUnsafe(maxBytes)
        let offset = 0
        while (offset < maxBytes) {
            const { bytesRead } = await handle.read(
                tail,
                offset,
                maxBytes - offset,
                size - maxBytes + offset
            )
            if (bytesRead === 0) break
            offset += bytesRead
        }
        tail = tail.subarray(0, offset)
    } finally {
        await handle.close()
    }
    await writeFile(`${path}.1`, tail)
    // launchd/systemd retain this descriptor. O_APPEND resumes at byte 0 after
    // an in-place truncate; without it, later writes are sparse but disk use
    // still stays bounded.
    await truncate(path, 0)
}
