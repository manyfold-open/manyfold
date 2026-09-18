import { isObjectId } from '@manyfold/shared'
import type { PtyProcess } from './pty-backend'
import {
    SerializeAddon,
    Terminal,
    type HeadlessSerializeAddon,
    type HeadlessTerminal
} from './xterm-headless'

// Terminals the daemon owns (ADR-0029 §6). A pty opened with a terminal id
// is not bound to the API stream that opened it: the stream is one
// attachment, the pty and a headless screen behind it live on when the
// attachment goes (an API deploy, a tab that dropped), and the next
// `pty.open` with the same id attaches — the screen's current contents
// first, then live output — so a reconnect gets its picture back instead of
// a new shell. One attachment at a time; a newer one preempts. What is left
// unattached is reclaimed after a TTL, shorter for a pty that holds a
// profile lock, since that lock keeps every turn on the profile waiting.
//
// The emulation feeds and fans out OUTSIDE the pty's data callback: Bun's
// native callback cannot have an exception caught upstream, so it only
// enqueues, and everything else runs on a pump with its own try/catch.

export const OWNED_TERMINAL_LIMIT = 8
export const OWNED_TERMINAL_SCROLLBACK = 2_000
export const UNATTACHED_TTL_MS = 30 * 60_000
export const UNATTACHED_PROFILE_TTL_MS = 5 * 60_000
// Chunks queued while no attachment drains them; beyond this the oldest
// are dropped from the queue (the screen keeps its own bounded state).
const QUEUE_LIMIT = 4_096
// Closing an owned terminal hangs up on it, as a closing terminal window
// does: an interactive shell ignores SIGTERM but leaves on SIGHUP and takes
// its jobs with it. What is still there after the grace is killed outright.
const CLOSE_KILL_GRACE_MS = 5_000

export interface OwnedTerminalAttachment {
    refId: string
    // Base64 of raw pty bytes, as `pty.out` events carry. Throws once the
    // connection behind it is gone, which is how a dead attachment is found.
    send: (base64: string) => void
    // Resolves the attachment's push: the pty exited, or a newer attachment
    // took over (`detached`).
    settle: (result: { exitCode?: number; detached?: boolean }) => void
}

export interface OwnedTerminalSummary {
    terminalId: string
    attached: boolean
    startedAt: string
    profileBound: boolean
}

interface OwnedTerminal {
    terminalId: string
    term: PtyProcess
    screen: HeadlessTerminal
    serializer: HeadlessSerializeAddon
    queue: Uint8Array[]
    pumping: boolean
    snapshotting: boolean
    attachment: OwnedTerminalAttachment | null
    profileBound: boolean
    startedAt: number
    cols: number
    rows: number
    ttlTimer: NodeJS.Timeout | null
    exited: boolean
    onExit: (exitCode: number) => void
    log: (message: string) => void
}

const owned = new Map<string, OwnedTerminal>()

// Format only: the id is a key here and a value on the wire, never a path.
export const isOwnedTerminalId = (value: unknown): value is string =>
    typeof value === 'string' && isObjectId(value, 'terminalSession')

export const assertOwnedTerminalCapacity = (): void => {
    if (owned.size >= OWNED_TERMINAL_LIMIT)
        throw new Error(
            `too many terminals on this daemon (${OWNED_TERMINAL_LIMIT}); close one first`
        )
}

const encode = (chunk: Uint8Array | string): string =>
    Buffer.from(chunk).toString('base64')

const stopTtl = (t: OwnedTerminal): void => {
    if (t.ttlTimer) clearTimeout(t.ttlTimer)
    t.ttlTimer = null
}

const armTtl = (t: OwnedTerminal, ttlMs: number): void => {
    stopTtl(t)
    t.ttlTimer = setTimeout(() => {
        t.ttlTimer = null
        if (t.exited || t.attachment) return
        t.log(
            `owned terminal ${t.terminalId}: unattached for ${Math.round(ttlMs / 1000)}s; closing`
        )
        hangUp(t)
    }, ttlMs)
    t.ttlTimer.unref?.()
}

const hangUp = (t: OwnedTerminal): void => {
    if (t.exited) return
    try {
        t.term.kill('SIGHUP')
    } catch {}
    const escalate = setTimeout(() => {
        if (t.exited) return
        try {
            t.term.kill('SIGKILL')
        } catch {}
    }, CLOSE_KILL_GRACE_MS)
    escalate.unref?.()
}

const dropAttachment = (
    t: OwnedTerminal,
    result: { exitCode?: number; detached?: boolean }
): void => {
    const attachment = t.attachment
    t.attachment = null
    if (!attachment) return
    try {
        attachment.settle(result)
    } catch {}
}

// Drain the queue into the screen and the attachment. A send that throws
// means the attachment's connection is gone: it is dropped, the terminal
// stays, its TTL starts.
const pump = (t: OwnedTerminal): void => {
    if (t.pumping || t.snapshotting) return
    t.pumping = true
    try {
        while (t.queue.length > 0 && !t.snapshotting) {
            const chunk = t.queue.shift()!
            try {
                t.screen.write(chunk)
            } catch (err) {
                t.log(
                    `owned terminal ${t.terminalId}: screen write failed: ${(err as Error).message}`
                )
            }
            const attachment = t.attachment
            if (!attachment) continue
            try {
                attachment.send(encode(chunk))
            } catch {
                t.log(
                    `owned terminal ${t.terminalId}: attachment ${attachment.refId} gone; detached`
                )
                dropAttachment(t, { detached: true })
                armTtl(
                    t,
                    t.profileBound
                        ? UNATTACHED_PROFILE_TTL_MS
                        : UNATTACHED_TTL_MS
                )
            }
        }
    } finally {
        t.pumping = false
    }
}

export const ownedTerminalCount = (): number => owned.size

export const attachedTerminalCount = (): number =>
    [...owned.values()].filter((t) => t.attachment !== null).length

export const listOwnedTerminals = (): OwnedTerminalSummary[] =>
    [...owned.values()].map((t) => ({
        terminalId: t.terminalId,
        attached: t.attachment !== null,
        startedAt: new Date(t.startedAt).toISOString(),
        profileBound: t.profileBound
    }))

export const ownedTerminal = (terminalId: string) => {
    const t = owned.get(terminalId)
    return t ? { term: t.term, attached: t.attachment !== null } : null
}

// Register a freshly spawned pty under its id. The spawn is the caller's
// (backend, cwd, env, argv are theirs); `feed` is what its data callback
// must call, and nothing else.
export const registerOwnedTerminal = (args: {
    terminalId: string
    term: PtyProcess
    cols: number
    rows: number
    profileBound: boolean
    onExit: (exitCode: number) => void
    log: (message: string) => void
}): { feed: (chunk: Uint8Array | string) => void } => {
    assertOwnedTerminalCapacity()
    const screen = new Terminal({
        cols: args.cols,
        rows: args.rows,
        allowProposedApi: true,
        scrollback: OWNED_TERMINAL_SCROLLBACK
    })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const t: OwnedTerminal = {
        terminalId: args.terminalId,
        term: args.term,
        screen,
        serializer,
        queue: [],
        pumping: false,
        snapshotting: false,
        attachment: null,
        profileBound: args.profileBound,
        startedAt: Date.now(),
        cols: args.cols,
        rows: args.rows,
        ttlTimer: null,
        exited: false,
        onExit: args.onExit,
        log: args.log
    }
    owned.set(args.terminalId, t)
    void args.term.exited.then((exitCode) => {
        t.exited = true
        stopTtl(t)
        pump(t)
        dropAttachment(t, { exitCode })
        owned.delete(t.terminalId)
        try {
            screen.dispose()
        } catch {}
        t.onExit(exitCode)
    })
    return {
        feed: (chunk) => {
            const bytes =
                typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
            t.queue.push(bytes)
            if (t.queue.length > QUEUE_LIMIT) t.queue.shift()
            // Never feed from inside the data callback itself.
            setImmediate(() => pump(t))
        }
    }
}

// Attach a stream to an owned terminal: the previous attachment (if any) is
// settled as detached, the screen is snapshotted with output held back so
// nothing lands between the snapshot and the live tail, the snapshot goes
// first, then the queue drains. A resize jiggle follows so a full-screen
// TUI repaints for the new viewer.
export const attachOwnedTerminal = (
    terminalId: string,
    attachment: OwnedTerminalAttachment,
    size: { cols: number; rows: number }
): boolean => {
    const t = owned.get(terminalId)
    if (!t || t.exited) return false
    stopTtl(t)
    if (t.attachment) {
        t.log(
            `owned terminal ${terminalId}: attachment ${t.attachment.refId} preempted by ${attachment.refId}`
        )
        dropAttachment(t, { detached: true })
    }
    t.attachment = attachment
    t.snapshotting = true
    const finishSnapshot = (): void => {
        t.snapshotting = false
        let snapshot = ''
        try {
            snapshot = t.serializer.serialize()
        } catch (err) {
            t.log(
                `owned terminal ${terminalId}: snapshot failed: ${(err as Error).message}`
            )
        }
        if (t.attachment === attachment && snapshot) {
            try {
                attachment.send(encode(snapshot))
            } catch {
                dropAttachment(t, { detached: true })
                armTtl(
                    t,
                    t.profileBound
                        ? UNATTACHED_PROFILE_TTL_MS
                        : UNATTACHED_TTL_MS
                )
            }
        }
        pump(t)
        if (t.attachment === attachment) {
            const { cols, rows } = size
            try {
                if (cols !== t.cols || rows !== t.rows) {
                    t.screen.resize(cols, rows)
                    t.cols = cols
                    t.rows = rows
                }
                // A fresh spawn has nothing to repaint; a screen with
                // content may be a full-screen TUI that only redraws on
                // SIGWINCH.
                if (snapshot) t.term.resize(Math.max(20, cols - 1), rows)
                t.term.resize(cols, rows)
            } catch {}
        }
    }
    // The callback fires once everything written so far is parsed; the
    // pump is paused meanwhile, so the snapshot is exact.
    try {
        t.screen.write('', finishSnapshot)
    } catch {
        finishSnapshot()
    }
    return true
}

// The attachment's side is over (its push was cancelled); the terminal
// stays for the next one, until its TTL.
export const detachOwnedTerminal = (
    terminalId: string,
    refId: string
): boolean => {
    const t = owned.get(terminalId)
    if (!t || t.attachment?.refId !== refId) return false
    dropAttachment(t, { detached: true })
    armTtl(t, t.profileBound ? UNATTACHED_PROFILE_TTL_MS : UNATTACHED_TTL_MS)
    return true
}

export const resizeOwnedTerminal = (
    terminalId: string,
    cols: number,
    rows: number
): boolean => {
    const t = owned.get(terminalId)
    if (!t || t.exited) return false
    try {
        t.screen.resize(cols, rows)
        t.term.resize(cols, rows)
        t.cols = cols
        t.rows = rows
    } catch {}
    return true
}

export const closeOwnedTerminal = (terminalId: string): boolean => {
    const t = owned.get(terminalId)
    if (!t) return false
    stopTtl(t)
    hangUp(t)
    return true
}

// Test seam: forget everything without killing (the test owns the ptys).
export const resetOwnedTerminalsForTest = (): void => {
    for (const t of owned.values()) {
        stopTtl(t)
        try {
            t.screen.dispose()
        } catch {}
    }
    owned.clear()
}
