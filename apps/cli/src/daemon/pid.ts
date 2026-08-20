import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { daemonPaths } from '@/daemon/config'

export interface DaemonPidPaths {
    pidPath: string
}

export class DaemonAlreadyRunningError extends Error {
    constructor(readonly pid: number) {
        super(`daemon already running pid=${pid}`)
        this.name = 'DaemonAlreadyRunningError'
    }
}

const parsePid = (raw: string): number | null => {
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
}

export const isProcessRunning = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return code === 'EPERM'
    }
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
    if (pid !== undefined) {
        const current = await readDaemonPid(paths)
        if (current !== pid) return
    }
    try {
        await unlink(paths.pidPath)
    } catch {}
}

export const runningDaemonPid = async (
    paths: DaemonPidPaths = daemonPaths
): Promise<number | null> => {
    let raw: string
    try {
        raw = await readFile(paths.pidPath, 'utf8')
    } catch {
        return null
    }
    const pid = parsePid(raw)
    if (!pid) {
        await clearDaemonPid(undefined, paths)
        return null
    }
    if (isProcessRunning(pid)) return pid
    await clearDaemonPid(pid, paths)
    return null
}

export const writeDaemonPid = async (
    pid: number,
    paths: DaemonPidPaths = daemonPaths
): Promise<void> => {
    await mkdir(dirname(paths.pidPath), { recursive: true })
    await writeFile(paths.pidPath, `${pid}\n`, 'utf8')
}

export const claimDaemonPid = async (
    pid: number,
    paths: DaemonPidPaths = daemonPaths
): Promise<void> => {
    const running = await runningDaemonPid(paths)
    if (running !== null && running !== pid)
        throw new DaemonAlreadyRunningError(running)
    await writeDaemonPid(pid, paths)
}
