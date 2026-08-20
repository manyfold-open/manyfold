import {
    ConfigurableFramework,
    FrameworkEnumKey,
    FrameworkEnumView,
    FrameworkModelCapabilitiesView,
    FrameworkModelKind,
    FrameworkModelView,
    frameworkEnumKeys
} from '@manyfold/shared'
import type {
    FrameworkEnumCatalogRow,
    FrameworkModelCatalogRow
} from '@manyfold/db'

export {
    configurableFrameworks,
    frameworkEnumKeys,
    frameworkModelKinds,
    isConfigurableFramework
} from '@manyfold/shared'
export type {
    ConfigurableFramework,
    FrameworkCatalogView,
    FrameworkEnumKey,
    FrameworkEnumView,
    FrameworkModelCapabilitiesView,
    FrameworkModelKind,
    FrameworkModelView
} from '@manyfold/shared'

export const isFrameworkEnumKey = (
    value: unknown
): value is FrameworkEnumKey =>
    typeof value === 'string' &&
    frameworkEnumKeys.includes(value as FrameworkEnumKey)

export const modelRowToView = (
    row: FrameworkModelCatalogRow
): FrameworkModelView => ({
    id: row.id,
    framework: row.framework as ConfigurableFramework,
    modelKey: row.modelKey,
    kind: row.kind as FrameworkModelKind,
    displayName: row.displayName,
    capabilities: (row.capabilities ?? {}) as FrameworkModelCapabilitiesView,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isDefault: row.isDefault
})

export const enumRowToView = (
    row: FrameworkEnumCatalogRow
): FrameworkEnumView => ({
    id: row.id,
    framework: row.framework as ConfigurableFramework,
    enumKey: row.enumKey as FrameworkEnumKey,
    value: row.value,
    displayName: row.displayName,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isDefault: row.isDefault
})
