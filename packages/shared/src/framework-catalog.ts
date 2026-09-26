// The frameworks with an admin-managed model catalog (models, aliases and the
// effort / speed / intelligence enums behind their model settings).
export const configurableFrameworks = [
    'claude-code',
    'codex',
    'gemini-cli'
] as const
export type ConfigurableFramework = (typeof configurableFrameworks)[number]

export const isConfigurableFramework = (
    value: unknown
): value is ConfigurableFramework =>
    typeof value === 'string' &&
    configurableFrameworks.includes(value as ConfigurableFramework)

// The coding CLIs whose model settings an agent keeps and whose credentials it
// takes either from a platform provider or from the CLI's own sign-in on its
// runtime (AgentModelConfigSource): the model-config view and runtime-local.
// A superset of the catalog frameworks — pi and Antigravity CLI have no admin
// catalog; their platform models are the ones their provider serves.
export const modelConfigFrameworks = [
    ...configurableFrameworks,
    'pi',
    'antigravity-cli'
] as const
export type ModelConfigFramework = (typeof modelConfigFrameworks)[number]

export const isModelConfigFramework = (
    value: unknown
): value is ModelConfigFramework =>
    typeof value === 'string' &&
    modelConfigFrameworks.includes(value as ModelConfigFramework)

// The model-config frameworks a host can hold several sign-ins of, each in its
// own credential context (runtime auth profiles). A CLI belongs here only when
// a non-secret env var moves where it both reads and writes its credential, so
// one profile's login can never overwrite another's or the machine's own.
export const runtimeAuthProfileFrameworks = [
    'claude-code',
    'codex',
    'gemini-cli',
    'pi'
] as const satisfies readonly ModelConfigFramework[]
export type RuntimeAuthProfileFramework =
    (typeof runtimeAuthProfileFrameworks)[number]

export const isRuntimeAuthProfileFramework = (
    value: unknown
): value is RuntimeAuthProfileFramework =>
    typeof value === 'string' &&
    runtimeAuthProfileFrameworks.includes(value as RuntimeAuthProfileFramework)

export const frameworkEnumKeys = [
    'effort',
    'speed',
    'intelligence'
] as const
export type FrameworkEnumKey = (typeof frameworkEnumKeys)[number]

export const frameworkModelKinds = ['model', 'alias'] as const
export type FrameworkModelKind = (typeof frameworkModelKinds)[number]

export interface FrameworkModelCapabilitiesView {
    fast?: boolean
    longContext?: boolean
}

export interface FrameworkModelView {
    id: string
    framework: ConfigurableFramework
    modelKey: string
    kind: FrameworkModelKind
    displayName: string
    capabilities: FrameworkModelCapabilitiesView
    sortOrder: number
    isActive: boolean
    isDefault: boolean
}

export interface FrameworkEnumView {
    id: string
    framework: ConfigurableFramework
    enumKey: FrameworkEnumKey
    value: string
    displayName: string
    sortOrder: number
    isActive: boolean
    isDefault: boolean
}

export interface FrameworkCatalogView {
    framework: ConfigurableFramework
    models: FrameworkModelView[]
    enums: Partial<Record<FrameworkEnumKey, FrameworkEnumView[]>>
}

export interface CreateFrameworkModelBody {
    modelKey: string
    kind: FrameworkModelKind
    displayName: string
    capabilities?: FrameworkModelCapabilitiesView
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

export interface UpdateFrameworkModelBody {
    modelKey?: string
    kind?: FrameworkModelKind
    displayName?: string
    capabilities?: FrameworkModelCapabilitiesView
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

export interface CreateFrameworkEnumBody {
    enumKey: FrameworkEnumKey
    value: string
    displayName: string
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

export interface UpdateFrameworkEnumBody {
    value?: string
    displayName?: string
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}
