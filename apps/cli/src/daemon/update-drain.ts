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
// even at the cost of the remaining sessions (the admin asked for it).
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60_000

export const UPDATE_PENDING_ERROR =
    'daemon is applying an update and will restart shortly; retry in a moment'

export interface UpdateDrainDeps {
    activeSessions: () => number
    applyUpdate: (spec: DaemonUpdateSpec) => Promise<SelfUpdateResult>
    restart: () => void
    log: (msg: string) => void
    drainTimeoutMs?: number
}

export class UpdateDrainCoordinator {
    private pending: DaemonUpdateSpec | null = null
    private applying = false
    private deadlineTimer: NodeJS.Timeout | null = null

    constructor(private readonly deps: UpdateDrainDeps) {}

    blocksNewSessions(): boolean {
        return this.pending !== null || this.applying
    }

    async request(spec: DaemonUpdateSpec): Promise<UpdateRequestOutcome> {
        if (this.applying) throw new Error('daemon update already in progress')
        const active = this.deps.activeSessions()
        if (active === 0) {
            this.takePending()
            return { kind: 'applied', result: await this.apply(spec) }
        }
        this.pending = spec
        this.armDeadline()
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
        if (!this.pending || this.applying) return
        if (this.deps.activeSessions() > 0) return
        const spec = this.takePending()
        if (!spec) return
        this.deps.log('all sessions ended; applying deferred update')
        void this.apply(spec).catch((err) =>
            this.deps.log(
                `deferred update failed: ${(err as Error).message}`
            )
        )
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
            void this.apply(spec).catch((err) =>
                this.deps.log(
                    `deferred update failed: ${(err as Error).message}`
                )
            )
        }, this.deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)
        timer.unref?.()
        this.deadlineTimer = timer
    }

    private takePending(): DaemonUpdateSpec | null {
        const spec = this.pending
        this.pending = null
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer)
            this.deadlineTimer = null
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
                this.deps.restart()
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
