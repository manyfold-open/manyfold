import {
    frameworkEnumCatalog,
    frameworkModelCatalog,
    type Database,
    type FrameworkEnumCatalogRow,
    type FrameworkModelCatalogRow
} from '@manyfold/db'
import {
    createObjectId,
    type FrameworkEnumCatalogRowSpec,
    type FrameworkModelCatalogRowSpec,
    type FrameworkModelCatalogRows
} from '@manyfold/shared'
import { eq, inArray } from 'drizzle-orm'

// Imports only packages: the migrate entrypoint that runs this in the release
// step has no path alias resolution.

type ModelFields = Omit<FrameworkModelCatalogRowSpec, 'framework' | 'modelKey'>
type EnumFields = Omit<
    FrameworkEnumCatalogRowSpec,
    'framework' | 'enumKey' | 'value'
>

interface RowUpdate<F> {
    id: string
    set: Partial<F>
}

export interface FrameworkCatalogSyncPlan {
    // Rows losing the default flag, cleared first: both tables have a partial
    // unique index on the default of a (framework, kind | enum_key) group, so
    // the flag can move only once the old holder has let go.
    clearModelDefaults: string[]
    clearEnumDefaults: string[]
    insertModels: FrameworkModelCatalogRowSpec[]
    insertEnums: FrameworkEnumCatalogRowSpec[]
    updateModels: RowUpdate<ModelFields>[]
    updateEnums: RowUpdate<EnumFields>[]
    // One line per change, for the release log and `import --dry-run`.
    changes: string[]
}

// Frameworks and enum keys never hold a space, so a space-joined key is both
// unambiguous and readable as it stands.
const groupKey = (...parts: string[]): string => parts.join(' ')

const capabilitiesKey = (value: unknown): string => {
    const flags =
        value && typeof value === 'object'
            ? Object.entries(value as Record<string, unknown>)
                  .filter(([, on]) => on === true)
                  .map(([name]) => name)
                  .sort()
            : []
    return flags.join(',')
}

const describe = (value: unknown): string =>
    typeof value === 'object' && value !== null
        ? `{${capabilitiesKey(value)}}`
        : String(value)

interface Declared<F> {
    fields: F
    isDefault: boolean
}

// Shared by both tables: `group` is where the default is unique, `key` is
// the row identity, `diff` lists the declared fields a row disagrees on.
const planTable = <Row extends { id: string; isDefault: boolean }, F>(args: {
    label: string
    current: readonly Row[]
    desired: readonly { key: string; group: string; declared: Declared<F> }[]
    rowKey: (row: Row) => string
    rowGroup: (row: Row) => string
    diff: (row: Row, fields: F) => Partial<F>
}): {
    clear: string[]
    inserts: string[]
    updates: { id: string; set: Record<string, unknown> }[]
    changes: string[]
} => {
    const byKey = new Map(args.current.map((row) => [args.rowKey(row), row]))
    const desiredByKey = new Map(
        args.desired.map((entry) => [entry.key, entry])
    )
    const declaredDefault = new Map<string, string>()
    for (const entry of args.desired)
        if (entry.declared.isDefault)
            declaredDefault.set(entry.group, entry.key)

    const clear: string[] = []
    const changes: string[] = []
    for (const row of args.current) {
        if (!row.isDefault) continue
        const key = args.rowKey(row)
        const holder = declaredDefault.get(args.rowGroup(row))
        const declared = desiredByKey.get(key)
        const loses =
            (holder !== undefined && holder !== key) ||
            (declared !== undefined &&
                (!declared.declared.isDefault ||
                    declared.group !== args.rowGroup(row)))
        if (loses) {
            clear.push(row.id)
            changes.push(`~ ${args.label} ${key}: isDefault true → false`)
        }
    }

    const inserts: string[] = []
    const updates: { id: string; set: Record<string, unknown> }[] = []
    // Positions shift for every row after an insert, so one line counts them.
    let resorted = 0
    for (const entry of args.desired) {
        const row = byKey.get(entry.key)
        if (!row) {
            inserts.push(entry.key)
            changes.push(`+ ${args.label} ${entry.key}`)
            continue
        }
        const set: Record<string, unknown> = {
            ...args.diff(row, entry.declared.fields)
        }
        const effectiveDefault = clear.includes(row.id) ? false : row.isDefault
        if (effectiveDefault !== entry.declared.isDefault)
            set.isDefault = entry.declared.isDefault
        const fields = Object.keys(set)
        if (fields.length === 0) continue
        updates.push({ id: row.id, set })
        for (const field of fields) {
            if (field === 'sortOrder') {
                resorted++
                continue
            }
            const from =
                field === 'isDefault'
                    ? effectiveDefault
                    : (row as unknown as Record<string, unknown>)[field]
            const to = set[field]
            changes.push(
                `~ ${args.label} ${entry.key}: ${field} ${describe(from)} → ${describe(to)}`
            )
        }
    }
    if (resorted > 0)
        changes.push(`~ ${args.label} order: ${resorted} row(s) moved`)
    return { clear, inserts, updates, changes }
}

// What it takes to make the database hold `desired`. Rows the catalog file
// does not list — an admin's own additions — are left exactly as they are.
export const planFrameworkCatalogSync = (
    current: {
        models: readonly FrameworkModelCatalogRow[]
        enums: readonly FrameworkEnumCatalogRow[]
    },
    desired: FrameworkModelCatalogRows
): FrameworkCatalogSyncPlan => {
    const modelKey = (framework: string, key: string): string =>
        groupKey(framework, key)
    const enumKey = (framework: string, enumName: string, value: string) =>
        groupKey(framework, enumName, value)

    const models = planTable<
        FrameworkModelCatalogRow,
        Omit<ModelFields, 'isDefault'>
    >({
        label: 'model',
        current: current.models,
        desired: desired.models.map((row) => ({
            key: modelKey(row.framework, row.modelKey),
            group: groupKey(row.framework, row.kind),
            declared: {
                isDefault: row.isDefault,
                fields: {
                    kind: row.kind,
                    displayName: row.displayName,
                    capabilities: row.capabilities,
                    sortOrder: row.sortOrder,
                    isActive: row.isActive
                }
            }
        })),
        rowKey: (row) => modelKey(row.framework, row.modelKey),
        rowGroup: (row) => groupKey(row.framework, row.kind),
        diff: (row, fields) => {
            const set: Partial<typeof fields> = {}
            if (row.kind !== fields.kind) set.kind = fields.kind
            if (row.displayName !== fields.displayName)
                set.displayName = fields.displayName
            if (
                capabilitiesKey(row.capabilities) !==
                capabilitiesKey(fields.capabilities)
            )
                set.capabilities = fields.capabilities
            if (row.sortOrder !== fields.sortOrder)
                set.sortOrder = fields.sortOrder
            if (row.isActive !== fields.isActive) set.isActive = fields.isActive
            return set
        }
    })

    const enums = planTable<
        FrameworkEnumCatalogRow,
        Omit<EnumFields, 'isDefault'>
    >({
        label: 'enum',
        current: current.enums,
        desired: desired.enums.map((row) => ({
            key: enumKey(row.framework, row.enumKey, row.value),
            group: groupKey(row.framework, row.enumKey),
            declared: {
                isDefault: row.isDefault,
                fields: {
                    displayName: row.displayName,
                    sortOrder: row.sortOrder,
                    isActive: row.isActive
                }
            }
        })),
        rowKey: (row) => enumKey(row.framework, row.enumKey, row.value),
        rowGroup: (row) => groupKey(row.framework, row.enumKey),
        diff: (row, fields) => {
            const set: Partial<typeof fields> = {}
            if (row.displayName !== fields.displayName)
                set.displayName = fields.displayName
            if (row.sortOrder !== fields.sortOrder)
                set.sortOrder = fields.sortOrder
            if (row.isActive !== fields.isActive) set.isActive = fields.isActive
            return set
        }
    })

    const insertModelKeys = new Set(models.inserts)
    const insertEnumKeys = new Set(enums.inserts)
    return {
        clearModelDefaults: models.clear,
        clearEnumDefaults: enums.clear,
        insertModels: desired.models.filter((row) =>
            insertModelKeys.has(modelKey(row.framework, row.modelKey))
        ),
        insertEnums: desired.enums.filter((row) =>
            insertEnumKeys.has(enumKey(row.framework, row.enumKey, row.value))
        ),
        updateModels: models.updates as RowUpdate<ModelFields>[],
        updateEnums: enums.updates as RowUpdate<EnumFields>[],
        changes: [...models.changes, ...enums.changes]
    }
}

export const isEmptyFrameworkCatalogSyncPlan = (
    plan: FrameworkCatalogSyncPlan
): boolean => plan.changes.length === 0

export const readFrameworkCatalogRows = async (
    db: Pick<Database, 'select'>
): Promise<{
    models: FrameworkModelCatalogRow[]
    enums: FrameworkEnumCatalogRow[]
}> => ({
    models: await db.select().from(frameworkModelCatalog),
    enums: await db.select().from(frameworkEnumCatalog)
})

// Reads the database, plans, and applies the plan in one transaction unless
// `dryRun`. Returns the plan either way.
export const syncFrameworkCatalog = async (
    db: Database,
    desired: FrameworkModelCatalogRows,
    opts: { dryRun?: boolean } = {}
): Promise<FrameworkCatalogSyncPlan> => {
    const plan = planFrameworkCatalogSync(
        await readFrameworkCatalogRows(db),
        desired
    )
    if (opts.dryRun || isEmptyFrameworkCatalogSyncPlan(plan)) return plan
    const now = new Date()
    await db.transaction(async (tx) => {
        if (plan.clearModelDefaults.length > 0)
            await tx
                .update(frameworkModelCatalog)
                .set({ isDefault: false, updatedAt: now })
                .where(
                    inArray(frameworkModelCatalog.id, plan.clearModelDefaults)
                )
        if (plan.clearEnumDefaults.length > 0)
            await tx
                .update(frameworkEnumCatalog)
                .set({ isDefault: false, updatedAt: now })
                .where(inArray(frameworkEnumCatalog.id, plan.clearEnumDefaults))
        for (const row of plan.insertModels)
            await tx.insert(frameworkModelCatalog).values({
                id: createObjectId('frameworkModelCatalogEntry'),
                ...row
            })
        for (const row of plan.insertEnums)
            await tx.insert(frameworkEnumCatalog).values({
                id: createObjectId('frameworkEnumCatalogEntry'),
                ...row
            })
        for (const { id, set } of plan.updateModels)
            await tx
                .update(frameworkModelCatalog)
                .set({ ...set, updatedAt: now })
                .where(eq(frameworkModelCatalog.id, id))
        for (const { id, set } of plan.updateEnums)
            await tx
                .update(frameworkEnumCatalog)
                .set({ ...set, updatedAt: now })
                .where(eq(frameworkEnumCatalog.id, id))
    })
    return plan
}
