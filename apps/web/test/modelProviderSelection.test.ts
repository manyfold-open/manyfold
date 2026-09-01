import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserModelProviderSummary } from '@manyfold/shared'
import {
    providerSelectionFor,
    selectionFromParam,
    selectionToParam,
    selectionsEqual
} from '../src/pages/Settings/modelProviderSelection'

const provider = (
    overrides: Partial<UserModelProviderSummary> = {}
): UserModelProviderSummary =>
    ({
        id: 'ump_1',
        providerName: 'personal',
        source: 'byo',
        ...overrides
    }) as UserModelProviderSummary

const items = [provider(), provider({ id: 'ump_2', providerName: 'team' })]

// Seen on a self-hosted build [2026-09-01]: selecting a provider and then
// clicking the rail title routed to /settings/model-providers/dashboard while
// the pane kept rendering the provider, because the selection sync bailed out
// on the dashboard instead of clearing.
test('the dashboard segment resolves to no selection', () => {
    assert.equal(
        providerSelectionFor({
            onDashboard: true,
            param: null,
            items,
            hasManaged: false
        }),
        null
    )
})

test('the dashboard segment outranks a lingering selected param', () => {
    for (const param of ['ump_1', 'managed', 'custom-new', 'builtin:openai']) {
        assert.equal(
            providerSelectionFor({
                onDashboard: true,
                param,
                items,
                hasManaged: true
            }),
            null,
            param
        )
    }
})

test('off the dashboard the param still picks the provider', () => {
    assert.deepEqual(
        providerSelectionFor({
            onDashboard: false,
            param: 'ump_2',
            items,
            hasManaged: false
        }),
        { kind: 'configured', id: 'ump_2' }
    )
    assert.deepEqual(
        providerSelectionFor({
            onDashboard: false,
            param: 'custom-new',
            items,
            hasManaged: false
        }),
        { kind: 'custom-new' }
    )
    // A bare URL shows the dashboard rather than opening whichever provider
    // happens to sort first.
    assert.equal(
        providerSelectionFor({
            onDashboard: false,
            param: null,
            items,
            hasManaged: false
        }),
        null
    )
})

test('an unresolvable param selects nothing', () => {
    assert.equal(selectionFromParam('ump_gone', items, false), null)
    assert.equal(selectionFromParam('managed', items, false), null)
    assert.equal(selectionFromParam('builtin:nope', items, false), null)
    assert.deepEqual(selectionFromParam('managed', items, true), {
        kind: 'managed'
    })
})

test('a selection round-trips through its param', () => {
    for (const selection of [
        { kind: 'configured', id: 'ump_2' },
        { kind: 'managed' },
        { kind: 'custom-new' }
    ] as const) {
        const param = selectionToParam(selection)
        assert.ok(
            selectionsEqual(selectionFromParam(param, items, true), selection),
            param
        )
    }
})
