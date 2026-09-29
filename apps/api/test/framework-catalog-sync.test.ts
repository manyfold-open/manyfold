import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    FrameworkEnumCatalogRow,
    FrameworkModelCatalogRow
} from '@manyfold/db'
import {
    frameworkModelCatalogRows,
    parseFrameworkModelCatalog,
    type FrameworkModelCatalogRows
} from '@manyfold/shared'
import {
    catalogDocumentFromRows,
    planFrameworkCatalogSync
} from '../src/modules/framework-catalog/framework-catalog-sync'

const at = new Date('2026-09-29T00:00:00.000Z')

const modelRow = (
    patch: Partial<FrameworkModelCatalogRow> &
        Pick<FrameworkModelCatalogRow, 'id' | 'modelKey'>
): FrameworkModelCatalogRow => ({
    framework: 'codex',
    kind: 'model',
    displayName: patch.modelKey,
    capabilities: {},
    sortOrder: 10,
    isActive: true,
    isDefault: false,
    createdAt: at,
    updatedAt: at,
    ...patch
})

const enumRow = (
    patch: Partial<FrameworkEnumCatalogRow> &
        Pick<FrameworkEnumCatalogRow, 'id' | 'value'>
): FrameworkEnumCatalogRow => ({
    framework: 'codex',
    enumKey: 'speed',
    displayName: patch.value,
    sortOrder: 10,
    isActive: true,
    isDefault: false,
    createdAt: at,
    updatedAt: at,
    ...patch
})

const catalog = (document: unknown): FrameworkModelCatalogRows =>
    frameworkModelCatalogRows(parseFrameworkModelCatalog(document))

const desired = catalog({
    codex: {
        models: [
            { key: 'gpt-6-sol', name: 'GPT-6 Sol', fast: true },
            {
                key: 'gpt-5.6-sol',
                name: 'GPT-5.6 Sol',
                fast: true,
                default: true
            },
            { key: 'gpt-5.5', name: 'GPT-5.5', fast: true },
            { key: 'gpt-5.4', name: 'GPT-5.4', fast: true, active: false }
        ],
        enums: {
            speed: [
                { value: 'standard', name: 'Standard', default: true },
                { value: 'fast', name: 'Fast' }
            ]
        }
    }
})

const current = {
    models: [
        modelRow({
            id: 'fmc_seed_codex_gpt56sol',
            modelKey: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            capabilities: { fast: true },
            sortOrder: 1
        }),
        modelRow({
            id: 'fmc_seed_codex_gpt55',
            modelKey: 'gpt-5.5',
            displayName: 'GPT-5.5',
            capabilities: { fast: true },
            sortOrder: 30,
            isDefault: true
        }),
        modelRow({
            id: 'fmc_seed_codex_gpt54',
            modelKey: 'gpt-5.4',
            displayName: 'GPT-5.4',
            capabilities: { fast: true },
            sortOrder: 40
        }),
        // an admin's own row: the file does not list it
        modelRow({
            id: 'fmc_admin',
            modelKey: 'operator-model',
            displayName: 'Operator model',
            sortOrder: 5
        })
    ],
    enums: [
        enumRow({
            id: 'fec_standard',
            value: 'standard',
            displayName: 'Standard',
            isDefault: true
        }),
        enumRow({
            id: 'fec_fast',
            value: 'fast',
            displayName: 'Fast',
            sortOrder: 20
        })
    ]
}

test('the plan inserts new models, retires listed ones and moves the default', () => {
    const plan = planFrameworkCatalogSync(current, desired)

    assert.deepEqual(
        plan.insertModels.map((row) => row.modelKey),
        ['gpt-6-sol']
    )
    // the old holder lets go first: the default is unique per group
    assert.deepEqual(plan.clearModelDefaults, ['fmc_seed_codex_gpt55'])
    const updates = new Map(plan.updateModels.map((u) => [u.id, u.set]))
    assert.deepEqual(updates.get('fmc_seed_codex_gpt56sol'), {
        sortOrder: 20,
        isDefault: true
    })
    // already in place: losing the default is all that changes
    assert.equal(updates.has('fmc_seed_codex_gpt55'), false)
    assert.deepEqual(updates.get('fmc_seed_codex_gpt54'), { isActive: false })
    assert.equal(updates.has('fmc_admin'), false)
    assert.deepEqual(plan.changes, [
        '~ model codex gpt-5.5: isDefault true → false',
        '+ model codex gpt-6-sol',
        '~ model codex gpt-5.6-sol: isDefault false → true',
        '~ model codex gpt-5.4: isActive true → false',
        '~ model order: 1 row(s) moved'
    ])
    assert.equal(plan.insertEnums.length, 0)
    assert.equal(plan.updateEnums.length, 0)
})

test('a database that already holds the catalog needs no change', () => {
    const synced = {
        models: [
            ...desired.models.map((row, index) =>
                modelRow({ id: `fmc_${index}`, ...row })
            ),
            current.models[3]
        ],
        enums: desired.enums.map((row, index) =>
            enumRow({ id: `fec_${index}`, ...row })
        )
    }
    const plan = planFrameworkCatalogSync(synced, desired)
    assert.deepEqual(plan.changes, [])
    assert.equal(plan.updateModels.length, 0)
    assert.equal(plan.clearModelDefaults.length, 0)
})

test('a listed row loses a default the file does not give it, and only a listed row does', () => {
    const plan = planFrameworkCatalogSync(
        {
            models: [
                modelRow({
                    id: 'fmc_listed',
                    modelKey: 'listed',
                    isDefault: true
                }),
                modelRow({
                    id: 'fmc_admin_default',
                    modelKey: 'admin-default',
                    kind: 'alias',
                    isDefault: true
                })
            ],
            enums: []
        },
        catalog({
            codex: {
                models: [{ key: 'listed', name: 'listed' }],
                aliases: [{ key: 'other', name: 'other' }]
            }
        })
    )
    assert.deepEqual(plan.clearModelDefaults, ['fmc_listed'])
})

test('an enum default moves the same way', () => {
    const plan = planFrameworkCatalogSync(
        { models: [], enums: current.enums },
        catalog({
            codex: {
                enums: {
                    speed: [
                        { value: 'standard', name: 'Standard' },
                        { value: 'fast', name: 'Fast', default: true }
                    ]
                }
            }
        })
    )
    assert.deepEqual(plan.clearEnumDefaults, ['fec_standard'])
    assert.deepEqual(plan.updateEnums, [
        { id: 'fec_fast', set: { isDefault: true } }
    ])
})

test('an exported catalog imports back without a change', () => {
    const synced = {
        models: desired.models.map((row, index) =>
            modelRow({ id: `fmc_${index}`, ...row })
        ),
        enums: desired.enums.map((row, index) =>
            enumRow({ id: `fec_${index}`, ...row })
        )
    }
    const reimported = catalog(catalogDocumentFromRows(synced))
    assert.deepEqual(planFrameworkCatalogSync(synced, reimported).changes, [])
})
