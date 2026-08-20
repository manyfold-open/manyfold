import type { ApiTokenSummary } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { ApiTokensController } from '../src/modules/auth/api-tokens.controller'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'

const user: AuthPrincipal = {
    kind: 'human-session',
    userId: 'user-1',
    email: 'user@example.com',
    provider: 'api-token',
    subject: 'user-1',
    sessionId: 'session-1'
}

test('ApiTokensController validates missing token name', async () => {
    const controller = new ApiTokensController(makeTokenService() as never)

    await assert.rejects(
        () =>
            controller.create(user, {
                name: '',
                scopes: ['chat.completions']
            }),
        BadRequestException
    )
})

test('ApiTokensController validates empty and unknown scopes', async () => {
    const controller = new ApiTokensController(makeTokenService() as never)

    await assert.rejects(
        () => controller.create(user, { name: 'app', scopes: [] }),
        /scopes/
    )
    await assert.rejects(
        () =>
            controller.create(user, {
                name: 'app',
                scopes: ['unknown' as never]
            }),
        /unsupported/
    )
})

test('ApiTokensController creates a token and returns plaintext once', async () => {
    const svc = makeTokenService()
    const controller = new ApiTokensController(svc as never)

    const res = await controller.create(user, {
        name: 'OpenAI SDK',
        scopes: ['chat.completions']
    })

    assert.equal(res.token, 'nca_plaintext')
    assert.equal(res.summary.name, 'OpenAI SDK')
    assert.deepEqual(res.summary.scopes, ['chat.completions'])
    assert.equal(res.summary.expiresAt, null)
    assert.deepEqual(svc.mintedArgs, [
        {
            userId: 'user-1',
            name: 'OpenAI SDK',
            scopes: ['chat.completions'],
            expiresInDays: undefined
        }
    ])
})

test('ApiTokensController lists summaries without plaintext and revokes by owner', async () => {
    const svc = makeTokenService()
    const controller = new ApiTokensController(svc as never)

    const rows = await controller.list(user)
    await controller.revoke(user, 'pat_123')

    assert.equal(rows.length, 1)
    assert.equal('token' in rows[0], false)
    assert.deepEqual(svc.revokedArgs, [
        { tokenId: 'pat_123', userId: 'user-1' }
    ])
    assert.deepEqual(svc.listedArgs, [{ userId: 'user-1', opts: {} }])
})

test('ApiTokensController forwards agentId filter to listForUser', async () => {
    const svc = makeTokenService()
    const controller = new ApiTokensController(svc as never)

    await controller.list(user, 'agt_abc')
    await controller.list(user, '  agt_pad  ')
    await controller.list(user, '   ')
    await controller.list(user)

    assert.deepEqual(svc.listedArgs, [
        { userId: 'user-1', opts: { agentId: 'agt_abc' } },
        { userId: 'user-1', opts: { agentId: 'agt_pad' } },
        { userId: 'user-1', opts: {} },
        { userId: 'user-1', opts: {} }
    ])
})

test('ApiTokensController forwards includeGrants filter when no agentId is set', async () => {
    const svc = makeTokenService()
    const controller = new ApiTokensController(svc as never)

    await controller.list(user, undefined, 'true')
    await controller.list(user, undefined, '1')
    await controller.list(user, undefined, 'false')
    await controller.list(user, undefined, undefined)
    // agentId takes precedence — includeGrants ignored when agentId set.
    await controller.list(user, 'agt_x', 'true')

    assert.deepEqual(svc.listedArgs, [
        { userId: 'user-1', opts: { includeGrants: true } },
        { userId: 'user-1', opts: { includeGrants: true } },
        { userId: 'user-1', opts: {} },
        { userId: 'user-1', opts: {} },
        { userId: 'user-1', opts: { agentId: 'agt_x' } }
    ])
})

const makeTokenService = () => {
    const summary: ApiTokenSummary = {
        id: 'pat_123',
        name: 'OpenAI SDK',
        scopes: ['chat.completions'],
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date('2026-05-10T00:00:00.000Z').toISOString(),
        enforceAgentBinding: false,
        createdVia: null
    }
    const mintedArgs: unknown[] = []
    const revokedArgs: unknown[] = []
    const listedArgs: Array<{ userId: string; opts: Record<string, unknown> }> =
        []
    return {
        mintedArgs,
        revokedArgs,
        listedArgs,
        listForUser: async (
            userId: string,
            opts: Record<string, unknown> = {}
        ) => {
            listedArgs.push({ userId, opts })
            return [summary]
        },
        mint: async (args: unknown) => {
            const arg = args as {
                userId: string
                name: string
                scopes: ['chat.completions']
                expiresInDays?: number
            }
            mintedArgs.push(arg)
            return {
                tokenId: 'pat_123',
                plaintext: 'nca_plaintext',
                expiresAt: arg.expiresInDays
                    ? new Date('2026-06-09T00:00:00.000Z')
                    : null,
                scopes: arg.scopes
            }
        },
        revoke: async (args: unknown) => {
            revokedArgs.push(args)
        }
    }
}
