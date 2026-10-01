import {
    DAEMON_UPDATE_DRAIN_TIMEOUT_MS,
    DAEMON_UPDATE_IN_PROGRESS_ERROR
} from '@manyfold/shared'
import type { CliChannel } from '@/channel'
import type { SelfUpdateResult } from '@/commands/update'

export interface DaemonUpdateSpec {
    targetVersion?: string
    channel?: CliChannel
}

export type UpdateRequestOutcome =
    | { kind: 'applied'; result: SelfUpdateResult }
    | { kind: 'deferred'; activeSessions: number }

export type IdleUpdateOutcome =
    | { kind: 'applied'; result: SelfUpdateResult }
    | { kind: 'busy'; activeSessions: number }

// Applying an update restarts the daemon, which kills every live exec/pty
// session mid-flight. Instead of restarting immediately, a busy daemon defers
// the update, stops admitting new sessions, and applies once the last session
// ends. The deadline bounds the wait: an idle-forever pty must not park the
// daemon in a half-closed state indefinitely, so after it the update proceeds
// even at the cost of the remaining sessions (the admin asked for it). The API
// holds a sandbox awake for the same window, so the drain can finish.
const DEFAULT_DRAIN_TIMEOUT_MS = DAEMON_UPDATE_DRAIN_TIMEOUT_MS

// Nobody waits on a deferred update's RPC, so only the daemon sees it fail. A
// failure the next attempt can get past (the manifest or the download timing
// out) is tried again a little later, new sessions still refused in between;
// the last failure gives the update up.
// Seen on local [2026-10-01]: a deferred apply's manifest fetch hit its 10 s
// timeout, the update was dropped and the API held the sandbox awake for the
// rest of its drain window; asked again, the same update landed in seconds.
const DEFERRED_APPLY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 15_000

export const UPDATE_PENDING_ERROR =
    'daemon is applying an update and will restart shortly; retry in a moment'

export interface UpdateDrainDeps {
    activeSessions: () => number
    applyUpdate: (spec: DaemonUpdateSpec) => Promise<SelfUpdateResult>
    restart: (result: SelfUpdateResult) => void
    log: (msg: string) => void
    drainTimeoutMs?: number
    retryDelayMs?: number
}

export class UpdateDrainCoordinator {
    private pending: DaemonUpdateSpec | null = null
    private applying = false
    private deadlineTimer: NodeJS.Timeout | null = null
    private retryTimer: NodeJS.Timeout | null = null
    private failedAttempts = 0

    constructor(private readonly deps: UpdateDrainDeps) {}

    blocksNewSessions(): boolean {
        return this.pending !== null || this.applying
    }

    async request(spec: DaemonUpdateSpec): Promise<UpdateRequestOutcome> {
        if (this.applying) throw new Error(DAEMON_UPDATE_IN_PROGRESS_ERROR)
        this.failedAttempts = 0
        const active = this.deps.activeSessions()
        if (active === 0) {
            this.takePending()
            return { kind: 'applied', result: await this.apply(spec) }
        }
        this.pending = spec
        // A request repeated while the drain runs keeps its deadline:
        // re-arming it on every retry let a busy daemon put the update off
        // for good.
        if (!this.deadlineTimer) this.armDeadline()
        return { kind: 'deferred', activeSessions: active }
    }

    // The background auto-updater's path: apply only when the daemon is fully
    // idle, otherwise step aside without gating new sessions — nobody asked
    // for this update, so it must never degrade service. An admin-requested
    // drain in progress also reports busy and keeps ownership of the restart.
    // The idle check and apply() marking `applying` share one synchronous
    // stretch, so no session can slip in between them.
    async requestIfIdle(spec: DaemonUpdateSpec): Promise<IdleUpdateOutcome> {
        const active = this.deps.activeSessions()
        if (this.applying || this.pending !== null || active > 0)
            return { kind: 'busy', activeSessions: active }
        return { kind: 'applied', result: await this.apply(spec) }
    }

    onSessionEnd(): void {
        if (!this.pending || this.applying || this.retryTimer) return
        if (this.deps.activeSessions() > 0) return
        const spec = this.takePending()
        if (!spec) return
        this.deps.log('all sessions ended; applying deferred update')
        this.applyDeferred(spec)
    }

    private armDeadline(): void {
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
        const timer = setTimeout(() => {
            const active = this.deps.activeSessions()
            const spec = this.takePending()
            if (!spec) return
            this.deps.log(
                `update drain deadline reached with ${active} active session(s); applying update now`
            )
            this.applyDeferred(spec)
        }, this.deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)
        timer.unref?.()
        this.deadlineTimer = timer
    }

    private applyDeferred(spec: DaemonUpdateSpec): void {
        void this.apply(spec).then(
            () => {
                this.failedAttempts = 0
            },
            (err) => {
                const reason = (err as Error).message
                this.failedAttempts += 1
                if (this.failedAttempts >= DEFERRED_APPLY_ATTEMPTS) {
                    this.failedAttempts = 0
                    this.deps.log(`deferred update failed: ${reason}`)
                    return
                }
                const delayMs =
                    this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
                this.deps.log(
                    `deferred update failed: ${reason}; trying again in ${Math.round(delayMs / 1000)}s`
                )
                this.pending = spec
                const timer = setTimeout(() => {
                    this.retryTimer = null
                    // A session that got in anyway is drained like any other.
                    if (this.deps.activeSessions() > 0) {
                        if (!this.deadlineTimer) this.armDeadline()
                        return
                    }
                    const next = this.takePending()
                    if (next) this.applyDeferred(next)
                }, delayMs)
                timer.unref?.()
                this.retryTimer = timer
            }
        )
    }

    private takePending(): DaemonUpdateSpec | null {
        const spec = this.pending
        this.pending = null
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer)
            this.deadlineTimer = null
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer)
            this.retryTimer = null
        }
        return spec
    }

    // `applying` stays true after a successful binary swap: the daemon is about
    // to exit and must not admit sessions it cannot finish.
    private async apply(spec: DaemonUpdateSpec): Promise<SelfUpdateResult> {
        this.applying = true
        try {
            const result = await this.deps.applyUpdate(spec)
            if (result.changed) {
                this.deps.restart(result)
                return result
            }
            this.applying = false
            return result
        } catch (err) {
            this.applying = false
            throw err
        }
    }
}
