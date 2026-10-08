import type {
    RuntimeHostStatus,
    SandboxHealthCheckSource,
    SandboxHealthVerdict
} from '@manyfold/shared'

// Read per call, like the exec breaker's knobs: operators tune them on a
// running fleet. Garbage falls back to the default rather than to 0.
const envNumber = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
    return parsed
}

export const sandboxHealthConfig = (): {
    failureIntervalMs: number
    sweepIntervalMs: number
    sweepBatch: number
    maxAutoEntriesPerHour: number
} => ({
    // A machine that keeps failing is asked about at most this often.
    failureIntervalMs: envNumber(
        'MF_SANDBOX_HEALTH_FAILURE_INTERVAL_MS',
        10 * 60_000
    ),
    sweepIntervalMs: envNumber(
        'MF_SANDBOX_HEALTH_SWEEP_INTERVAL_MS',
        24 * 60 * 60_000
    ),
    sweepBatch: envNumber('MF_SANDBOX_HEALTH_SWEEP_BATCH', 2),
    // The circuit breaker on automatic entry: a provider incident, or a change
    // in what its check answers, must not put the whole fleet into maintenance.
    maxAutoEntriesPerHour: envNumber(
        'MF_SANDBOX_MAINTENANCE_MAX_AUTO_ENTRIES_PER_HOUR',
        5
    )
})

// How long a claim may run before another instance may take the host over:
// the check answers in about a second, the lease only has to outlive a slow one.
export const HEALTH_CHECK_LEASE_MS = 60_000

// When a sandbox in maintenance is checked again, by how many problem verdicts
// in a row it has had: soon at first, because a fault that clears by itself
// clears fast, then backing off to hourly.
export const RECHECK_LADDER_MS: readonly number[] = [
    2 * 60_000,
    10 * 60_000,
    30 * 60_000,
    60 * 60_000
]

// A `repaired` verdict means the provider just changed something; whether it
// worked is worth knowing within minutes, not after the ladder's next step.
export const REPAIRED_RECHECK_MS = 2 * 60_000

export const recheckDelayMs = (
    verdict: SandboxHealthVerdict | null,
    failureCount: number
): number =>
    verdict === 'repaired'
        ? REPAIRED_RECHECK_MS
        : RECHECK_LADDER_MS[
              Math.min(
                  Math.max(failureCount - 1, 0),
                  RECHECK_LADDER_MS.length - 1
              )
          ]

export type HealthTransition =
    | { action: 'exit' }
    | { action: 'enter' }
    | { action: 'stay' }
    | { action: 'none'; suppressed?: 'shadow' | 'capped' }

// What a verdict does to a host. Healthy is the only way out of maintenance;
// anything else keeps a host there, and puts a ready host in — always when an
// admin asked, and for an automatic check only while automatic entry is on and
// the hourly budget has room. Otherwise the verdict is only recorded.
export const decideTransition = (args: {
    verdict: SandboxHealthVerdict
    status: RuntimeHostStatus
    source: SandboxHealthCheckSource
    autoEnter: boolean
    budgetLeft: boolean
}): HealthTransition => {
    if (args.verdict === 'healthy')
        return args.status === 'maintenance'
            ? { action: 'exit' }
            : { action: 'none' }
    if (args.status === 'maintenance') return { action: 'stay' }
    if (args.status !== 'ready') return { action: 'none' }
    if (args.source === 'manual') return { action: 'enter' }
    if (!args.autoEnter) return { action: 'none', suppressed: 'shadow' }
    if (!args.budgetLeft) return { action: 'none', suppressed: 'capped' }
    return { action: 'enter' }
}

const REASON_MAX = 512

export const truncateReason = (reason: string | null): string | null =>
    reason === null
        ? null
        : reason.length > REASON_MAX
          ? `${reason.slice(0, REASON_MAX - 1)}…`
          : reason

// The line an admin and the host's owner read as the failure reason. Platform
// authored; an unknown status keeps its literal so it can be looked up.
export const maintenanceReasonText = (
    verdict: SandboxHealthVerdict,
    rawStatus: string,
    reason: string | null
): string =>
    truncateReason(
        `Health check: ${verdict === 'unknown' ? `status "${rawStatus}"` : verdict}${reason ? ` — ${reason}` : ''}`
    ) as string
