import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameWithWindowsRetry } from '@/atomic-rename'
import { daemonPaths } from '@/daemon/config'
import {
    acquireProcessLock,
    isProcessRunning,
    processStartedAtMs,
    ProcessLockBusyError
} from './process-lock'

export { isProcessRunning } from './process-lock'

export interface DaemonPidPaths {
    pidPath: string
}

export class DaemonAlreadyRunningError extends Error {
    constructor(readonly pid: number | null) {
        super(
            pid === null
                ? 'daemon already running (owner is starting)'
                : `daemon already running pid=${pid}`
        )
        this.name = 'DaemonAlreadyRunningError'
    }
}

const parsePid = (raw: string): number | null => {
    if (!/^[1-9][0-9]*$/.test(raw.trim())) return null
    const pid = Number(raw.trim())
    return Number.isSafeInteger(pid) ? pid : null
}

export const readDaemonPid = async (
    paths: DaemonPidPaths = daemonPaths
): Promise<number | null> => {
    try {
        return parsePid(await readFile(paths.pidPath, 'utf8'))
    } catch {
        return null
    }
}

export const clearDaemonPid = async (
    pid?: number,
    paths: DaemonPidPaths = daemonPaths
): Promise<void> => {
    const target = { pidPath: paths.pidPath }
    let lock
    try {
        lock = await acquireProcessLock(`${target.pidPath}.locks`)
    } catch (err) {
        if (err instanceof ProcessLockBusyError) return
        throw err
    }
    try {
        if (pid !== undefined && (await readDaemonPid(target)) !== pid) return
        await unlink(target.pidPath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err
        })
    } finally {
        await lock.release()
    }
}

// A pid file outlives a daemon that was killed, and after a restart its number
// can belong to another process: one that started after the file was written
// is not the daemon that wrote it. A second of slack covers ps reporting start
// times to the second.
// Seen on prod [2026-10-03]: a sandbox daemon killed with SIGKILL left pid 8,
// the container restarted and pid 8 became the supervisor's own shell. Every
// `mf daemon start` then exited "daemon already running pid=8", and `mf daemon
// stop` signalled the shell.
export const runningDaemonPid = async (
    paths: DaemonPidPaths = daemonPaths
): Promise<number | null> => {
    let raw: string
    let writtenAt: number
    try {
        raw = await readFile(paths.pidPath, 'utf8')
        writtenAt = (await stat(paths.pidPath)).mtimeMs
    } catch {
        return null
    }
    const pid = parsePid(raw)
    if (!pid || !isProcessRunning(pid)) return null
    const startedAt = processStartedAtMs(pid)
    if (startedAt !== null && startedAt > writtenAt + 1_000) return null
    return pid
}

const writeDaemonPid = async (
    pid: number,
    paths: DaemonPidPaths,
    instanceId: string
): Promise<void> => {
    await mkdir(dirname(paths.pidPath), { recursive: true })
    const temporary = `${paths.pidPath}.${instanceId}.tmp`
    try {
        await writeFile(temporary, `${pid}\n`, { flag: 'wx', mode: 0o600 })
        await renameWithWindowsRetry(temporary, paths.pidPath)
    } finally {
        await unlink(temporary).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err
        })
    }
}

export interface DaemonPidOwnership {
    instanceId: string
    release(): Promise<void>
}

export const claimDaemonPid = async (
    pid: number,
    paths: DaemonPidPaths = daemonPaths
): Promise<DaemonPidOwnership> => {
    const target = { pidPath: paths.pidPath }
    let lock
    try {
        lock = await acquireProcessLock(`${target.pidPath}.locks`)
    } catch (err) {
        if (err instanceof ProcessLockBusyError)
            throw new DaemonAlreadyRunningError(err.pid)
        throw err
    }
    try {
        const running = await runningDaemonPid(target)
        if (running !== null && running !== pid)
            throw new DaemonAlreadyRunningError(running)
        await writeDaemonPid(pid, target, lock.instanceId)
    } catch (err) {
        await lock.release()
        throw err
    }
    let releasing: Promise<void> | null = null
    return {
        instanceId: lock.instanceId,
        release: () =>
            (releasing ??= (async () => {
                try {
                    if ((await readDaemonPid(target)) === pid)
                        await unlink(target.pidPath).catch(
                            (err: NodeJS.ErrnoException) => {
                                if (err.code !== 'ENOENT') throw err
                            }
                        )
                } finally {
                    await lock.release()
                }
            })())
    }
}
