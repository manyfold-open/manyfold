import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { ModelProvidersController } from '../src/modules/model-providers/model-providers.controller'
import { UserExternalAgentProvidersController } from '../src/modules/user-external-agent-providers/user-external-agent-providers.controller'
import {
    runtimeAgentId,
    type AuthPrincipal
} from '../src/modules/auth/auth-principal'

// An agent-bound grant token carries an agentId even when enforce_agent_binding
// is false (the cli-poll default) — the exact case that used to slip past the
// boundary guard and reach the account provider-key reveal.
const agentToken = (enforce: boolean): AuthPrincipal => ({
    userId: 'user_1',
    kind: 'legacy-runtime',
    agentId: 'agt_x',
    tokenId: 'pat_agent',
    scopes: ['secrets:read'],
    callerAgentId: null,
    enforceAgentBinding: enforce,
    createdVia: 'cli-poll'
})

const humanSession = (): AuthPrincipal => ({
    userId: 'user_1',
    kind: 'human-session',
    provider: 'email',
    subject: 'usr_1'
})

const humanApiToken = (): AuthPrincipal => ({
    userId: 'user_1',
    kind: 'human-api-token',
    tokenId: 'pat_human',
    scopes: ['secrets:read']
})

test('runtimeAgentId resolves the agent id regardless of enforce_agent_binding', () => {
    assert.equal(runtimeAgentId(agentToken(false)), 'agt_x')
    assert.equal(runtimeAgentId(agentToken(true)), 'agt_x')
    assert.equal(runtimeAgentId(humanApiToken()), undefined)
    assert.equal(runtimeAgentId(humanSession()), undefined)
})

test('model-provider reveal denies agent tokens, allows humans', async () => {
    let revealed = 0
    const service = {
        reveal: async () => {
            revealed += 1
            return {} as never
        }
    }
    const controller = new ModelProvidersController(
        service as never,
        undefined as never,
        undefined as never,
        undefined as never
    )
    await assert.rejects(
        () => controller.reveal(agentToken(false), 'mp_1'),
        ForbiddenException
    )
    await assert.rejects(
        () => controller.reveal(agentToken(true), 'mp_1'),
        ForbiddenException
    )
    assert.equal(revealed, 0, 'agent tokens must never reach service.reveal')
    await controller.reveal(humanSession(), 'mp_1')
    await controller.reveal(humanApiToken(), 'mp_1')
    assert.equal(revealed, 2, 'human session + account API token may reveal')
})

test('byo external-provider reveal denies agent tokens, allows humans', async () => {
    let revealed = 0
    const service = {
        reveal: async () => {
            revealed += 1
            return {} as never
        }
    }
    const controller = new UserExternalAgentProvidersController(
        service as never,
        undefined as never,
        undefined as never
    )
    await assert.rejects(
        () => controller.reveal(agentToken(false), 'byo_1'),
        ForbiddenException
    )
    assert.equal(revealed, 0, 'agent tokens must never reach service.reveal')
    await controller.reveal(humanApiToken(), 'byo_1')
    assert.equal(revealed, 1, 'account API token may reveal')
})

test('account scope does NOT open provider-key reveal (carve-out holds, ADR-0010)', async () => {
    // The reveal handler denies on runtimeAgentId() — set for ANY agent-bound
    // principal — and never reads the account-scope flag. So even a runtime
    // identity that cleared the guard's account-scope path stays 403 here.
    let revealed = 0
    const service = {
        reveal: async () => {
            revealed += 1
            return {} as never
        }
    }
    const accountScopedRuntime: AuthPrincipal = {
        userId: 'user_1',
        kind: 'agent-runtime',
        agentId: 'agt_x',
        runtimeTokenId: 'rtk_1',
        accountScope: true
    }
    const mp = new ModelProvidersController(
        service as never,
        undefined as never,
        undefined as never,
        undefined as never
    )
    await assert.rejects(
        () => mp.reveal(accountScopedRuntime, 'mp_1'),
        ForbiddenException
    )
    const byo = new UserExternalAgentProvidersController(
        service as never,
        undefined as never,
        undefined as never
    )
    await assert.rejects(
        () => byo.reveal(accountScopedRuntime, 'byo_1'),
        ForbiddenException
    )
    assert.equal(revealed, 0, 'account scope must not reach service.reveal')
})
