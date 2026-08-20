import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard } from '../src/common/guards/auth.guard'
import type { AuthzService } from '../src/modules/auth/authz.service'
import { BearerAuthService } from '../src/modules/auth/bearer-auth.service'

const passThroughAuthz = {
    resolveSubjectAgent: async () => ({
        classification: null,
        subjectAgentId: null
    }),
    assertBoundTokenSubject: () => {}
} as unknown as AuthzService

const ctx = (request: unknown): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => (() => {}) as never,
        getClass: () => class {}
    }) as unknown as ExecutionContext

test('AuthGuard verifies bearer tokens without user profile lookup', async () => {
    const calls: string[] = []
    const request = {
        headers: {
            authorization: 'Bearer test-token'
        },
        auth: undefined as { userId: string } | undefined
    }
    const guard = new AuthGuard(
        {
            verifyBearerToken: async (token: string) => {
                calls.push(`verify:${token}`)
                return {
                    userId: 'user-1',
                    kind: 'human-session',
                    provider: 'email',
                    subject: 'usr_1'
                }
            },
            getUserEmail: async () => {
                calls.push('email')
                return 'user@example.com'
            }
        } as never,
        new Reflector(),
        passThroughAuthz
    )

    const ok = await guard.canActivate(ctx(request))

    assert.equal(ok, true)
    assert.deepEqual(request.auth, {
        userId: 'user-1',
        kind: 'human-session',
        provider: 'email',
        subject: 'usr_1'
    })
    assert.deepEqual(calls, ['verify:test-token'])
})

test('BearerAuthService delegates nca_ tokens to ApiTokenService', async () => {
    const svc = new BearerAuthService(
        {
            verify: async (token: string) => ({
                userId: `api:${token}`,
                email: 'cli@example.com'
            })
        } as never,
        {
            verify: async () => {
                throw new Error('session service should not be used')
            }
        } as never,
        {} as never
    )

    assert.deepEqual(await svc.verifyBearerToken('nca_test'), {
        userId: 'api:nca_test',
        email: 'cli@example.com'
    })
})

test('BearerAuthService resolves mfs_ session tokens and rejects stale Clerk JWTs', async () => {
    const svc = new BearerAuthService(
        {
            verify: async () => {
                throw new Error('api token should not be used')
            }
        } as never,
        {
            verify: async (token: string) =>
                token === 'mfs_live'
                    ? {
                          userId: 'usr:session',
                          email: 'sess@example.com',
                          kind: 'human-session',
                          provider: 'email',
                          subject: 'sess@example.com'
                      }
                    : null
        } as never,
        {} as never
    )

    assert.deepEqual(await svc.verifyBearerToken('mfs_live'), {
        userId: 'usr:session',
        email: 'sess@example.com',
        kind: 'human-session',
        provider: 'email',
        subject: 'sess@example.com'
    })

    await assert.rejects(
        () => svc.verifyBearerToken('legacy-clerk-jwt'),
        /invalid bearer token/
    )
})

test('AuthGuard accepts api.full API tokens', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_full' },
        auth: undefined as unknown
    }
    const guard = new AuthGuard(
        {
            verifyBearerToken: async () => ({
                userId: 'user-1',
                kind: 'human-api-token',
                tokenId: 'pat_1',
                scopes: ['api.full']
            })
        } as never,
        new Reflector(),
        passThroughAuthz
    )

    assert.equal(await guard.canActivate(ctx(request)), true)
})

test('AuthGuard rejects chat-only API tokens for ordinary API routes', async () => {
    const request = {
        headers: { authorization: 'Bearer nca_chat' },
        auth: undefined as unknown
    }
    const guard = new AuthGuard(
        {
            verifyBearerToken: async () => ({
                userId: 'user-1',
                kind: 'human-api-token',
                tokenId: 'pat_1',
                scopes: ['chat.completions']
            })
        } as never,
        new Reflector(),
        passThroughAuthz
    )

    await assert.rejects(() => guard.canActivate(ctx(request)), /api.full/)
})

test('AuthGuard reports missing auth identity migration as server error', async () => {
    const request = {
        headers: { authorization: 'Bearer oidc-token' },
        auth: undefined as unknown
    }
    const guard = new AuthGuard(
        {
            verifyBearerToken: async () => {
                const error = new Error(
                    'relation "auth_identities" does not exist'
                )
                ;(error as Error & { code: string }).code = '42P01'
                throw error
            }
        } as never,
        new Reflector(),
        passThroughAuthz
    )

    await assert.rejects(
        () => guard.canActivate(ctx(request)),
        /Authentication store is not migrated/
    )
})
