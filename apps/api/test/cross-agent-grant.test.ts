/**
 * Phase 9 — cross-agent grant property tests.
 *
 * Locks in decision #5 from PLAN-02: a grant token bound to agent A may be
 * used to act on agent B as long as the requesting user owns B. Agent
 * ownership is enforced at the resource layer (user_id check), not by tying
 * the token to a specific agent in the AuthGuard.
 *
 * What this test proves:
 *   - AuthGuard does NOT inspect URL params or token.agentId when deciding
 *     whether to admit a request. Scope is the only authorization signal.
 *   - The token's agentId is metadata for revoke/audit, not an ACL.
 *   - Cross-USER blocks happen further down the stack (resource service
 *     queries `agents WHERE id = ? AND user_id = ?`).
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'
import { AuthGuard } from '../src/common/guards/auth.guard'
import type { AuthzService } from '../src/modules/auth/authz.service'

const passThroughAuthz = {
    resolveSubjectAgent: async () => ({
        classification: null,
        subjectAgentId: null
    }),
    assertBoundTokenSubject: () => {}
} as unknown as AuthzService

const decorate = (
    handler: () => unknown,
    scopes: readonly string[]
): (() => unknown) => {
    Reflect.defineMetadata(REQUIRED_API_TOKEN_SCOPES_META, scopes, handler)
    return handler
}

const ctx = (
    request: unknown,
    handler: () => unknown,
    klass: { new (): unknown } = class {}
): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => klass
    }) as unknown as ExecutionContext

const guardFor = (verify: () => Promise<unknown>): AuthGuard =>
    new AuthGuard(
        { verifyBearerToken: verify } as never,
        new Reflector(),
        passThroughAuthz
    )

test('grant token bound to agent A admits a request that mutates agent B (same user)', async () => {
    // The grant token's agentId field is metadata for revocation/auditing;
    // it does NOT scope-down which agents the caller can address. The
    // resource controller resolves ownership via user_id (covered separately
    // by channels-service unit tests).
    const verify = async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_grant',
        scopes: ['channels:edit'],
        agentId: 'agt_A',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    })
    const handler = decorate(() => {}, ['channels:edit'])
    // The request body says agt_B, but the guard does not even look.
    const request = {
        headers: { authorization: 'Bearer nca_grant_xxx' },
        body: { agentId: 'agt_B' },
        auth: undefined as unknown
    }

    const guard = guardFor(verify)
    assert.equal(await guard.canActivate(ctx(request, handler)), true)
})

test('AuthGuard never reads URL params or body when authorizing — only token scope', async () => {
    const verify = async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_grant',
        scopes: ['channels:edit'],
        agentId: 'agt_A',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    })
    const handler = decorate(() => {}, ['channels:edit'])
    // Same token, totally different request path/body. Guard should not care.
    for (const params of [
        { body: { agentId: 'agt_A' } },
        { body: { agentId: 'agt_B' } },
        { body: {}, params: { id: 'chn_other' } },
        { url: '/api/channels/chn_xyz/test' }
    ]) {
        const request = {
            headers: { authorization: 'Bearer nca_grant_xxx' },
            auth: undefined as unknown,
            ...params
        }
        const guard = guardFor(verify)
        assert.equal(
            await guard.canActivate(ctx(request, handler)),
            true,
            `guard rejected request with ${JSON.stringify(params)}`
        )
    }
})

test('grant token with channels:edit cannot reach an undecorated endpoint (safe default)', async () => {
    // Decision: skills/repos/* and similar admin-ish paths stay api.full-only.
    // A grant token must NOT be able to escalate by hitting an undecorated
    // controller method.
    const verify = async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_grant',
        scopes: ['channels:edit'],
        agentId: 'agt_A',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    })
    const handler = () => {} // No @RequireApiTokenScope decorator at all.
    const guard = guardFor(verify)
    await assert.rejects(
        () =>
            guard.canActivate(
                ctx(
                    {
                        headers: { authorization: 'Bearer nca_grant_xxx' },
                        auth: undefined as unknown
                    },
                    handler
                )
            ),
        /requires api.full/
    )
})

test('grant token without the required scope is rejected even for the matching agentId', async () => {
    // Even when the token is bound to the agent under discussion, the scope
    // gate is the authoritative signal.
    const verify = async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_grant',
        scopes: ['channels:read'],
        agentId: 'agt_A',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    })
    const handler = decorate(() => {}, ['channels:edit'])
    const guard = guardFor(verify)
    await assert.rejects(
        () =>
            guard.canActivate(
                ctx(
                    {
                        headers: { authorization: 'Bearer nca_grant_xxx' },
                        body: { agentId: 'agt_A' },
                        auth: undefined as unknown
                    },
                    handler
                )
            ),
        /token missing scope: one of \[channels:edit\]/
    )
})
