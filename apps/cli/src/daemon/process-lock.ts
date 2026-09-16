import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, realpath, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { readJsonState, writeProtectedJson } from '@/json-state'
import { openFileLock } from './file-lock'

export const isProcessRunning = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ESRCH'
    }
    if (process.platform === 'linux') {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
            const state = stat.slice(stat.lastIndexOf(') ') + 2)[0]
            return state !== 'Z' && state !== 'X'
        } catch (err) {
            return (err as NodeJS.ErrnoException).code !== 'ENOENT'
        }
    }
    return true
}

export class ProcessLockBusyError extends Error {
    constructor(readonly pid: number | null) {
        super(
            pid === null
                ? 'another process owns this lock'
                : `process ${pid} owns this lock`
        )
        this.name = 'ProcessLockBusyError'
    }
}

export interface ProcessLock {
    instanceId: string
    release(): Promise<void>
}

const ownerPid = async (path: string): Promise<number | null> => {
    try {
        const value = (await readJsonState(path)) as
            { pid?: unknown } | undefined
        return typeof value?.pid === 'number' &&
            Number.isSafeInteger(value.pid) &&
            value.pid > 0 &&
            isProcessRunning(value.pid)
            ? value.pid
            : null
    } catch {
        return null
    }
}

const acquirePipe = async (
    path: string
): Promise<(() => Promise<void>) | null> => {
    const server = createServer((socket) => socket.destroy())
    const pipe = `\\\\.\\pipe\\mf-daemon-lock-${createHash('sha256').update(path).digest('hex')}`
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(pipe, () => {
                server.removeListener('error', reject)
                resolve()
            })
        })
    } catch (err) {
        server.close()
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return null
        throw err
    }
    server.unref()
    return () => new Promise<void>((resolve) => server.close(() => resolve()))
}

export const acquireProcessLock = async (dir: string): Promise<ProcessLock> => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const canonical = await realpath(dir)
    const metadata = join(canonical, 'owner.json')
    // Keep the lock inode: unlinking it would let another process lock a new
    // inode while this owner still holds the old one. Metadata is diagnostic.
    const file =
        process.platform === 'win32'
            ? null
            : await openFileLock(join(canonical, 'lock'))
    const releaseKernel =
        process.platform === 'win32'
            ? await acquirePipe(canonical)
            : file
              ? () => file.close()
              : null
    if (!releaseKernel) throw new ProcessLockBusyError(await ownerPid(metadata))
    const instanceId = randomUUID()
    try {
        await writeProtectedJson(metadata, { pid: process.pid, instanceId })
    } catch (err) {
        await releaseKernel()
        throw err
    }
    let releasing: Promise<void> | null = null
    return {
        instanceId,
        release: () =>
            (releasing ??= (async () => {
                try {
                    await unlink(metadata).catch(
                        (err: NodeJS.ErrnoException) => {
                            if (err.code !== 'ENOENT') throw err
                        }
                    )
                } finally {
                    await releaseKernel()
                }
            })())
    }
}
