import type { DaemonStartupMethod } from '@manyfold/shared'
import { type CliChannel, DEFAULT_API_URL } from '@/channel'
import { resolveUpdateStatus } from '@/commands/update'
import type { IdleUpdateOutcome } from './update-drain'

// Background fleet freshness, multica-style: poll the channel manifest and
// install the latest build — but ONLY when the daemon is fully idle. Unlike an
// admin-requested daemon.update, this path never drains: nobody asked for it,
// so it must never pause sessions; when busy it just retries sooner.
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000
export const AUTO_UPDATE_BUSY_RETRY_MS = 15 * 60_000
export const AUTO_UPDATE_INITIAL_DELAY_MS = 5 * 60_000

export interface AutoUpdateDecision {
    enabled: boolean
    reason: string
}

const normalizedUrl = (value: string): string =>
    value.trim().replace(/\/+$/, '')

// Hard gates first (they make a self-restart unsafe regardless of intent),
// then the explicit env switch, then the multica-style default: on for the
// official channel API, off for custom/self-hosted URLs.
export const resolveAutoUpdateEnabled = (opts: {
    envValue: string | undefined
    apiUrl: string
    channel: CliChannel
    standalone: boolean
    startupMethod: DaemonStartupMethod
}): AutoUpdateDecision => {
    if (!opts.standalone) return { enabled: false, reason: 'dev build' }
    if (opts.startupMethod === 'manual')
        return {
            enabled: false,
            reason: 'no init unit to respawn after a self-update'
        }
    const env = opts.envValue?.trim().toLowerCase()
    if (env) {
        if (['0', 'false', 'off', 'no'].includes(env))
            return { enabled: false, reason: 'MF_DAEMON_AUTO_UPDATE=off' }
        if (['1', 'true', 'on', 'yes'].includes(env))
            return { enabled: true, reason: 'MF_DAEMON_AUTO_UPDATE=on' }
        return {
            enabled: false,
            reason: `unrecognized MF_DAEMON_AUTO_UPDATE value "${env}"`
        }
    }
    // Both channels default to the same production API now, so this is a
    // single comparison; the channel only colours the reason string.
    return normalizedUrl(opts.apiUrl) === normalizedUrl(DEFAULT_API_URL)
        ? { enabled: true, reason: `official ${opts.channel} channel` }
        : {
              enabled: false,
              reason: 'custom API URL (enable with MF_DAEMON_AUTO_UPDATE=1)'
          }
}

export type AutoUpdateTickResult =
    | 'up-to-date'
    | 'applied'
    | 'restarting'
    | 'busy'
    | 'check-failed'
    | 'apply-failed'

export interface AutoUpdateLoopDeps {
    channel: CliChannel
    currentVersion: string
    currentCommit?: string | null
    // The dev channel is ordered by commit, so the check needs both.
    fetchLatest: () => Promise<{ version: string; commit: string }>
    applyIfIdle: (targetVersion: string) => Promise<IdleUpdateOutcome>
    log: (msg: string) => void
    checkIntervalMs?: number
    busyRetryMs?: number
    initialDelayMs?: number
}

export class DaemonAutoUpdater {
    private timer: NodeJS.Timeout | null = null
    private stopped = false

    constructor(private readonly deps: AutoUpdateLoopDeps) {}

    start(): void {
        this.schedule(this.deps.initialDelayMs ?? AUTO_UPDATE_INITIAL_DELAY_MS)
    }

    stop(): void {
        this.stopped = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
    }

    // Never throws: a flaky origin or a failed download must not take the loop
    // (let alone the daemon) down — it logs and retries on the next tick.
    async tick(): Promise<AutoUpdateTickResult> {
        let head: { version: string; commit: string }
        try {
            head = await this.deps.fetchLatest()
        } catch (err) {
            this.deps.log(
                `auto-update check failed: ${(err as Error).message}`
            )
            return 'check-failed'
        }
        const latest = head.version.trim()
        if (!latest) {
            this.deps.log('auto-update check failed: manifest has no version')
            return 'check-failed'
        }
        const status = resolveUpdateStatus({
            channel: this.deps.channel,
            currentVersion: this.deps.currentVersion,
            currentCommit: this.deps.currentCommit ?? null,
            targetVersion: latest,
            targetCommit: head.commit
        })
        if (status !== 'update') return 'up-to-date'
        let outcome: IdleUpdateOutcome
        try {
            outcome = await this.deps.applyIfIdle(latest)
        } catch (err) {
            this.deps.log(
                `auto-update to ${latest} failed: ${(err as Error).message}`
            )
            return 'apply-failed'
        }
        if (outcome.kind === 'busy') {
            this.deps.log(
                `auto-update: ${this.deps.currentVersion} → ${latest} available; ` +
                    `${outcome.activeSessions} active session(s), retrying when idle`
            )
            return 'busy'
        }
        if (outcome.result.changed) {
            this.deps.log(
                `auto-update: installed ${outcome.result.to}; restarting`
            )
            return 'restarting'
        }
        return 'applied'
    }

    nextDelayMs(result: AutoUpdateTickResult): number {
        return result === 'busy'
            ? (this.deps.busyRetryMs ?? AUTO_UPDATE_BUSY_RETRY_MS)
            : (this.deps.checkIntervalMs ?? AUTO_UPDATE_CHECK_INTERVAL_MS)
    }

    private schedule(delayMs: number): void {
        if (this.stopped) return
        // ±10% jitter so a fleet rebooted together does not hit the release
        // origin (or restart) in lockstep.
        const jittered = Math.round(delayMs * (0.9 + Math.random() * 0.2))
        this.timer = setTimeout(() => {
            void this.tick().then((result) => {
                if (result === 'restarting') return
                this.schedule(this.nextDelayMs(result))
            })
        }, jittered)
    }
}
