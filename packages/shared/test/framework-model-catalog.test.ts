import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
    loadFrameworkModelCatalogSource,
    renderFrameworkModelCatalogModule
} from '../scripts/generate-framework-model-catalog'
import {
    frameworkModelCatalogRows,
    parseFrameworkModelCatalog
} from '../src/framework-model-catalog'
import { builtInFrameworkModelCatalog } from '../src/framework-model-catalog.generated'
import {
    claudeCodeModelAliasMapKey,
    claudeCodeModelAliases,
    geminiAutoModelKey
} from '../src/model-config'

test('the generated catalog module matches framework-model-catalog.yaml', () => {
    const committed = readFileSync(
        join(__dirname, '../src/framework-model-catalog.generated.ts'),
        'utf8'
    )
    assert.equal(
        committed,
        renderFrameworkModelCatalogModule(loadFrameworkModelCatalogSource()),
        'run `pnpm --filter @manyfold/shared catalog:generate` and commit the result'
    )
})

test('every Claude Code alias of the catalog belongs to a model-map family', () => {
    for (const alias of claudeCodeModelAliases)
        assert.ok(
            alias.startsWith(claudeCodeModelAliasMapKey(alias)),
            `${alias} has no family in claudeCodeModelMapAliases`
        )
})

test('the Gemini CLI catalog keeps the auto router alias the code reads', () => {
    const auto = builtInFrameworkModelCatalog['gemini-cli'].models.find(
        (model) => model.key === geminiAutoModelKey
    )
    assert.equal(auto?.kind, 'alias')
    assert.equal(auto?.active, true)
})

test('catalog rows take their order from the file and keep only the flags that are on', () => {
    const rows = frameworkModelCatalogRows(
        parseFrameworkModelCatalog({
            'gemini-cli': {
                aliases: [{ key: 'auto', name: 'Auto', default: true }],
                models: [
                    { key: 'b', name: 'B', longContext: true },
                    { key: 'a', name: 'A', active: false }
                ]
            },
            codex: {
                enums: {
                    speed: [
                        { value: 'standard', name: 'Standard', default: true },
                        { value: 'fast', name: 'Fast' }
                    ]
                }
            }
        })
    )
    assert.deepEqual(
        rows.models.map((row) => [row.modelKey, row.kind, row.sortOrder]),
        [
            ['auto', 'alias', 10],
            ['b', 'model', 20],
            ['a', 'model', 30]
        ]
    )
    assert.deepEqual(rows.models[1].capabilities, { longContext: true })
    assert.deepEqual(rows.models[2].capabilities, {})
    assert.equal(rows.models[2].isActive, false)
    assert.deepEqual(
        rows.enums.map((row) => [row.value, row.sortOrder, row.isDefault]),
        [
            ['standard', 10, true],
            ['fast', 20, false]
        ]
    )
})

const rejects = (document: unknown, message: RegExp): void =>
    assert.throws(() => parseFrameworkModelCatalog(document), message)

test('the catalog parser names the first problem it finds', () => {
    rejects({ claude: {} }, /unknown framework 'claude'/)
    rejects(
        { codex: { models: [{ key: 'x', name: 'X', defualt: true }] } },
        /codex\.models\[0\]: unknown field 'defualt'/
    )
    rejects(
        {
            codex: {
                models: [
                    { key: 'x', name: 'X' },
                    { key: 'x', name: 'X again' }
                ]
            }
        },
        /'x' is listed twice/
    )
    rejects(
        {
            codex: {
                models: [
                    { key: 'x', name: 'X', default: true },
                    { key: 'y', name: 'Y', default: true }
                ]
            }
        },
        /codex\.models: more than one entry is the default/
    )
    rejects(
        {
            codex: {
                models: [{ key: 'x', name: 'X', default: true, active: false }]
            }
        },
        /the default entry must be active/
    )
    rejects(
        {
            codex: {
                enums: { intelligence: [{ value: 'low', name: 'Low' }] },
                models: [{ key: 'x', name: 'X', intelligence: ['low', 'max'] }]
            }
        },
        /codex\.models\[0\]\.intelligence: 'max' is not an active intelligence value/
    )
    rejects(
        {
            'gemini-cli': {
                models: [{ key: 'x', name: 'X', intelligence: ['low'] }]
            }
        },
        /only Codex models carry intelligence/
    )
    rejects(
        {
            codex: {
                configDefault: 'y',
                models: [{ key: 'y', name: 'Y', active: false }]
            }
        },
        /codex\.configDefault: 'y' is not an active model/
    )
    rejects(
        { codex: { models: [{ key: 'x', name: '' }] } },
        /codex\.models\[0\]\.name: expected a non-empty string/
    )
})

test('the generator refuses a catalog the code cannot derive its defaults from', () => {
    assert.throws(
        () =>
            loadFrameworkModelCatalogSource(
                readFileSync(
                    join(__dirname, '../src/framework-model-catalog.yaml'),
                    'utf8'
                ).replace('configDefault: gpt-5.6-sol', '')
            ),
        /codex\.configDefault: required/
    )
})
