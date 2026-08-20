import assert from 'node:assert/strict'
import test from 'node:test'
import { grantableScopes, type GrantableScope } from '@manyfold/shared'
import { requestedScopeMetadata } from '../src/components/auth/ScopeChecklist'

test('requestedScopeMetadata returns only requested scopes in catalog order', () => {
    const requested: GrantableScope[] = [
        'channels:edit',
        'agents:read',
        'channels:read'
    ]
    const meta = requestedScopeMetadata(requested)
    const ids = meta.map((m) => m.scope)
    // catalog order: agents:read appears before channels:read which appears before channels:edit
    assert.deepEqual(ids, ['agents:read', 'channels:read', 'channels:edit'])
    assert.equal(meta.length, 3)
})

test('requestedScopeMetadata ignores scopes not in catalog', () => {
    const meta = requestedScopeMetadata([
        'channels:read',
        'nonsense:read' as GrantableScope
    ])
    assert.deepEqual(
        meta.map((m) => m.scope),
        ['channels:read']
    )
})

test('every grantable scope has metadata', () => {
    for (const scope of grantableScopes) {
        const meta = requestedScopeMetadata([scope])
        assert.equal(
            meta.length,
            1,
            `scope ${scope} should have metadata in scopeMetadata`
        )
    }
})
