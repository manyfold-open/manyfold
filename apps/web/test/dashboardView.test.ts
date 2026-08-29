import test from 'node:test'
import assert from 'node:assert/strict'
import {
    CHANNELS_DASHBOARD_VIEW_KEY,
    MODEL_PROVIDERS_DASHBOARD_VIEW_KEY,
    RUNTIMES_DASHBOARD_VIEW_KEY,
    normalizeDashboardView
} from '../src/lib/dashboardView'

test('normalizeDashboardView keeps valid views', () => {
    assert.equal(normalizeDashboardView('grid'), 'grid')
    assert.equal(normalizeDashboardView('list'), 'list')
})

test('normalizeDashboardView falls back to grid on anything else', () => {
    assert.equal(normalizeDashboardView(null), 'grid')
    assert.equal(normalizeDashboardView(undefined), 'grid')
    assert.equal(normalizeDashboardView(''), 'grid')
    assert.equal(normalizeDashboardView('table'), 'grid')
    assert.equal(normalizeDashboardView(42), 'grid')
    assert.equal(normalizeDashboardView({ view: 'list' }), 'grid')
})

test('each dashboard owns a distinct storage key', () => {
    const keys = [
        RUNTIMES_DASHBOARD_VIEW_KEY,
        MODEL_PROVIDERS_DASHBOARD_VIEW_KEY,
        CHANNELS_DASHBOARD_VIEW_KEY
    ]
    assert.equal(new Set(keys).size, keys.length)
    // The runtimes key predates the split and must not move: bumping it would
    // silently reset every existing reader's choice.
    assert.equal(RUNTIMES_DASHBOARD_VIEW_KEY, 'mf.runtimes.dashboardView.v1')
})
