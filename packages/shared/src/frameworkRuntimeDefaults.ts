export const configurableFrameworkRuntimeDefaults = [
    'hermes',
    'openclaw'
] as const

export type ConfigurableFrameworkRuntimeDefault =
    (typeof configurableFrameworkRuntimeDefaults)[number]

/**
 * Runtimes that frameworks can opt into for default selection. A subset of
 * AgentRuntime — `external` and `daemon` are not eligible defaults (the former
 * is bound to specific frameworks by `resolveRuntime`, the latter is always
 * a user-explicit choice).
 */
export type FrameworkRuntimeChoice = 'sprites' | 'k8s'

export interface FrameworkRuntimeDefaultsSettings {
    /**
     * Per-framework default runtime. Only consulted when the agent's `dto.runtime`
     * is not supplied AND the framework has more than one valid runtime (today:
     * Hermes, OpenClaw). Entries are explicit and complete; migrations seed and
     * backfill these rows instead of relying on implicit runtime behavior.
     */
    defaults: Record<
        ConfigurableFrameworkRuntimeDefault,
        FrameworkRuntimeChoice
    >
}

export interface UpdateFrameworkRuntimeDefaultsSettingsBody {
    defaults: Record<
        ConfigurableFrameworkRuntimeDefault,
        FrameworkRuntimeChoice
    >
}

/**
 * Per-user override of the admin-level default. Resolution order:
 *   1. dto.runtime (caller-explicit) — wins
 *   2. user-level override (this type) — applies only to one user
 *   3. admin defaults (FrameworkRuntimeDefaultsSettings) — global
 *   4. framework platform default for frameworks outside the admin setting
 */
export interface UserFrameworkRuntimeOverridesSettings {
    overrides: Partial<
        Record<ConfigurableFrameworkRuntimeDefault, FrameworkRuntimeChoice>
    >
}

export interface UpdateUserFrameworkRuntimeOverridesSettingsBody {
    overrides: Partial<
        Record<ConfigurableFrameworkRuntimeDefault, FrameworkRuntimeChoice>
    >
}

export const DEFAULT_USER_FRAMEWORK_RUNTIME_OVERRIDES: UserFrameworkRuntimeOverridesSettings =
    {
        overrides: {}
    }
