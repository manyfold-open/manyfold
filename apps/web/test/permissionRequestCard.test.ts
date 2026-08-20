import assert from 'node:assert/strict'
import test from 'node:test'
import type { PermissionConsentPreview } from '@manyfold/shared'
import { stateFromPreview } from '../src/components/chat/utils/permissionCardState'

const preview = (
    patch: Partial<PermissionConsentPreview> = {}
): PermissionConsentPreview => ({
    agentId: 'agt_A',
    agentName: 'Agent A',
    scopes: [{ scope: 'a2a:read', summary: 'Read A2A', danger: 'low' }],
    expiresAt: '2026-08-11T12:00:00.000Z',
    status: 'pending',
    approvedScopes: [],
    resolvedAt: null,
    ...patch
})

test('a pending request keeps the review/deny buttons', () => {
    const state = stateFromPreview(preview())
    assert.equal(state.kind, 'pending')
})

// The card is rebuilt from chat history on every later turn, so an approval it
// never witnessed still has to render as approved rather than re-offering.
test('an approved request renders the grant, not the buttons', () => {
    const state = stateFromPreview(
        preview({
            status: 'approved',
            approvedScopes: ['a2a:read'],
            resolvedAt: '2026-08-11T11:05:00.000Z'
        })
    )
    assert.deepEqual(state, {
        kind: 'approved',
        agentName: 'Agent A',
        count: 1
    })
})

test('the approved count follows what was actually granted, not requested', () => {
    const state = stateFromPreview(
        preview({
            scopes: [
                { scope: 'a2a:read', summary: 'Read A2A', danger: 'low' },
                { scope: 'files:edit', summary: 'Edit files', danger: 'high' }
            ],
            status: 'approved',
            approvedScopes: ['a2a:read'],
            resolvedAt: '2026-08-11T11:05:00.000Z'
        })
    )
    assert.equal(state.kind === 'approved' && state.count, 1)
})

test('a denied request renders the refusal', () => {
    const state = stateFromPreview(
        preview({ status: 'denied', resolvedAt: '2026-08-11T11:05:00.000Z' })
    )
    assert.equal(state.kind, 'denied')
})
