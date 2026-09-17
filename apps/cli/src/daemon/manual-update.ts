import { execFile } from 'node:child_process'
import { link, rename, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { DaemonLocalHealth } from './control'
import { readJsonState, writeProtectedJson } from '@/json-state'

const execFileAsync = promisify(execFile)

// A daemon nobody supervises (startup method `manual`: the sprite runner,
// a foreground start) updates itself by driving the swap from the OLD
// process (ADR-0029 §5): prove the new binary runs, keep the old one
// reachable, swap, hand what it owns to a successor it starts detached, and
// watch that successor come up — or put the old binary back and try again
// later with a different target. No execve, no fd handover: exec IO is in
// files already, so the successor adopts through the same recovery a crash
// would use.

export const PREVIOUS_BINARY_SUFFIX = '.prev'
export const MANUAL_UPDATE_WATCHDOG_MS = 60_000
const WATCHDOG_POLL_MS = 500
const SUCCESSOR_TERM_GRACE_MS = 3_000

export const previousBinaryPath = (execPath: string): string =>
    `${execPath}${PREVIOUS_BINARY_SUFFIX}`

// Before anything moves: the candidate must run and say the version we
// are installing. A binary that cannot even do that never replaces the
// running one.
export const precheckBinary = async (
    binary: string,
    targetVersion: string,
    run: (file: string, args: string[]) => Promise<{ stdout: string }> = (
        file,
        args
    ) => execFileAsync(file, args, { timeout: 15_000, encoding: 'utf8' })
): Promise<void> => {
    let stdout: string
    try {
        stdout = (await run(binary, ['--version'])).stdout
    } catch (err) {
        throw new Error(
            `new binary failed its precheck: ${(err as Error).message}`
        )
    }
    if (!stdout.includes(targetVersion))
        throw new Error(
            `new binary reports "${stdout.trim().split('\n')[0]}", not ${targetVersion}`
        )
}

// Keep the old binary under a second name on the same inode: after the
// swap the running process still maps it, and a rollback renames it back.
export const keepPreviousBinary = async (
    execPath: string,
    fs: { link: typeof link; rm: typeof rm } = { link, rm }
): Promise<string> => {
    const prev = previousBinaryPath(execPath)
    await fs.rm(prev, { force: true })
    await fs.link(execPath, prev)
    return prev
}

export interface UpdateLatch {
    version: string
    reason: string
    at: string
}

// A target that failed to come up is not retried: the auto-updater would
// otherwise loop through the same swap and rollback every tick.
export const readUpdateLatch = async (
    path: string
): Promise<UpdateLatch | null> => {
    try {
        const raw = await readJsonState(path)
        if (!raw || typeof raw !== 'object') return null
        const latch = raw as Partial<UpdateLatch>
        return typeof latch.version === 'string' &&
            typeof latch.reason === 'string' &&
            typeof latch.at === 'string'
            ? { version: latch.version, reason: latch.reason, at: latch.at }
            : null
    } catch {
        return null
    }
}

export const writeUpdateLatch = (
    path: string,
    latch: UpdateLatch
): Promise<void> => writeProtectedJson(path, latch)

export interface UpdateRollback {
    fromVersion: string
    toVersion: string
    reason: string
    at: string
}

// Left for the daemon that runs after a rollback (the old binary again) to
// report once in its first hello, so the platform hears why the upgrade it
// asked for did not land.
export const takeUpdateRollback = async (
    path: string
): Promise<UpdateRollback | null> => {
    try {
        const raw = await readJsonState(path)
        await rm(path, { force: true })
        if (!raw || typeof raw !== 'object') return null
        const marker = raw as Partial<UpdateRollback>
        return typeof marker.fromVersion === 'string' &&
            typeof marker.toVersion === 'string' &&
            typeof marker.reason === 'string' &&
            typeof marker.at === 'string'
            ? {
                  fromVersion: marker.fromVersion,
                  toVersion: marker.toVersion,
                  reason: marker.reason,
                  at: marker.at
              }
            : null
    } catch {
        return null
    }
}

export interface HandoffDeps {
    execPath: string
    fromVersion: string
    toVersion: string
    // Everything this process owns, given up in order: tailers detached
    // (execs keep running), API socket closed, control socket and pid
    // released. After this the successor may claim them.
    stopServing: () => Promise<void>
    // Start `<binary> daemon start --foreground` detached; returns its pid.
    spawnDaemon: (binary: string) => number
    health: () => Promise<DaemonLocalHealth | null>
    kill: (pid: number, signal: NodeJS.Signals) => void
    latchPath: string
    rollbackPath: string
    watchdogMs?: number
    sleep?: (ms: number) => Promise<void>
    log: (message: string) => void
}

export type HandoffOutcome =
    | { kind: 'handed-off'; successorPid: number }
    | { kind: 'rolled-back'; reason: string }

// Success is the successor answering on the control socket with the target
// version and `running` — not a connection to the API, which a deploy on the
// platform side could be delaying for reasons of its own.
export const handOffToSuccessor = async (
    deps: HandoffDeps
): Promise<HandoffOutcome> => {
    const sleep =
        deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const watchdogMs = deps.watchdogMs ?? MANUAL_UPDATE_WATCHDOG_MS
    const prev = previousBinaryPath(deps.execPath)
    await deps.stopServing()
    let successorPid: number
    try {
        successorPid = deps.spawnDaemon(deps.execPath)
    } catch (err) {
        return rollBack(
            deps,
            prev,
            `successor failed to spawn: ${(err as Error).message}`
        )
    }
    deps.log(
        `manual update: successor pid=${successorPid} spawned, watching for ${deps.toVersion}`
    )
    const deadline = Date.now() + watchdogMs
    while (Date.now() < deadline) {
        const health = await deps.health()
        if (
            health &&
            health.pid === successorPid &&
            health.version === deps.toVersion &&
            health.status === 'running'
        ) {
            await rm(prev, { force: true }).catch(() => {})
            deps.log(
                `manual update: successor running ${health.version}; handing off`
            )
            return { kind: 'handed-off', successorPid }
        }
        await sleep(WATCHDOG_POLL_MS)
    }
    try {
        deps.kill(successorPid, 'SIGTERM')
        await sleep(SUCCESSOR_TERM_GRACE_MS)
        deps.kill(successorPid, 'SIGKILL')
    } catch {}
    return rollBack(
        deps,
        prev,
        `successor did not report ${deps.toVersion} running within ${Math.round(watchdogMs / 1000)}s`
    )
}

const rollBack = async (
    deps: HandoffDeps,
    prev: string,
    reason: string
): Promise<HandoffOutcome> => {
    deps.log(`manual update: rolling back — ${reason}`)
    const at = new Date().toISOString()
    try {
        await rename(prev, deps.execPath)
    } catch (err) {
        deps.log(
            `manual update: could not restore ${prev}: ${(err as Error).message}`
        )
    }
    await writeUpdateLatch(deps.latchPath, {
        version: deps.toVersion,
        reason,
        at
    }).catch((err: Error) =>
        deps.log(`manual update: latch write failed: ${err.message}`)
    )
    await writeProtectedJson(deps.rollbackPath, {
        fromVersion: deps.fromVersion,
        toVersion: deps.toVersion,
        reason,
        at
    } satisfies UpdateRollback).catch((err: Error) =>
        deps.log(`manual update: rollback marker write failed: ${err.message}`)
    )
    try {
        const pid = deps.spawnDaemon(deps.execPath)
        deps.log(`manual update: previous binary relaunched pid=${pid}`)
    } catch (err) {
        deps.log(
            `manual update: previous binary failed to relaunch: ${(err as Error).message}`
        )
    }
    return { kind: 'rolled-back', reason }
}
