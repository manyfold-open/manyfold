export const FEATURE_TOGGLE_KEYS = Object.freeze({
    CLOUD_COMPUTER: 'cloud_computer',
    CLAUDE_PARTIAL_STREAM: 'claude_partial_stream',
    ACTIVE_HOURS_ENFORCEMENT: 'active_hours_enforcement',
    STORAGE_HARD_LIMIT: 'storage_hard_limit'
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
        key: FEATURE_TOGGLE_KEYS.CLAUDE_PARTIAL_STREAM,
        label: 'Claude token-level streaming',
        description:
            'Runs sprite/k8s Claude Code turns with --include-partial-messages so chat streams text as the model writes it instead of waiting for each complete content block. Turn off to fall back to block-level streaming (the pre-rollout behavior) if delta parsing or event volume misbehaves. Daemon runtime always stays block-level.',
        defaultEnabled: true
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
