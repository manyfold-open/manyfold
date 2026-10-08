import type { SandboxHealthVerdict, SandboxSummary } from '@manyfold/shared'
import type { BadgeTone } from '@/ui'

// The provider health check's verdict as the Sandboxes page draws it: a
// machine that failed to start is the error. A sleeping machine answers
// needs_repair and a stopped one repaired, which is how every idle sandbox
// looks, so both stay neutral, as does a status the platform does not know
// (its literal is in the reason).
const HEALTH_TONE: Record<SandboxHealthVerdict, BadgeTone> = {
    healthy: 'success',
    unhealthy: 'error',
    needs_repair: 'neutral',
    repaired: 'neutral',
    unknown: 'neutral'
}

export const healthTone = (verdict: SandboxHealthVerdict): BadgeTone =>
    HEALTH_TONE[verdict]

export const healthLabel = (verdict: SandboxHealthVerdict): string =>
    verdict.replace('_', ' ')

// Only a ready sandbox, or one already in maintenance, has a machine worth
// asking the provider about.
export const canCheckHealth = (status: SandboxSummary['status']): boolean =>
    status === 'ready' || status === 'maintenance'

// Coarse on purpose: the page polls every 10 s.
export const span = (ms: number): string => {
    const abs = Math.abs(ms)
    if (abs < 60_000) return 'under a minute'
    if (abs < 60 * 60_000) return `${Math.round(abs / 60_000)} min`
    if (abs < 48 * 60 * 60_000) return `${Math.round(abs / 3_600_000)} h`
    return `${Math.round(abs / 86_400_000)} d`
}

export const checkedAgo = (iso: string, now: number = Date.now()): string =>
    now - Date.parse(iso) < 60_000
        ? 'checked just now'
        : `checked ${span(now - Date.parse(iso))} ago`

// One line under a sandbox in maintenance: how long, when it is asked again,
// and how many problem verdicts in a row it has had.
export const maintenanceLine = (
    r: Pick<SandboxSummary, 'status' | 'maintenanceSince' | 'health'>,
    now: number = Date.now()
): string | null => {
    if (r.status !== 'maintenance') return null
    const parts: string[] = []
    if (r.maintenanceSince)
        parts.push(`maintenance for ${span(now - Date.parse(r.maintenanceSince))}`)
    const next = r.health?.nextCheckAt
    if (next)
        parts.push(
            Date.parse(next) <= now
                ? 're-check due'
                : `next check in ${span(Date.parse(next) - now)}`
        )
    const failures = r.health?.failureCount ?? 0
    if (failures > 0)
        parts.push(`${failures} bad check${failures === 1 ? '' : 's'} in a row`)
    return parts.join(' · ')
}
