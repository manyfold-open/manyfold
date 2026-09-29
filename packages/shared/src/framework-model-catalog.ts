import {
    configurableFrameworks,
    frameworkEnumKeys,
    isConfigurableFramework,
    type ConfigurableFramework,
    type FrameworkEnumKey,
    type FrameworkModelCapabilitiesView,
    type FrameworkModelKind
} from './framework-catalog'

// The model catalog file (framework-model-catalog.yaml) after validation.
// `models` holds a framework's aliases first, then its models, each in file
// order; that order is the catalog's display order.
export interface FrameworkModelCatalogModel {
    key: string
    kind: FrameworkModelKind
    name: string
    fast: boolean
    longContext: boolean
    isDefault: boolean
    active: boolean
    // Codex only. null = the levels every Codex model supports.
    intelligence: readonly string[] | null
}

export interface FrameworkModelCatalogEnumValue {
    value: string
    name: string
    isDefault: boolean
    active: boolean
}

export interface FrameworkModelCatalogFramework {
    configDefault: string | null
    models: readonly FrameworkModelCatalogModel[]
    enums: Partial<
        Record<FrameworkEnumKey, readonly FrameworkModelCatalogEnumValue[]>
    >
    localModels: readonly string[]
}

export type FrameworkModelCatalog = Partial<
    Record<ConfigurableFramework, FrameworkModelCatalogFramework>
>

// The rows the database holds for a catalog: what the release step writes and
// `framework-catalog export` reads back.
export interface FrameworkModelCatalogRowSpec {
    framework: ConfigurableFramework
    modelKey: string
    kind: FrameworkModelKind
    displayName: string
    capabilities: FrameworkModelCapabilitiesView
    sortOrder: number
    isActive: boolean
    isDefault: boolean
}

export interface FrameworkEnumCatalogRowSpec {
    framework: ConfigurableFramework
    enumKey: FrameworkEnumKey
    value: string
    displayName: string
    sortOrder: number
    isActive: boolean
    isDefault: boolean
}

export interface FrameworkModelCatalogRows {
    models: FrameworkModelCatalogRowSpec[]
    enums: FrameworkEnumCatalogRowSpec[]
}

const frameworkKeys = [
    'configDefault',
    'aliases',
    'models',
    'localModels',
    'enums'
] as const
const modelKeys = [
    'key',
    'name',
    'fast',
    'longContext',
    'default',
    'active',
    'intelligence'
] as const
const enumValueKeys = ['value', 'name', 'default', 'active'] as const

type Json = Record<string, unknown>

const fail = (path: string, message: string): never => {
    throw new Error(`${path}: ${message}`)
}

const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown, path: string): Json =>
    isRecord(value) ? value : fail(path, 'expected a mapping')

const onlyKeys = (
    value: Json,
    allowed: readonly string[],
    path: string
): void => {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            fail(
                path,
                `unknown field '${key}' (expected ${allowed.join(', ')})`
            )
}

const text = (value: unknown, path: string): string =>
    typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : fail(path, 'expected a non-empty string')

const flag = (value: unknown, path: string): boolean => {
    if (value === undefined) return false
    return typeof value === 'boolean'
        ? value
        : fail(path, 'expected true or false')
}

const list = (value: unknown, path: string): unknown[] =>
    Array.isArray(value) ? value : fail(path, 'expected a list')

const uniqueTexts = (value: unknown, path: string): string[] => {
    const out: string[] = []
    list(value, path).forEach((item, index) => {
        const entry = text(item, `${path}[${index}]`)
        if (out.includes(entry))
            fail(`${path}[${index}]`, `'${entry}' is listed twice`)
        out.push(entry)
    })
    return out
}

// `levels` is null where a model may not carry intelligence at all, else the
// framework's active intelligence values (empty when it declares none).
const parseModels = (
    raw: unknown,
    kind: FrameworkModelKind,
    path: string,
    levels: readonly string[] | null
): FrameworkModelCatalogModel[] =>
    list(raw, path).map((item, index) => {
        const at = `${path}[${index}]`
        const entry = record(item, at)
        onlyKeys(entry, modelKeys, at)
        let intelligence: string[] | null = null
        if (entry.intelligence !== undefined) {
            if (!levels)
                fail(
                    `${at}.intelligence`,
                    'only Codex models carry intelligence'
                )
            intelligence = uniqueTexts(entry.intelligence, `${at}.intelligence`)
            for (const level of intelligence)
                if (!levels?.includes(level))
                    fail(
                        `${at}.intelligence`,
                        `'${level}' is not an active intelligence value`
                    )
        }
        return {
            key: text(entry.key, `${at}.key`),
            kind,
            name: text(entry.name, `${at}.name`),
            fast: flag(entry.fast, `${at}.fast`),
            longContext: flag(entry.longContext, `${at}.longContext`),
            isDefault: flag(entry.default, `${at}.default`),
            active:
                entry.active === undefined
                    ? true
                    : flag(entry.active, `${at}.active`),
            intelligence
        }
    })

const parseEnumValues = (
    raw: unknown,
    path: string
): FrameworkModelCatalogEnumValue[] => {
    const values = list(raw, path).map((item, index) => {
        const at = `${path}[${index}]`
        const entry = record(item, at)
        onlyKeys(entry, enumValueKeys, at)
        return {
            value: text(entry.value, `${at}.value`),
            name: text(entry.name, `${at}.name`),
            isDefault: flag(entry.default, `${at}.default`),
            active:
                entry.active === undefined
                    ? true
                    : flag(entry.active, `${at}.active`)
        }
    })
    values.forEach((entry, index) => {
        if (values.findIndex((other) => other.value === entry.value) !== index)
            fail(`${path}[${index}]`, `'${entry.value}' is listed twice`)
    })
    assertOneActiveDefault(values, path)
    return values
}

const assertOneActiveDefault = (
    entries: readonly { isDefault: boolean; active: boolean }[],
    path: string
): void => {
    const defaults = entries.filter((entry) => entry.isDefault)
    if (defaults.length > 1) fail(path, 'more than one entry is the default')
    if (defaults.some((entry) => !entry.active))
        fail(path, 'the default entry must be active')
}

const parseFramework = (
    framework: ConfigurableFramework,
    raw: unknown
): FrameworkModelCatalogFramework => {
    const entry = record(raw, framework)
    onlyKeys(entry, frameworkKeys, framework)

    const enums: FrameworkModelCatalogFramework['enums'] = {}
    if (entry.enums !== undefined) {
        const rawEnums = record(entry.enums, `${framework}.enums`)
        onlyKeys(rawEnums, frameworkEnumKeys, `${framework}.enums`)
        for (const key of frameworkEnumKeys)
            if (rawEnums[key] !== undefined)
                enums[key] = parseEnumValues(
                    rawEnums[key],
                    `${framework}.enums.${key}`
                )
    }

    const levels =
        framework === 'codex'
            ? (enums.intelligence ?? [])
                  .filter((level) => level.active)
                  .map((level) => level.value)
            : null
    const models = [
        ...(entry.aliases === undefined
            ? []
            : parseModels(
                  entry.aliases,
                  'alias',
                  `${framework}.aliases`,
                  null
              )),
        ...(entry.models === undefined
            ? []
            : parseModels(entry.models, 'model', `${framework}.models`, levels))
    ]
    models.forEach((model, index) => {
        if (models.findIndex((other) => other.key === model.key) !== index)
            fail(framework, `'${model.key}' is listed twice`)
    })
    assertOneActiveDefault(
        models.filter((model) => model.kind === 'alias'),
        `${framework}.aliases`
    )
    assertOneActiveDefault(
        models.filter((model) => model.kind === 'model'),
        `${framework}.models`
    )

    let configDefault: string | null = null
    if (entry.configDefault !== undefined) {
        if (framework !== 'codex')
            fail(`${framework}.configDefault`, 'only Codex has one')
        configDefault = text(entry.configDefault, `${framework}.configDefault`)
        const target = models.find((model) => model.key === configDefault)
        if (!target || target.kind !== 'model' || !target.active)
            fail(
                `${framework}.configDefault`,
                `'${configDefault}' is not an active model of this catalog`
            )
    }

    return {
        configDefault,
        models,
        enums,
        localModels:
            entry.localModels === undefined
                ? []
                : uniqueTexts(entry.localModels, `${framework}.localModels`)
    }
}

// Validates a parsed catalog document. Throws with the path of the first
// problem; a framework the document leaves out is simply absent.
export const parseFrameworkModelCatalog = (
    raw: unknown
): FrameworkModelCatalog => {
    const document = record(raw, 'catalog')
    for (const key of Object.keys(document))
        if (!isConfigurableFramework(key))
            fail(
                'catalog',
                `unknown framework '${key}' (expected ${configurableFrameworks.join(', ')})`
            )
    const catalog: FrameworkModelCatalog = {}
    for (const framework of configurableFrameworks)
        if (document[framework] !== undefined)
            catalog[framework] = parseFramework(framework, document[framework])
    return catalog
}

const sortOrderAt = (index: number): number => (index + 1) * 10

export const frameworkModelCatalogRows = (
    catalog: FrameworkModelCatalog
): FrameworkModelCatalogRows => {
    const rows: FrameworkModelCatalogRows = { models: [], enums: [] }
    for (const framework of configurableFrameworks) {
        const entry = catalog[framework]
        if (!entry) continue
        entry.models.forEach((model, index) =>
            rows.models.push({
                framework,
                modelKey: model.key,
                kind: model.kind,
                displayName: model.name,
                capabilities: {
                    ...(model.fast ? { fast: true } : {}),
                    ...(model.longContext ? { longContext: true } : {})
                },
                sortOrder: sortOrderAt(index),
                isActive: model.active,
                isDefault: model.isDefault
            })
        )
        for (const enumKey of frameworkEnumKeys)
            entry.enums[enumKey]?.forEach((value, index) =>
                rows.enums.push({
                    framework,
                    enumKey,
                    value: value.value,
                    displayName: value.name,
                    sortOrder: sortOrderAt(index),
                    isActive: value.active,
                    isDefault: value.isDefault
                })
            )
    }
    return rows
}
