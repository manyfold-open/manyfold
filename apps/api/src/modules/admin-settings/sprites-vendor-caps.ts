import type {
    SpritesVendorAccountCapacity,
    SpritesVendorCapacityView,
    SpritesWholesaleCapSettings
} from '@manyfold/shared'

// Pure composition of admin capacity POLICY against sprites.dev's own reported
// ceilings. No Nest/DB deps so the clamp math unit-tests in isolation.
//
// sprites.dev returns running_limit / warm_limit in the GET /sprites envelope on
// every call, so the vendor ceiling never has to be hand-copied into a setting.
// The admin setting stays meaningful as a policy floor-limiter (reserve headroom
// below the vendor cap on purpose); what it can no longer do is silently promise
// capacity the vendor will refuse.

export interface SpritesVendorAccountObservation {
    slug: string
    runningLimit: number | null
    warmLimit: number | null
    running: number
    warm: number
    cold: number
    observedAt: string
}

export interface SpritesEffectiveCap extends SpritesWholesaleCapSettings {
    policyActiveCap: number
    vendorRunningLimit: number | null
    clamped: boolean
}

// An observation older than this stops counting. Self-cleaning: a disabled or
// deleted account ages out with no pruning pass, and if the status-sync loop
// dies the clamp disengages and admission falls back to admin policy — i.e. to
// exactly the pre-clamp behavior, never to a tighter cap nobody asked for.
export const VENDOR_CAPS_STALE_MS = 15 * 60_000

const optionalCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

const count = (value: unknown): number => optionalCount(value) ?? 0

export const parseVendorObservation = (
    value: unknown
): SpritesVendorAccountObservation | null => {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    if (typeof raw.slug !== 'string') return null
    if (typeof raw.observedAt !== 'string') return null
    return {
        slug: raw.slug,
        runningLimit: optionalCount(raw.runningLimit),
        warmLimit: optionalCount(raw.warmLimit),
        running: count(raw.running),
        warm: count(raw.warm),
        cold: count(raw.cold),
        observedAt: raw.observedAt
    }
}

export const isStaleObservation = (
    observation: SpritesVendorAccountObservation,
    now: number
): boolean => {
    const at = Date.parse(observation.observedAt)
    return !Number.isFinite(at) || now - at >= VENDOR_CAPS_STALE_MS
}

// Sums running_limit across accounts because a sprite lives in exactly one
// account and provisioning spreads across them (SpritesAccountsService
// .selectForCreate picks the least-loaded enabled account), matching the
// org-wide running counter admission already compares against. With a single
// account — the only prod shape today — sum == that account's limit. Caveat for
// a future multi-account setup: spreading is by provisioned count, not running
// count, so the sum can over-promise if every wake targets one account.
export const vendorRunningLimitTotal = (
    observations: Record<string, SpritesVendorAccountObservation>,
    now: number
): number | null => {
    let total: number | null = null
    for (const observation of Object.values(observations)) {
        if (isStaleObservation(observation, now)) continue
        if (observation.runningLimit === null) continue
        total = (total ?? 0) + observation.runningLimit
    }
    return total
}

// Re-write an unchanged observation only this often, so the 3s fast-cadence
// status-sync tick doesn't turn into a 3s write loop on app_settings.
export const VENDOR_CAPS_REFRESH_MS = 5 * 60_000

export const shouldRecordObservation = (
    known: SpritesVendorAccountObservation | undefined,
    next: Omit<SpritesVendorAccountObservation, 'observedAt'>,
    now: number
): boolean => {
    if (!known) return true
    const changed =
        known.slug !== next.slug ||
        known.runningLimit !== next.runningLimit ||
        known.warmLimit !== next.warmLimit ||
        known.running !== next.running ||
        known.warm !== next.warm ||
        known.cold !== next.cold
    if (changed) return true
    const age = now - Date.parse(known.observedAt)
    // Unparseable timestamp counts as due: better one redundant write than an
    // observation that can never refresh and ages into permanent staleness.
    return !Number.isFinite(age) || age >= VENDOR_CAPS_REFRESH_MS
}

export const effectiveSpritesCap = (
    policy: SpritesWholesaleCapSettings,
    observations: Record<string, SpritesVendorAccountObservation>,
    now: number
): SpritesEffectiveCap => {
    const vendorRunningLimit = vendorRunningLimitTotal(observations, now)
    const activeCap =
        vendorRunningLimit === null
            ? policy.activeCap
            : Math.min(policy.activeCap, vendorRunningLimit)
    return {
        activeCap,
        softThresholdPct: policy.softThresholdPct,
        policyActiveCap: policy.activeCap,
        vendorRunningLimit,
        clamped: activeCap < policy.activeCap
    }
}

export const vendorCapacityView = (
    policy: SpritesWholesaleCapSettings,
    observations: Record<string, SpritesVendorAccountObservation>,
    now: number
): SpritesVendorCapacityView => {
    const accounts: SpritesVendorAccountCapacity[] = Object.entries(
        observations
    )
        .map(([accountId, observation]) => ({
            accountId,
            slug: observation.slug,
            runningLimit: observation.runningLimit,
            warmLimit: observation.warmLimit,
            running: observation.running,
            warm: observation.warm,
            cold: observation.cold,
            observedAt: observation.observedAt,
            stale: isStaleObservation(observation, now)
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug))
    const fresh = accounts.filter((a) => !a.stale)
    const effective = effectiveSpritesCap(policy, observations, now)
    const warmLimits = fresh
        .map((a) => a.warmLimit)
        .filter((v): v is number => v !== null)
    return {
        accounts,
        runningLimitTotal: effective.vendorRunningLimit,
        warmLimitTotal: warmLimits.length
            ? warmLimits.reduce((sum, v) => sum + v, 0)
            : null,
        runningTotal: fresh.reduce((sum, a) => sum + a.running, 0),
        warmTotal: fresh.reduce((sum, a) => sum + a.warm, 0),
        coldTotal: fresh.reduce((sum, a) => sum + a.cold, 0),
        policyActiveCap: effective.policyActiveCap,
        effectiveActiveCap: effective.activeCap,
        clamped: effective.clamped
    }
}
