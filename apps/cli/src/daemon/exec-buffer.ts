import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync
} from 'node:fs'
import { join } from 'node:path'
import type {
    DaemonInflightStream,
    DaemonInflightStreamStatus,
    DaemonRpcMethod,
    DaemonStreamKind
} from '@manyfold/shared'
import { daemonPaths } from './config'

const GC_AGE_MS = 24 * 60 * 60 * 1000
// How long a COMPLETED stream stays serveable — in the hello AND on disk (the
// same constant gates gcStaleBuffers, deliberately: advertising a stream whose
// buffer was collected would be worse than not advertising it). 5 minutes was
// enough for reconnect-and-resume, but #518 showed the server can still be
// consuming a completed stream much later (its delivery lagged the exec by
// 5.5min); a rolling-deploy hello then omitted the stream and the server
// converged a fully-successful turn as unresumable. The window is cheap: it
// only covers streams completed within the last hour, not the whole buffer.
const COMPLETE_GRACE_MS = 60 * 60 * 1000

export interface ExecBufferMeta {
    refId: string
    method: DaemonRpcMethod
    payload: Record<string, unknown>
    startedAt: string
    status: DaemonInflightStreamStatus
    completedAt?: string
}

export interface ExecBufferFinal {
    ok: boolean
    error?: string
    payload?: Record<string, unknown>
}

export interface ExecBufferEvent {
    seq: number
    kind: DaemonStreamKind | '__done__'
    data: string
}

export type ExecStreamSubscriber = (
    kind: DaemonStreamKind | '__done__',
    data: string,
    seq: number
) => void

interface ExecStreamArgs {
    refId: string
    method: DaemonRpcMethod
    payload: Record<string, unknown>
}

const ensureExecRoot = (): void => {
    mkdirSync(daemonPaths.execDir, { recursive: true, mode: 0o700 })
}

const bufferDir = (refId: string): string => join(daemonPaths.execDir, refId)

const metaPath = (refId: string): string => join(bufferDir(refId), 'meta.json')
const eventsPath = (refId: string): string =>
    join(bufferDir(refId), 'events.ndjson')
const finalPath = (refId: string): string =>
    join(bufferDir(refId), 'final.json')

const atomicWriteSync = (path: string, body: string): void => {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    const fd = openSync(tmp, 'w', 0o600)
    try {
        writeSync(fd, body)
        fsyncSync(fd)
    } finally {
        closeSync(fd)
    }
    renameSync(tmp, path)
}

const readJsonIfPresent = <T>(path: string): T | null => {
    try {
        const raw = readFileSync(path, 'utf8')
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

const writeMeta = (meta: ExecBufferMeta): void => {
    atomicWriteSync(metaPath(meta.refId), JSON.stringify(meta, null, 2))
}

const writeFinal = (refId: string, final: ExecBufferFinal): void => {
    atomicWriteSync(finalPath(refId), JSON.stringify(final, null, 2))
}

const appendEventSync = (refId: string, event: ExecBufferEvent): void => {
    const fd = openSync(eventsPath(refId), 'a', 0o600)
    try {
        writeSync(fd, `${JSON.stringify(event)}\n`)
        fsyncSync(fd)
    } finally {
        closeSync(fd)
    }
}

const readEventsFromSync = (
    refId: string,
    fromSeq: number
): ExecBufferEvent[] => {
    let raw: string
    try {
        raw = readFileSync(eventsPath(refId), 'utf8')
    } catch {
        return []
    }
    const out: ExecBufferEvent[] = []
    for (const line of raw.split('\n')) {
        if (!line) continue
        try {
            const event = JSON.parse(line) as ExecBufferEvent
            if (event.seq > fromSeq) out.push(event)
        } catch {}
    }
    return out
}

export class ExecStream {
    readonly refId: string
    readonly method: DaemonRpcMethod
    readonly subscribers = new Set<ExecStreamSubscriber>()
    status: DaemonInflightStreamStatus = 'running'
    seq = 0
    completedAt: number | null = null

    constructor(args: ExecStreamArgs) {
        this.refId = args.refId
        this.method = args.method
        ensureExecRoot()
        mkdirSync(bufferDir(args.refId), { recursive: true, mode: 0o700 })
        writeMeta({
            refId: args.refId,
            method: args.method,
            payload: args.payload,
            startedAt: new Date().toISOString(),
            status: 'running'
        })
        try {
            writeFileSync(eventsPath(args.refId), '', { mode: 0o600, flag: 'a' })
        } catch {}
    }

    publish(kind: DaemonStreamKind, data: string): number {
        if (this.status !== 'running')
            throw new Error(
                `cannot publish to ${this.status} stream ${this.refId}`
            )
        this.seq += 1
        const seq = this.seq
        try {
            appendEventSync(this.refId, { seq, kind, data })
        } catch (err) {
            this.complete(
                {
                    ok: false,
                    error: `buffer append failed: ${(err as Error).message}`
                },
                'crashed'
            )
            throw err
        }
        for (const sub of this.subscribers) {
            try {
                sub(kind, data, seq)
            } catch {
                this.subscribers.delete(sub)
            }
        }
        return seq
    }

    subscribe(cb: ExecStreamSubscriber, fromSeq: number): () => void {
        const unsubscribe = (): void => {
            this.subscribers.delete(cb)
        }
        const events = readEventsFromSync(this.refId, fromSeq)
        for (const event of events) {
            try {
                cb(event.kind, event.data, event.seq)
            } catch {
                return unsubscribe
            }
        }
        if (this.status === 'running') this.subscribers.add(cb)
        return unsubscribe
    }

    complete(
        final: ExecBufferFinal,
        status: 'completed' | 'aborted' | 'crashed'
    ): void {
        if (this.status !== 'running') return
        this.status = status
        this.completedAt = Date.now()
        const cachedMeta = readMeta(this.refId)
        try {
            writeFinal(this.refId, final)
        } catch (err) {
            console.error(
                `exec-buffer final.json write failed for ${this.refId}: ${(err as Error).message}`
            )
        }
        try {
            writeMeta({
                refId: this.refId,
                method: this.method,
                payload: cachedMeta?.payload ?? {},
                startedAt: cachedMeta?.startedAt ?? new Date().toISOString(),
                status,
                completedAt: new Date().toISOString()
            })
        } catch (err) {
            console.error(
                `exec-buffer meta.json write failed for ${this.refId}: ${(err as Error).message}`
            )
        }
        for (const sub of this.subscribers) {
            try {
                sub('__done__', JSON.stringify(final), this.seq + 1)
            } catch {}
        }
        this.subscribers.clear()
    }
}

const streams = new Map<string, ExecStream>()

export const execStreams = {
    get: (refId: string): ExecStream | undefined => streams.get(refId),
    set: (refId: string, stream: ExecStream): void => {
        streams.set(refId, stream)
    },
    delete: (refId: string): void => {
        streams.delete(refId)
    },
    keys: (): string[] => [...streams.keys()]
}

export const readMeta = (refId: string): ExecBufferMeta | null =>
    readJsonIfPresent<ExecBufferMeta>(metaPath(refId))

export const readFinal = (refId: string): ExecBufferFinal | null =>
    readJsonIfPresent<ExecBufferFinal>(finalPath(refId))

export const readEventsFrom = (
    refId: string,
    fromSeq: number
): ExecBufferEvent[] => readEventsFromSync(refId, fromSeq)

export const lastSeq = (refId: string): number => {
    const events = readEventsFromSync(refId, 0)
    return events.length > 0 ? events[events.length - 1].seq : 0
}

const markCrashed = (refId: string): void => {
    const meta = readMeta(refId)
    if (!meta) return
    writeMeta({ ...meta, status: 'crashed', completedAt: new Date().toISOString() })
}

const removeBuffer = (refId: string): void => {
    try {
        rmSync(bufferDir(refId), { recursive: true, force: true })
    } catch {}
}

export const recoverCrashedBuffers = (): void => {
    ensureExecRoot()
    let entries: string[]
    try {
        entries = readdirSync(daemonPaths.execDir)
    } catch {
        return
    }
    for (const refId of entries) {
        const meta = readMeta(refId)
        if (!meta) continue
        const final = readFinal(refId)
        if (meta.status === 'running' && !final) markCrashed(refId)
    }
}

export const gcStaleBuffers = (now = Date.now()): number => {
    ensureExecRoot()
    let entries: string[]
    try {
        entries = readdirSync(daemonPaths.execDir)
    } catch {
        return 0
    }
    let removed = 0
    for (const refId of entries) {
        const dir = bufferDir(refId)
        let s
        try {
            s = statSync(dir)
        } catch {
            continue
        }
        const age = now - s.mtimeMs
        const meta = readMeta(refId)
        const isTerminal =
            !!meta &&
            (meta.status === 'completed' ||
                meta.status === 'aborted' ||
                meta.status === 'crashed')
        // A turn THIS process is still streaming is never collected, whatever
        // its age. The age rule keyed off the directory's mtime, which appends
        // do not touch — so it was effectively the turn's START time, and a
        // long-running turn had the very log its resume depends on deleted out
        // from under it. On-disk `running` with nothing in memory is a crashed
        // leftover (recoverCrashedBuffers relabels those at startup) and still
        // ages out, so nothing leaks.
        const live = streams.get(refId)
        if (live?.status === 'running') continue
        if (age >= GC_AGE_MS) {
            removeBuffer(refId)
            streams.delete(refId)
            removed += 1
            continue
        }
        // completedAt from the in-memory stream when this process ran the turn,
        // from meta.json otherwise. Relying on the in-memory value alone meant a
        // restarted daemon had no completedAt for any earlier buffer, so every
        // one of them waited out the full 24h age rule instead of the 5min
        // grace.
        const stream = live
        const completedAt =
            stream?.completedAt ??
            (meta?.completedAt ? Date.parse(meta.completedAt) : null)
        if (
            isTerminal &&
            completedAt !== null &&
            Number.isFinite(completedAt) &&
            now - completedAt >= COMPLETE_GRACE_MS
        ) {
            removeBuffer(refId)
            streams.delete(refId)
            removed += 1
        }
    }
    return removed
}

// What the server can still ACT on: a stream that is running, or one that just
// finished and whose final may not have reached the server before the socket
// dropped. Anything older than that grace window is history — the server has
// long since terminalized the turn, and re-offering it is pure cost on both
// sides.
//
// The old rule ("skip completed, unless it is still in the in-memory map") had
// that backwards: `streams` only sheds an entry when GC removes its buffer, so
// a long-lived daemon kept every completed stream in memory AND reported it in
// every hello, forever. Measured effect: one staging daemon reported 20559
// streams and exactly 1 of them was an unfinished turn; prod daemons sit at
// ~4800 and climb daily. Each entry also costs a full read+parse of that
// turn's event log here (`lastSeq`), on every single reconnect.
const isStillActionable = (
    status: DaemonInflightStreamStatus,
    completedAt: string | undefined,
    now: number
): boolean => {
    if (status === 'running') return true
    if (!completedAt) return true
    const finishedAgo = now - Date.parse(completedAt)
    return Number.isFinite(finishedAgo) && finishedAgo < COMPLETE_GRACE_MS
}

export const enumerateInflightForHello = (
    now = Date.now()
): DaemonInflightStream[] => {
    ensureExecRoot()
    let entries: string[]
    try {
        entries = readdirSync(daemonPaths.execDir)
    } catch {
        return []
    }
    const out: DaemonInflightStream[] = []
    for (const refId of entries) {
        const meta = readMeta(refId)
        if (!meta) continue
        const live = execStreams.get(refId)
        const status: DaemonInflightStreamStatus = live?.status ?? meta.status
        const completedAt = live?.completedAt
            ? new Date(live.completedAt).toISOString()
            : meta.completedAt
        if (!isStillActionable(status, completedAt, now)) continue
        out.push({
            refId,
            method: meta.method,
            lastSeq: lastSeq(refId),
            status
        })
    }
    return out
}
