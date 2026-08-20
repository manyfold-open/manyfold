import type { ApiTokenScope } from '@manyfold/shared'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard } from '../src/common/guards/auth.guard'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'
import { REQUIRE_AUTH_SESSION_META } from '../src/common/decorators/require-auth-session.decorator'
import { ALLOW_RUNTIME_SELF_META } from '../src/common/decorators/allow-runtime-self.decorator'
import {
    SUBJECT_AGENT_META,
    type SubjectAgentClassification
} from '../src/common/decorators/subject-agent.decorator'
import type {
    AuthzService,
    SubjectResolution
} from '../src/modules/auth/authz.service'

interface FakeRequest {
    headers: Record<string, string | undefined>
    auth?: unknown
}

const makeRequest = (token?: string): FakeRequest => ({
    headers: token ? { authorization: `Bearer ${token}` } : {}
})

const makeCtx = (
    request: FakeRequest,
    handler: () => unknown = () => {},
    klass: { new (): unknown } = class {}
): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => klass
    }) as unknown as ExecutionContext

const decorate = (
    target: () => unknown,
    scopes: ApiTokenScope[]
): (() => unknown) => {
    Reflect.defineMetadata(REQUIRED_API_TOKEN_SCOPES_META, scopes, target)
    return target
}

const sessionOnly = (target: () => unknown): (() => unknown) => {
    Reflect.defineMetadata(REQUIRE_AUTH_SESSION_META, true, target)
    return target
}

const withSubject = (
    target: () => unknown,
    classification: SubjectAgentClassification
): (() => unknown) => {
    Reflect.defineMetadata(SUBJECT_AGENT_META, classification, target)
    return target
}

const allowRuntimeSelf = (target: () => unknown): (() => unknown) => {
    Reflect.defineMetadata(ALLOW_RUNTIME_SELF_META, true, target)
    return target
}

const stubAuthz = (overrides: Partial<AuthzService> = {}): AuthzService => {
    const stub: Partial<AuthzService> = {
        resolveSubjectAgent: async () =>
            ({
                classification: null,
                subjectAgentId: null
            }) as SubjectResolution,
        assertBoundTokenSubject: () => {
            // Default: pass through (treated as allowed).
        },
        recordCrossAgentUse: async () => {
            // Default: noop.
        },
        ...overrides
    }
    return stub as AuthzService
}

const guardWith = (
    verify: (token: string) => Promise<unknown>,
    authz: AuthzService = stubAuthz()
): AuthGuard =>
    new AuthGuard(
        { verifyBearerToken: verify } as never,
        new Reflector(),
        authz
    )

test('AuthGuard rejects requests with no bearer token', async () => {
    const guard = guardWith(async () => {
        throw new Error('should not be called')
    })
    await assert.rejects(
        () => guard.canActivate(makeCtx(makeRequest())),
        /Missing bearer token/
    )
})

test('AuthGuard accepts auth session (no apiToken) without scope check', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        email: 'u@example.com',
        kind: 'human-session',
        provider: 'email',
        subject: 'usr_1'
    }))
    const handler = decorate(() => {}, ['channels:edit'])
    const ok = await guard.canActivate(
        makeCtx(makeRequest('session-token'), handler)
    )
    assert.equal(ok, true)
})

test('AuthGuard accepts api.full token on any endpoint (decorated or not)', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'human-api-token',
        tokenId: 'pat_1',
        scopes: ['api.full']
    }))
    const request = makeRequest('nca_full')
    const ok = await guard.canActivate(
        makeCtx(
            request,
            decorate(() => {}, ['channels:read'])
        )
    )
    assert.equal(ok, true)
    const principal = request.auth as { matchedScopes?: ApiTokenScope[] }
    assert.deepEqual(principal.matchedScopes, ['api.full'])
})

test('AuthGuard accepts api.full token on undecorated endpoint', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'human-api-token',
        tokenId: 'pat_1',
        scopes: ['api.full']
    }))
    const ok = await guard.canActivate(makeCtx(makeRequest('nca_full')))
    assert.equal(ok, true)
})

test('AuthGuard accepts narrow scope when method requires it', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_1',
        scopes: ['channels:edit'],
        agentId: 'agt_1',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    }))
    const request = makeRequest('nca_narrow')
    const ok = await guard.canActivate(
        makeCtx(
            request,
            decorate(() => {}, ['channels:edit'])
        )
    )
    assert.equal(ok, true)
    const principal = request.auth as { matchedScopes?: ApiTokenScope[] }
    assert.deepEqual(principal.matchedScopes, ['channels:edit'])
})

test('AuthGuard accepts narrow scope when method accepts one-of', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_1',
        scopes: ['channels:read'],
        agentId: 'agt_1',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    }))
    const ok = await guard.canActivate(
        makeCtx(
            makeRequest('nca_narrow'),
            decorate(() => {}, ['channels:read', 'channels:edit'])
        )
    )
    assert.equal(ok, true)
})

test('AuthGuard rejects narrow scope when method requires a different scope', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_1',
        scopes: ['channels:read'],
        agentId: 'agt_1',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    }))
    await assert.rejects(
        () =>
            guard.canActivate(
                makeCtx(
                    makeRequest('nca_narrow'),
                    decorate(() => {}, ['channels:edit'])
                )
            ),
        /token missing scope: one of \[channels:edit\]/
    )
})

test('AuthGuard rejects narrow scope on undecorated endpoint (safe default)', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_1',
        scopes: ['channels:edit'],
        agentId: 'agt_1',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    }))
    await assert.rejects(
        () => guard.canActivate(makeCtx(makeRequest('nca_narrow'))),
        /requires api.full/
    )
})

test('AuthGuard method-level decorator overrides class-level decorator', async () => {
    class Klass {}
    Reflect.defineMetadata(
        REQUIRED_API_TOKEN_SCOPES_META,
        ['channels:read'],
        Klass
    )
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_1',
        scopes: ['channels:edit'],
        agentId: 'agt_1',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    }))
    // Method needs channels:edit; class would say channels:read but method wins
    const handler = decorate(() => {}, ['channels:edit'])
    const ok = await guard.canActivate(
        makeCtx(makeRequest('nca_narrow'), handler, Klass)
    )
    assert.equal(ok, true)
})

test('AuthGuard accepts auth session on session-only endpoint', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        email: 'u@example.com',
        kind: 'human-session',
        provider: 'email',
        subject: 'usr_1'
    }))
    const handler = sessionOnly(() => {})
    const ok = await guard.canActivate(
        makeCtx(makeRequest('session-token'), handler)
    )
    assert.equal(ok, true)
})

test('AuthGuard rejects api.full PAT on session-only endpoint', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'human-api-token',
        tokenId: 'pat_1',
        scopes: ['api.full']
    }))
    const handler = sessionOnly(() => {})
    await assert.rejects(
        () => guard.canActivate(makeCtx(makeRequest('nca_full'), handler)),
        /requires an auth session/
    )
})

test('AuthGuard rejects narrow PAT on session-only endpoint', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenId: 'pat_1',
        scopes: ['channels:edit'],
        agentId: 'agt_1',
        callerAgentId: null,
        enforceAgentBinding: false,
        createdVia: null
    }))
    const handler = sessionOnly(() => {})
    await assert.rejects(
        () => guard.canActivate(makeCtx(makeRequest('nca_narrow'), handler)),
        /requires an auth session/
    )
})

test('AuthGuard accepts agent-runtime on allowlisted self endpoint without scopes', async () => {
    let permissionLookups = 0
    let assertCalls = 0
    const authz = stubAuthz({
        getAgentPermissionScopes: async () => {
            permissionLookups += 1
            return []
        },
        resolveSubjectAgent: async () =>
            ({
                classification: {
                    type: 'allowlisted',
                    reason: 'auth whoami reports the caller principal'
                },
                subjectAgentId: null
            }) as SubjectResolution,
        assertBoundTokenSubject: (_boundAgentId, resolution) => {
            assertCalls += 1
            assert.equal(resolution.classification?.type, 'allowlisted')
        }
    })
    const guard = guardWith(
        async () => ({
            userId: 'user-1',
            kind: 'agent-runtime',
            agentId: 'agt_A',
            runtimeTokenId: 'rtk_1'
        }),
        authz
    )
    const handler = withSubject(
        allowRuntimeSelf(() => {}),
        {
            type: 'allowlisted',
            reason: 'auth whoami reports the caller principal'
        }
    )

    const ok = await guard.canActivate(makeCtx(makeRequest('nca_rt'), handler))

    assert.equal(ok, true)
    assert.equal(assertCalls, 1)
    assert.equal(permissionLookups, 0)
})

test('AuthGuard session-only does not affect non-decorated endpoints (api.full still passes)', async () => {
    const guard = guardWith(async () => ({
        userId: 'user-1',
        kind: 'human-api-token',
        tokenId: 'pat_1',
        scopes: ['api.full']
    }))
    const handler = () => {} // no decorators
    const ok = await guard.canActivate(
        makeCtx(makeRequest('nca_full'), handler)
    )
    assert.equal(ok, true)
})

test('AuthGuard skips binding enforcement when token is unbound (enforce_agent_binding=false)', async () => {
    let assertCalls = 0
    const authz = stubAuthz({
        // v15-6: unbound grants still resolve subject for cross-agent audit,
        // but never call assertBoundTokenSubject (no enforcement).
        resolveSubjectAgent: async () =>
            ({
                classification: { type: 'path', param: 'id' },
                subjectAgentId: 'agt_A'
            }) as SubjectResolution,
        assertBoundTokenSubject: () => {
            assertCalls += 1
        }
    })
    const guard = guardWith(
        async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime',
            tokenId: 'pat_1',
            scopes: ['channels:edit'],
            agentId: 'agt_A',
            callerAgentId: null,
            enforceAgentBinding: false,
            createdVia: 'cli-poll'
        }),
        authz
    )
    const handler = decorate(() => {}, ['channels:edit'])
    const ok = await guard.canActivate(
        makeCtx(makeRequest('nca_unbound'), handler)
    )
    assert.equal(ok, true)
    assert.equal(assertCalls, 0)
})

test('AuthGuard records cross-agent use for unbound grant on mismatch', async () => {
    const recordCalls: Array<Record<string, unknown>> = []
    const authz = stubAuthz({
        resolveSubjectAgent: async () =>
            ({
                classification: { type: 'path', param: 'id' },
                subjectAgentId: 'agt_B'
            }) as SubjectResolution,
        recordCrossAgentUse: async (args) => {
            recordCalls.push(args as unknown as Record<string, unknown>)
        }
    })
    const guard = guardWith(
        async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime',
            tokenId: 'pat_1',
            scopes: ['channels:edit'],
            agentId: 'agt_A',
            callerAgentId: null,
            enforceAgentBinding: false,
            createdVia: 'cli-poll'
        }),
        authz
    )
    const handler = decorate(() => {}, ['channels:edit'])
    const ok = await guard.canActivate(
        makeCtx(makeRequest('nca_cross'), handler)
    )
    assert.equal(ok, true)
    // recordCrossAgentUse is fire-and-forget via void; give it a tick.
    await new Promise((r) => setImmediate(r))
    assert.equal(recordCalls.length, 1)
    assert.equal(recordCalls[0].fromAgent, 'agt_A')
    assert.equal(recordCalls[0].toAgent, 'agt_B')
})

test('AuthGuard allows bound token when subject agent matches binding', async () => {
    const authz = stubAuthz({
        resolveSubjectAgent: async () =>
            ({
                classification: { type: 'path', param: 'id' },
                subjectAgentId: 'agt_A'
            }) as SubjectResolution
        // assertBoundTokenSubject default stub does nothing — that's allowed.
    })
    const guard = guardWith(
        async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime',
            tokenId: 'pat_1',
            scopes: ['agents:read'],
            agentId: 'agt_A',
            callerAgentId: null,
            enforceAgentBinding: true,
            createdVia: 'user-grant'
        }),
        authz
    )
    const handler = withSubject(
        decorate(() => {}, ['agents:read']),
        { type: 'path', param: 'id' }
    )
    const ok = await guard.canActivate(
        makeCtx(makeRequest('nca_bound'), handler)
    )
    assert.equal(ok, true)
})

test('AuthGuard rejects bound token when AuthzService throws Forbidden', async () => {
    const authz = stubAuthz({
        assertBoundTokenSubject: () => {
            throw new ForbiddenException(
                'token bound to agt_A, request targets agt_B'
            )
        }
    })
    const guard = guardWith(
        async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime',
            tokenId: 'pat_1',
            scopes: ['agents:read'],
            agentId: 'agt_A',
            callerAgentId: null,
            enforceAgentBinding: true,
            createdVia: 'user-grant'
        }),
        authz
    )
    const handler = withSubject(
        decorate(() => {}, ['agents:read']),
        { type: 'path', param: 'id' }
    )
    await assert.rejects(
        () => guard.canActivate(makeCtx(makeRequest('nca_bound'), handler)),
        ForbiddenException
    )
})

test('AuthGuard runs binding enforcement on api.full token when bound', async () => {
    let assertCalls = 0
    const authz = stubAuthz({
        assertBoundTokenSubject: () => {
            assertCalls += 1
        }
    })
    const guard = guardWith(
        async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime',
            tokenId: 'pat_1',
            scopes: ['api.full'],
            agentId: 'agt_A',
            callerAgentId: null,
            enforceAgentBinding: true,
            createdVia: 'user-grant'
        }),
        authz
    )
    const handler = withSubject(() => {}, { type: 'path', param: 'id' })
    const ok = await guard.canActivate(
        makeCtx(makeRequest('nca_full_bound'), handler)
    )
    assert.equal(ok, true)
    assert.equal(assertCalls, 1)
})

// Data-integrity invariant (enforce_agent_binding=true requires agent_id) is
// now type-impossible to construct as a principal — the legacy-runtime arm
// always carries a non-null agentId. The invariant is enforced (and fail-loud
// tested) at the verify() boundary instead; see auth-runtime-principal.test.ts
// 'verify hard-fails when a row sets enforce_agent_binding without agent_id'.

test('AuthGuard surfaces auth store migration errors as 500', async () => {
    const guard = guardWith(async () => {
        const err = new Error('relation "auth_identities" does not exist')
        ;(err as Error & { code: string }).code = '42P01'
        throw err
    })
    await assert.rejects(
        () => guard.canActivate(makeCtx(makeRequest('whatever'))),
        /Authentication store is not migrated/
    )
})
