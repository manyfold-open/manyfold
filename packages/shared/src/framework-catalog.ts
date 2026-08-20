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
