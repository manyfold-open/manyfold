import 'reflect-metadata'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UnauthorizedException } from '@nestjs/common'
import { BearerAuthService } from '../src/modules/auth/bearer-auth.service'
import type { ApiTokenService } from '../src/modules/auth/api-token.service'
import type { SessionService } from '../src/modules/auth/session.service'
import type { AuthService } from '../src/modules/auth/auth.service'

// The bearer chokepoint is the one place every authenticated request resolves a
// principal. These tests pin the routing invariants that keep machine tokens,
// human sessions, and now-defunct Clerk JWTs from being confused for one another.
const build = (overrides: {
    sessionVerify?: (token: string) => Promise<unknown>
}) => {
    const calls = { api: [] as string[], session: [] as string[] }
    const apiTokens = {
        verify: async (token: string) => {
            calls.api.push(token)
            return {
                kind: 'human-api-token',
                userId: 'u-api',
                tokenId: 'pat_1',
                scopes: []
            }
        }
    } as unknown as ApiTokenService
    const sessions = {
        verify: async (token: string) => {
            calls.session.push(token)
            return overrides.sessionVerify
                ? overrides.sessionVerify(token)
                : null
        }
    } as unknown as SessionService
    const auth = {} as AuthService
    return { svc: new BearerAuthService(apiTokens, sessions, auth), calls }
}

test('nca_ tokens route to the api-token verifier, never the session path', async () => {
    const { svc, calls } = build({})
    const principal = await svc.verifyBearerToken('nca_abc')
    assert.equal((principal as { userId: string }).userId, 'u-api')
    assert.deepEqual(calls.api, ['nca_abc'])
    assert.deepEqual(calls.session, [])
})

test('mfs_ tokens resolve through the session verifier', async () => {
    const { svc, calls } = build({
        sessionVerify: async () => ({
            kind: 'human-session',
            userId: 'u-sess',
            email: 'a@b.c',
            provider: 'email',
            subject: 'a@b.c'
        })
    })
    const principal = await svc.verifyBearerToken('mfs_good')
    assert.equal((principal as { userId: string }).userId, 'u-sess')
    assert.deepEqual(calls.session, ['mfs_good'])
    assert.deepEqual(calls.api, [])
})

test('a revoked/expired session (verify resolves null) is a 401, not a silent pass', async () => {
    const { svc } = build({ sessionVerify: async () => null })
    await assert.rejects(
        () => svc.verifyBearerToken('mfs_dead'),
        UnauthorizedException
    )
})

test('a stale Clerk JWT (neither nca_ nor mfs_) is rejected so the browser re-authenticates', async () => {
    const { svc, calls } = build({})
    await assert.rejects(
        () => svc.verifyBearerToken('eyJhbGciOiJSUzI1NiJ9.clerk.jwt'),
        UnauthorizedException
    )
    assert.deepEqual(calls.api, [])
    assert.deepEqual(calls.session, [])
})
