import test from 'node:test'
import assert from 'node:assert/strict'
import {
    UPDATE_KINDS,
    frameworkCatalogVersions,
    isRunnableUpdate,
    kindParamOf,
    parseKindParam,
    planBatch,
    type UpdateRow
} from '../src/update-center'
import type { FrameworkVersionCatalogEntry } from '../src/framework-versions'

const row = (over: Partial<UpdateRow> = {}): UpdateRow => ({
    id: 'cli:sandbox:sbx_1',
    kind: 'cli',
    subjectLabel: 'mf CLI',
    framework: null,
    targetKind: 'sandbox',
    targetKey: 'host:sbx_1',
    targetLabel: 'sandbox-001',
    installedVersion: '5.7.0',
    latestVersion: '5.8.0',
    targetChoices: [],
    severity: 'recommended',
    blockedReason: null,
    blocker: null,
    exec: { type: 'sandboxCli', hostId: 'sbx_1', targetVersion: null },
    ...over
})

const catalog = (
    over: Partial<FrameworkVersionCatalogEntry>
): FrameworkVersionCatalogEntry => ({
    framework: 'claude-code',
    latest: null,
    versions: [],
    source: 'npm',
    sourceRepo: null,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    blocked: [],
    ...over
})

test('every update kind has a parameter spelling that reads back as itself', () => {
    for (const kind of UPDATE_KINDS)
        assert.equal(parseKindParam(kindParamOf(kind)), kind)
    assert.equal(kindParamOf('cliUsage'), 'cli-usage')
    assert.equal(parseKindParam('cliUsage'), null)
    assert.equal(parseKindParam(null), null)
})

test('a row runs from here unless something blocks it or it is still installing', () => {
    assert.equal(isRunnableUpdate(row()), true)
    assert.equal(isRunnableUpdate(row({ blocker: 'manual' })), false)
    assert.equal(isRunnableUpdate(row({ blocker: 'offline' })), false)
    assert.equal(
        isRunnableUpdate(
            row({ materialization: { status: 'installing', error: null } })
        ),
        false
    )
    assert.equal(
        isRunnableUpdate(
            row({ materialization: { status: 'failed', error: 'timed out' } })
        ),
        true
    )
})

test('a batch leaves out exactly the rows that cannot run from here', () => {
    const steps = planBatch([
        row(),
        row({ id: 'cli:sandbox:sbx_2', blocker: 'offline' }),
        row({
            id: 'cli:sandbox:sbx_3',
            materialization: { status: 'installing', error: null }
        })
    ])
    assert.deepEqual(
        steps.map((step) => ('rowId' in step ? step.rowId : step.rowIds)),
        ['cli:sandbox:sbx_1']
    )
})

test('the catalog versions fold a latest the list does not carry into its place', () => {
    assert.deepEqual(
        frameworkCatalogVersions(
            catalog({ latest: '2.1.260', versions: ['2.1.259', '2.1.250'] })
        ),
        ['2.1.260', '2.1.259', '2.1.250']
    )
    assert.deepEqual(
        frameworkCatalogVersions(
            catalog({ latest: '2.1.259', versions: ['2.1.259', '2.1.250'] })
        ),
        ['2.1.259', '2.1.250']
    )
    assert.deepEqual(
        frameworkCatalogVersions(catalog({ versions: ['1.0.0'] })),
        ['1.0.0']
    )
})
