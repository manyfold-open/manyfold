import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDashboardView } from '../src/lib/runtimesDashboardView'

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
