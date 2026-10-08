export const FEATURE_TOGGLE_KEYS = Object.freeze({
    CLOUD_COMPUTER: 'cloud_computer',
    ACTIVE_HOURS_ENFORCEMENT: 'active_hours_enforcement',
    STORAGE_HARD_LIMIT: 'storage_hard_limit',
    SANDBOX_HEALTH_CHECKS: 'sandbox_health_checks',
    SANDBOX_MAINTENANCE_AUTO: 'sandbox_maintenance_auto',
    SANDBOX_HEALTH_SWEEP: 'sandbox_health_sweep'
} as const)

export type FeatureToggleKey =
    | (typeof FEATURE_TOGGLE_KEYS)[keyof typeof FEATURE_TOGGLE_KEYS]
    | (string & {})

export interface FeatureToggleDefinition {
    key: FeatureToggleKey
    label: string
    description: string
    defaultEnabled: boolean
}

// Composition layers register their own toggle definitions at module load
// (the cloud edition's signup gate, etc.). Stored overrides for unknown keys
// are ignored by the reader, so registration order never corrupts settings.
const extraToggles: FeatureToggleDefinition[] = []

export const registerFeatureToggles = (
    defs: readonly FeatureToggleDefinition[]
): void => {
    for (const def of defs)
        if (!extraToggles.some((d) => d.key === def.key))
            extraToggles.push(def)
}

export const allFeatureToggles = (): readonly FeatureToggleDefinition[] => [
    ...FEATURE_TOGGLES,
    ...extraToggles
]

export const FEATURE_TOGGLES: readonly FeatureToggleDefinition[] = Object.freeze([
    {
        key: FEATURE_TOGGLE_KEYS.CLOUD_COMPUTER,
        label: 'Cloud computer',
        description:
            'Master switch for the persistent k8s container runtime. When off, the option is hidden for every user and new reservations are blocked, regardless of per-user access.',
        defaultEnabled: false
    },
    {
        key: FEATURE_TOGGLE_KEYS.ACTIVE_HOURS_ENFORCEMENT,
        label: 'Active hours hard enforcement',
        description:
            'Enforces plans.monthly_active_hours_included: over-quota users are blocked from new sandbox activity (chat turns, wake, terminal, keep-alive) with ACTIVE_HOURS_QUOTA_REACHED, and the background sweep force-sleeps their running sandboxes. When off, active hours are metered and warned about but never block. Per-user relief: users.active_hours_bonus.',
        defaultEnabled: false
    },
    {
        key: FEATURE_TOGGLE_KEYS.STORAGE_HARD_LIMIT,
        label: 'Storage hard limit',
        description:
            'Blocks NEW sprite sandbox/runtime provisioning with STORAGE_LIMIT_REACHED once a user\'s measured sandbox storage meets plans.max_storage_gb. Waking existing sandboxes stays allowed so users can free up space. When off, storage only soft-warns at 95%.',
        defaultEnabled: false
    },
    {
        key: FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS,
        label: 'Sandbox health checks after failures',
        description:
            'When a sprites sandbox fails to wake or its daemon does not come up, ask the provider\'s health check about that machine, at most once per 10 minutes per sandbox. The check can repair the machine (for example restart a stopped one), so it never runs on a sandbox whose daemon is online. Verdicts are recorded and shown in admin; whether an unhealthy verdict puts the sandbox into maintenance is the separate automatic-maintenance switch.',
        defaultEnabled: false
    },
    {
        key: FEATURE_TOGGLE_KEYS.SANDBOX_MAINTENANCE_AUTO,
        label: 'Automatic sandbox maintenance',
        description:
            'Lets an automatic health check put a sandbox whose machine failed to start (an unhealthy verdict) into maintenance: chat turns, A2A tasks and automation runs on it fail at once instead of spending minutes on wake retries, and it is re-checked on a backoff until a verdict other than unhealthy returns it to ready. A sleeping machine answers needs_repair and a stopped one repaired; neither counts as a problem. A capped number of sandboxes may enter per hour. When off, automatic verdicts are only recorded; an admin\'s manual check always applies its verdict.',
        defaultEnabled: false
    },
    {
        key: FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_SWEEP,
        label: 'Daily sandbox health sweep',
        description:
            'Health-checks each ready sprites sandbox at most once a day when its daemon has not been seen for 24 hours, a few at a time, so a machine that broke while idle is found before its owner hits it. The check may start or restart the machine.',
        defaultEnabled: false
    }
])

export interface FeatureToggleView {
    key: FeatureToggleKey
    label: string
    description: string
    enabled: boolean
    defaultEnabled: boolean
    overridden: boolean
}

export interface FeatureTogglesView {
    toggles: FeatureToggleView[]
}

export interface UpdateFeatureToggleBody {
    key: FeatureToggleKey
    enabled: boolean
}

export const isFeatureToggleKey = (
    value: string
): value is FeatureToggleKey =>
    allFeatureToggles().some((toggle) => toggle.key === value)
