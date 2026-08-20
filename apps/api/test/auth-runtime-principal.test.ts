import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { agentRuntimeTokens, apiTokens, type Database } from '@manyfold/db'
import { AuthGuard } from '../src/common/guards/auth.guard'
import type { AuthzService } from '../src/modules/auth/authz.service'
import {
    ApiTokenService,
    isApiToken,
    isRuntimeToken,
    normalizeStoredScopes
} from '../src/modules/auth/api-token.service'
import type { BearerAuthService } from '../src/modules/auth/bearer-auth.service'
import {
    principalAgentId,
    principalScopes
} from '../src/modules/auth/auth-principal'
import { authenticateOpenAiRequest } from '../src/modules/openai-compat/openai-auth'
import { OpenAiCompatError } from '../src/modules/openai-compat/openai-chat-completions.service'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'

const ctx = (request: unknown): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => (() => {}) as never,
        getClass: () => class {}
    }) as unknown as ExecutionContext

const reflectorWith = (required?: string[]): Reflector =>
    ({
        getAllAndOverride: (key: string) =>
            key === REQUIRED_API_TOKEN_SCOPES_META ? required : undefined
    }) as unknown as Reflector

const authzWith = (granted: string[], sink?: string[]): AuthzService =>
    ({
        getAgentPermissionScopes: async (agentId: string) => {
            sink?.push(agentId)
            return granted
        },
        resolveSubjectAgent: async () => ({
            classification: null,
            subjectAgentId: null
        }),
        assertBoundTokenSubject: () => {},
        recordCrossAgentUse: async () => {}
    }) as unknown as AuthzService

const runtimePrincipal = () => ({
    userId: 'user-1',
    kind: 'agent-runtime' as const,
    agentId: 'agt_A',
    runtimeTokenId: 'rtk_1'
})

const guardFor = (
    principal: unknown,
    required: string[] | undefined,
    authz: AuthzService
): AuthGuard =>
    new AuthGuard(
        { verifyBearerToken: async () => principal } as never,
        reflectorWith(required),
        authz
    )

test('agent-runtime authorizes from agent_permissions, not token scopes', async () => {
    const seen: string[] = []
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const guard = guardFor(
        runtimePrincipal(),
        ['channels:read'],
        authzWith(['channels:read', 'files:read'], seen)
    )

    assert.equal(await guard.canActivate(ctx(request)), true)
    assert.deepEqual(seen, ['agt_A'])
    assert.deepEqual(
        (request.auth as { matchedScopes?: string[] }).matchedScopes,
        ['channels:read']
    )
})

test('agent-runtime is denied when agent_permissions lacks the required scope', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const guard = guardFor(
        runtimePrincipal(),
        ['channels:edit'],
        authzWith(['channels:read'])
    )

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /agent permission missing scope/
    )
})

test('agent-runtime cannot reach api.full-only endpoints', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const guard = guardFor(runtimePrincipal(), undefined, authzWith([]))

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /agent runtime tokens cannot access it/
    )
})

test('agent-runtime never short-circuits on token scopes — authorizes from agent_permissions', async () => {
    // The agent-runtime arm carries no scopes at all, so it can never short-
    // circuit on api.full; the branch runs first and authorizes from
    // agent_permissions only (M-sec-1). Empty grants → rejected.
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const guard = guardFor(runtimePrincipal(), ['channels:read'], authzWith([]))

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /agent permission missing scope/
    )
})

test('agent-runtime is 403 on a subject-bound resource owned by another agent', async () => {
    // FIX-1: the runtime principal for agt_A targets a resource resolving to
    // agt_B. Even though the token carries enforceAgentBinding=false, the
    // agent-runtime branch must assert the subject UNCONDITIONALLY and 403 —
    // never fall through to the audit-only path.
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => ['channels:edit'],
        // Subject resolves to a DIFFERENT agent than the principal (agt_A).
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_B'
        }),
        // Mirror the real AuthzService equality check.
        assertBoundTokenSubject: (
            boundAgentId: string,
            resolution: { subjectAgentId: string | null }
        ) => {
            if (resolution.subjectAgentId !== boundAgentId)
                throw new ForbiddenException(
                    `token bound to ${boundAgentId}, request targets ${resolution.subjectAgentId}`
                )
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['channels:edit'], authz)

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        (err: unknown) =>
            err instanceof ForbiddenException &&
            /token bound to agt_A, request targets agt_B/.test(
                (err as Error).message
            )
    )
})

test('agent-runtime passes the subject-bound check when the resource is its own', async () => {
    // FIX-1 positive case: same principal, subject resolves to agt_A.
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => ['channels:edit'],
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_A'
        }),
        assertBoundTokenSubject: (
            boundAgentId: string,
            resolution: { subjectAgentId: string | null }
        ) => {
            if (resolution.subjectAgentId !== boundAgentId)
                throw new ForbiddenException('mismatch')
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['channels:edit'], authz)

    assert.equal(await guard.canActivate(ctx(request)), true)
})

test('agent-runtime operates its OWN resource with NO agent_permissions scope (agent scope is free)', async () => {
    // ADR-0010 Track 1: self-scoped endpoints no longer fail closed. The
    // subject resolves to the token's own agent, so the request is allowed
    // WITHOUT consulting agent_permissions at all.
    const sink: string[] = []
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async (id: string) => {
            sink.push(id)
            return []
        },
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_A'
        }),
        assertBoundTokenSubject: (
            bound: string,
            res: { subjectAgentId: string | null }
        ) => {
            if (res.subjectAgentId !== bound)
                throw new ForbiddenException('mismatch')
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['automations:read'], authz)

    assert.equal(await guard.canActivate(ctx(request)), true)
    // Self access is free: agent_permissions was never consulted.
    assert.deepEqual(sink, [])
})

test('agent-runtime bound-filtered list is free under agent scope', async () => {
    const sink: string[] = []
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async (id: string) => {
            sink.push(id)
            return []
        },
        resolveSubjectAgent: async () => ({
            classification: { type: 'list-filtered' },
            subjectAgentId: null
        }),
        assertBoundTokenSubject: () => {},
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['automations:read'], authz)

    assert.equal(await guard.canActivate(ctx(request)), true)
    assert.deepEqual(sink, [])
})

test('agent-runtime targeting ANOTHER agent (no --account) stays denied even though self is free', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_rt' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => [],
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_B'
        }),
        assertBoundTokenSubject: (
            bound: string,
            res: { subjectAgentId: string | null }
        ) => {
            if (res.subjectAgentId !== bound)
                throw new ForbiddenException(
                    `token bound to ${bound}, request targets ${res.subjectAgentId}`
                )
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['automations:read'], authz)

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /agent permission missing scope/
    )
})

test('account scope: cross-agent with the fine-grained scope + same-account ownership is allowed', async () => {
    // ADR-0010 Track 2: with the `x-account-scope` header, a granted runtime
    // identity reaches another agent it owns. The self-bind is REPLACED by an
    // intra-user ownership assertion; the account-scope flag is stamped on the
    // principal so list endpoints widen.
    const request = {
        headers: { authorization: 'Bearer nca_rt', 'x-account-scope': '1' },
        auth: undefined as unknown
    }
    let ownership: [string | null, string] | null = null
    const authz = {
        getAgentPermissionScopes: async () => ['automations:read'],
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_B'
        }),
        assertAccountSubject: async (
            res: { subjectAgentId: string | null },
            userId: string
        ) => {
            ownership = [res.subjectAgentId, userId]
        },
        assertBoundTokenSubject: () => {
            throw new ForbiddenException(
                'self-bind must NOT run under account scope'
            )
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['automations:read'], authz)

    assert.equal(await guard.canActivate(ctx(request)), true)
    assert.deepEqual(ownership, ['agt_B', 'user-1'])
    assert.equal(
        (request.auth as { accountScope?: boolean }).accountScope,
        true
    )
})

test('account scope still requires the fine-grained scope (denied when missing)', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_rt', 'x-account-scope': '1' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => [],
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_B'
        }),
        assertAccountSubject: async () => {},
        assertBoundTokenSubject: () => {},
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['automations:read'], authz)

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /agent permission missing scope/
    )
})

test('account scope rejects a target agent outside the account (intra-user)', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_rt', 'x-account-scope': '1' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => ['automations:edit'],
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_other'
        }),
        assertAccountSubject: async () => {
            throw new ForbiddenException(
                'agent agt_other is not in this account'
            )
        },
        assertBoundTokenSubject: () => {},
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['automations:edit'], authz)

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /not in this account/
    )
})

test('account scope unlocks an account-level (deny-bound) endpoint with the scope', async () => {
    // §5.4 reversal: deny-bound (e.g. usage top-agents) is denied to a bound
    // token under agent scope but allowed under account scope with the scope.
    const request = {
        headers: { authorization: 'Bearer nca_rt', 'x-account-scope': '1' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => ['usage:read'],
        resolveSubjectAgent: async () => ({
            classification: { type: 'deny-bound' },
            subjectAgentId: null
        }),
        assertAccountSubject: async () => {},
        assertBoundTokenSubject: () => {
            throw new ForbiddenException(
                'deny-bound must not self-bind under account scope'
            )
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['usage:read'], authz)

    assert.equal(await guard.canActivate(ctx(request)), true)
})

test('account scope allows agent creation (deny-bound POST /agents) with agents:edit', async () => {
    // ADR-0010 S2 (decided 2026-06-17: allowed): a runtime identity with account
    // scope + agents:edit may create agents on the account (orchestrator pattern).
    // deny-bound + account intent + the scope → allowed, with no self-bind.
    const request = {
        headers: { authorization: 'Bearer nca_rt', 'x-account-scope': '1' },
        auth: undefined as unknown
    }
    const authz = {
        getAgentPermissionScopes: async () => ['agents:edit'],
        resolveSubjectAgent: async () => ({
            classification: { type: 'deny-bound' },
            subjectAgentId: null
        }),
        assertAccountSubject: async () => {},
        assertBoundTokenSubject: () => {
            throw new ForbiddenException(
                'must not self-bind agent creation under account scope'
            )
        },
        recordCrossAgentUse: async () => {}
    } as unknown as AuthzService
    const guard = guardFor(runtimePrincipal(), ['agents:edit'], authz)

    assert.equal(await guard.canActivate(ctx(request)), true)
})

test('OpenAI /v1 surface rejects an agent-runtime identity token', async () => {
    const auth = {
        verifyBearerToken: async () => runtimePrincipal()
    } as unknown as BearerAuthService
    const req = {
        headers: { authorization: 'Bearer nca_rt' }
    } as never

    await assert.rejects(
        () => authenticateOpenAiRequest(auth, req),
        (err: unknown) =>
            err instanceof OpenAiCompatError &&
            /cannot access the OpenAI-compatible API/.test(err.message)
    )
})

test('isRuntimeToken discriminates the runtime prefix; isApiToken accepts both', () => {
    assert.equal(isRuntimeToken('nca_rt_abc'), true)
    assert.equal(isRuntimeToken('nca_abc'), false)
    assert.equal(isApiToken('nca_rt_abc'), true)
    assert.equal(isApiToken('nca_abc'), true)
    assert.equal(isApiToken('ldt_abc'), false)
})

test('OpenAI /v1 rejects the runtime prefix before any DB lookup', async () => {
    let verifyCalled = false
    const auth = {
        verifyBearerToken: async () => {
            verifyCalled = true
            return runtimePrincipal()
        }
    } as unknown as BearerAuthService
    const req = {
        headers: { authorization: 'Bearer nca_rt_leaked' }
    } as never

    await assert.rejects(
        () => authenticateOpenAiRequest(auth, req),
        (err: unknown) =>
            err instanceof OpenAiCompatError &&
            /cannot access the OpenAI-compatible API/.test(err.message)
    )
    assert.equal(verifyCalled, false)
})

test('OpenAI /v1 surface rejects a legacy-runtime bearer (post-verify kind)', async () => {
    // No runtime prefix, so the early-reject is bypassed and verify() runs;
    // the kind backstop must still reject the legacy cli-poll runtime bearer
    // so it cannot drive the account-level /v1 chat surface during compat.
    const auth = {
        verifyBearerToken: async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime' as const,
            agentId: 'agt_A',
            tokenId: 'pat_1',
            scopes: ['chat.completions'],
            callerAgentId: null,
            enforceAgentBinding: false,
            createdVia: 'cli-poll' as const
        })
    } as unknown as BearerAuthService
    const req = {
        headers: { authorization: 'Bearer nca_legacy' }
    } as never

    await assert.rejects(
        () => authenticateOpenAiRequest(auth, req),
        (err: unknown) =>
            err instanceof OpenAiCompatError &&
            /cannot access the OpenAI-compatible API/.test(err.message)
    )
})

test('OpenAI /v1 surface rejects any principal that carries an agentId', async () => {
    // The /v1 surface rejects on principalAgentId() — any agent-bound principal
    // (here a legacy-runtime with agentId) must not reach the account-level
    // surface. The union makes a human-api-token structurally agentId-free, so
    // the only realizable agent-bound principals are agent/legacy-runtime.
    const auth = {
        verifyBearerToken: async () => ({
            userId: 'user-1',
            kind: 'legacy-runtime' as const,
            agentId: 'agt_B',
            tokenId: 'pat_2',
            scopes: ['chat.completions'],
            callerAgentId: null,
            enforceAgentBinding: false,
            createdVia: null
        })
    } as unknown as BearerAuthService
    const req = {
        headers: { authorization: 'Bearer nca_bound' }
    } as never

    await assert.rejects(
        () => authenticateOpenAiRequest(auth, req),
        (err: unknown) =>
            err instanceof OpenAiCompatError &&
            /cannot access the OpenAI-compatible API/.test(err.message)
    )
})

test('OpenAI /v1 surface still admits a plain human-api-token (no agentId)', async () => {
    // Guardrail for the rejections above: an account-level token with the
    // chat.completions scope and no agent binding must keep working.
    const auth = {
        verifyBearerToken: async () => ({
            userId: 'user-1',
            kind: 'human-api-token' as const,
            tokenId: 'pat_3',
            scopes: ['chat.completions']
        })
    } as unknown as BearerAuthService
    const req = {
        headers: { authorization: 'Bearer nca_human' }
    } as never

    const user = await authenticateOpenAiRequest(auth, req)
    assert.equal(user.kind, 'human-api-token')
    // human-api-token carries no agent binding (no agentId field on the arm).
    assert.equal(principalAgentId(user), undefined)
})

// ---- verify() two-table resolution ----

class VerifyFakeDb {
    runtimeRows: Record<string, unknown>[] = []
    apiRows: Record<string, unknown>[] = []
    updated: unknown[] = []
    select(_shape?: unknown) {
        return new VerifyQuery(this)
    }
    update(table: unknown) {
        return new VerifyQuery(this, table)
    }
}

class VerifyQuery {
    private table: unknown
    private readonly isUpdate: boolean
    constructor(
        private readonly db: VerifyFakeDb,
        table?: unknown
    ) {
        this.table = table
        this.isUpdate = table !== undefined
    }
    from(table: unknown) {
        this.table = table
        return this
    }
    innerJoin() {
        return this
    }
    set() {
        return this
    }
    where() {
        if (this.isUpdate) {
            this.db.updated.push(this.table)
            return Promise.resolve()
        }
        return this
    }
    limit() {
        if (this.table === agentRuntimeTokens)
            return Promise.resolve(this.db.runtimeRows.slice(0, 1))
        if (this.table === apiTokens)
            return Promise.resolve(this.db.apiRows.slice(0, 1))
        return Promise.resolve([])
    }
}

const svcWith = (db: VerifyFakeDb) =>
    new ApiTokenService(db as unknown as Database)

test('verify resolves an agent_runtime_tokens hit as kind=agent-runtime', async () => {
    const db = new VerifyFakeDb()
    db.runtimeRows = [
        {
            id: 'rtk_1',
            userId: 'user-1',
            agentId: 'agt_A',
            expiresAt: null,
            revokedAt: null,
            email: 'u@example.com'
        }
    ]
    const auth = await svcWith(db).verify('nca_runtime')

    assert.equal(auth.kind, 'agent-runtime')
    assert.equal(principalAgentId(auth), 'agt_A')
    if (auth.kind === 'agent-runtime')
        assert.equal(auth.runtimeTokenId, 'rtk_1')
    // The agent-runtime arm carries no token scopes by construction.
    assert.deepEqual(principalScopes(auth), [])
    assert.deepEqual(db.updated, [agentRuntimeTokens])
})

test('verify resolves an api_tokens hit with agentId as kind=legacy-runtime', async () => {
    const db = new VerifyFakeDb()
    db.apiRows = [
        {
            id: 'pat_1',
            userId: 'user-1',
            agentId: 'agt_A',
            callerAgentId: null,
            scopes: ['channels:read'],
            enforceAgentBinding: false,
            createdVia: 'cli-poll',
            tokenKind: 'user-grant',
            expiresAt: null,
            revokedAt: null,
            email: 'u@example.com'
        }
    ]
    const auth = await svcWith(db).verify('nca_legacy')

    assert.equal(auth.kind, 'legacy-runtime')
    assert.equal(principalAgentId(auth), 'agt_A')
    if (auth.kind === 'legacy-runtime')
        assert.equal(auth.tokenKind, 'user-grant')
    assert.deepEqual(db.updated, [apiTokens])
})

test('verify resolves a plain api_tokens hit as kind=human-api-token', async () => {
    const db = new VerifyFakeDb()
    db.apiRows = [
        {
            id: 'pat_1',
            userId: 'user-1',
            agentId: null,
            callerAgentId: null,
            scopes: ['api.full'],
            enforceAgentBinding: false,
            createdVia: null,
            expiresAt: null,
            revokedAt: null,
            email: 'u@example.com'
        }
    ]
    const auth = await svcWith(db).verify('nca_human')

    assert.equal(auth.kind, 'human-api-token')
    // human-api-token carries no agent binding (no agentId field on the arm).
    assert.equal(principalAgentId(auth), undefined)
})

test('verify hard-fails when the same hash resolves in both tables', async () => {
    const db = new VerifyFakeDb()
    db.runtimeRows = [
        {
            id: 'rtk_1',
            userId: 'user-1',
            agentId: 'agt_A',
            expiresAt: null,
            revokedAt: null,
            email: 'u@example.com'
        }
    ]
    db.apiRows = [
        {
            id: 'pat_1',
            userId: 'user-1',
            agentId: null,
            callerAgentId: null,
            scopes: [],
            enforceAgentBinding: false,
            createdVia: null,
            expiresAt: null,
            revokedAt: null,
            email: 'u@example.com'
        }
    ]

    await assert.rejects(
        () => svcWith(db).verify('nca_both'),
        /both credential tables/
    )
})

test('verify hard-fails when a row sets enforce_agent_binding without agent_id', async () => {
    // Data-integrity invariant (no DB CHECK enforces it): a row may not claim
    // enforce_agent_binding=true with a null agent_id. verify() fails loud
    // rather than silently classifying it as a plain human-api-token. (This
    // moved up from the AuthGuard, which can no longer receive such a principal
    // — the legacy-runtime arm always carries a non-null agentId.)
    const db = new VerifyFakeDb()
    db.apiRows = [
        {
            id: 'pat_1',
            userId: 'user-1',
            agentId: null,
            callerAgentId: null,
            scopes: ['agents:read'],
            enforceAgentBinding: true,
            createdVia: 'user-grant',
            expiresAt: null,
            revokedAt: null,
            email: 'u@example.com'
        }
    ]

    await assert.rejects(
        () => svcWith(db).verify('nca_bad_state'),
        /no agent_id/
    )
})

test('verify rejects a revoked runtime token', async () => {
    const db = new VerifyFakeDb()
    db.runtimeRows = [
        {
            id: 'rtk_1',
            userId: 'user-1',
            agentId: 'agt_A',
            expiresAt: null,
            revokedAt: new Date(),
            email: 'u@example.com'
        }
    ]

    await assert.rejects(() => svcWith(db).verify('nca_revoked'), /revoked/)
})

// ---- normalizeStoredScopes deny-by-default (M-sec-1) ----

test('normalizeStoredScopes denies (returns []) for empty/garbage input', () => {
    // The footgun was empty/invalid stored scopes silently becoming [api.full]
    // (full access). They must now fail closed to [] instead.
    assert.deepEqual(normalizeStoredScopes([]), [])
    assert.deepEqual(normalizeStoredScopes(null), [])
    assert.deepEqual(normalizeStoredScopes(undefined), [])
    assert.deepEqual(normalizeStoredScopes('api.full'), [])
    assert.deepEqual(normalizeStoredScopes(['nope', 'bogus']), [])
})

test('normalizeStoredScopes keeps valid scopes and drops invalid ones', () => {
    assert.deepEqual(normalizeStoredScopes(['api.full']), ['api.full'])
    assert.deepEqual(normalizeStoredScopes(['chat.completions', 'bogus']), [
        'chat.completions'
    ])
})
