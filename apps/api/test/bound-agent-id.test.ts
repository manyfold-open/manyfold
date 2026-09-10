import assert from 'node:assert/strict'
import test from 'node:test'
import { boundAgentIdFromUser } from '../src/modules/agents/agents.controller'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'

const principal = (over: Partial<AuthPrincipal>): AuthPrincipal =>
    ({ userId: 'user-1', ...over }) as AuthPrincipal

test('boundAgentIdFromUser returns own agent id for an agent-runtime principal', () => {
    // FIX-2: runtime tokens are self-scoped — list endpoints only see their
    // own agent, even though the token carries enforceAgentBinding=false.
    const user = principal({
        kind: 'agent-runtime',
        agentId: 'agt_A',
        runtimeTokenId: 'rtk_1'
    })
    assert.equal(boundAgentIdFromUser(user), 'agt_A')
})

test('boundAgentIdFromUser filters a retained A2A grant to its target', () => {
    const user = principal({
        kind: 'legacy-runtime',
        tokenKind: 'a2a-grant',
        agentId: 'agt_A',
        tokenId: 'tok_1',
        scopes: [],
        callerAgentId: null,
        createdVia: 'api'
    })
    assert.equal(boundAgentIdFromUser(user), 'agt_A')
})

test('account intent does not widen an A2A grant', () => {
    const user = principal({
        kind: 'legacy-runtime',
        tokenKind: 'a2a-grant',
        agentId: 'agt_A',
        tokenId: 'tok_1',
        scopes: [],
        callerAgentId: null,
        createdVia: 'api',
        accountScope: true
    })
    assert.equal(boundAgentIdFromUser(user), 'agt_A')
})

test('boundAgentIdFromUser returns undefined for a human session (no token)', () => {
    const user = principal({
        kind: 'human-session',
        provider: 'email',
        subject: 'usr_1'
    })
    assert.equal(boundAgentIdFromUser(user), undefined)
})
