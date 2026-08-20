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

test('boundAgentIdFromUser returns undefined for a legacy enforce=false token', () => {
    // Legacy poll/grant tokens keep their broad list-all behaviour; narrowing
    // them is the separately-announced split, out of scope here.
    const user = principal({
        kind: 'legacy-runtime',
        agentId: 'agt_A',
        tokenId: 'tok_1',
        scopes: [],
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: 'cli-poll'
    })
    assert.equal(boundAgentIdFromUser(user), undefined)
})

test('boundAgentIdFromUser still returns the agent for an enforce=true bound token', () => {
    // human-api-token can't carry agentId/enforce in the union, so the bound
    // enforce=true case is a legacy-runtime — behaviour (returns agt_A) holds.
    const user = principal({
        kind: 'legacy-runtime',
        agentId: 'agt_A',
        tokenId: 'tok_1',
        scopes: [],
        callerAgentId: null,
        enforceAgentBinding: true,
        createdVia: 'user-grant'
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
