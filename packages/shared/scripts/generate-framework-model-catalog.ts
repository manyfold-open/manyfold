import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { configurableFrameworks } from '../src/framework-catalog'
import {
    parseFrameworkModelCatalog,
    type FrameworkModelCatalog
} from '../src/framework-model-catalog'

const SOURCE = join(__dirname, '../src/framework-model-catalog.yaml')
const TARGET = join(__dirname, '../src/framework-model-catalog.generated.ts')

// model-config.ts derives its lists and defaults from the generated catalog, so
// the file it is generated from has to carry every one of them.
export const loadFrameworkModelCatalogSource = (
    source: string = readFileSync(SOURCE, 'utf8')
): FrameworkModelCatalog => {
    const catalog = parseFrameworkModelCatalog(parse(source))
    for (const framework of configurableFrameworks)
        if (!catalog[framework])
            throw new Error(`catalog: '${framework}' is missing`)
    if (!catalog.codex?.configDefault)
        throw new Error('codex.configDefault: required')
    const requiredDefaults = [
        ['codex', 'speed'],
        ['codex', 'intelligence'],
        ['claude-code', 'effort']
    ] as const
    for (const [framework, enumKey] of requiredDefaults)
        if (!catalog[framework]?.enums[enumKey]?.some((v) => v.isDefault))
            throw new Error(
                `${framework}.enums.${enumKey}: a default is required`
            )
    return catalog
}

const INDENT = '    '
// The repository's .prettierrc keeps prettier's default print width.
const PRINT_WIDTH = 80
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const quote = (value: string): string =>
    `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// Prints `value` the way prettier would, given that `prefix` characters of the
// current line precede it: a list of strings stays on one line while it fits.
const render = (value: unknown, depth: number, prefix: number): string => {
    if (value === null) return 'null'
    if (typeof value === 'string') return quote(value)
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value)
    const inner = INDENT.repeat(depth + 1)
    const outer = INDENT.repeat(depth)
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]'
        if (value.every((item) => typeof item === 'string')) {
            const inline = `[${value.map((item) => quote(item)).join(', ')}]`
            // +1 leaves room for the comma after the entry
            if (prefix + inline.length + 1 <= PRINT_WIDTH) return inline
        }
        return `[\n${value
            .map((item) => inner + render(item, depth + 1, inner.length))
            .join(',\n')}\n${outer}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return `{\n${entries
        .map(([key, item]) => {
            const head = `${inner}${IDENTIFIER.test(key) ? key : quote(key)}: `
            return head + render(item, depth + 1, head.length)
        })
        .join(',\n')}\n${outer}}`
}

export const renderFrameworkModelCatalogModule = (
    catalog: FrameworkModelCatalog
): string =>
    [
        '// Generated from framework-model-catalog.yaml by',
        '// `pnpm --filter @manyfold/shared catalog:generate`. Do not edit.',
        "import type { FrameworkModelCatalog } from './framework-model-catalog'",
        '',
        `export const builtInFrameworkModelCatalog = ${render(catalog, 0, 0)} as const satisfies FrameworkModelCatalog`,
        ''
    ].join('\n')

if (require.main === module) {
    writeFileSync(
        TARGET,
        renderFrameworkModelCatalogModule(loadFrameworkModelCatalogSource())
    )
    console.log(`wrote ${TARGET}`)
}
