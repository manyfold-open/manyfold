import 'reflect-metadata'
import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Reflector } from '@nestjs/core'
import { ACCOUNT_SCOPE_HEADER } from '@manyfold/shared'
import type { ExecutionContext } from '@nestjs/common'
import { AuthGuard } from '../src/common/guards/auth.guard'
import { AuthzService } from '../src/modules/auth/authz.service'
import { RuntimeAccessController } from '../src/modules/runtime-access/runtime-access.controller'

const authorize = async (options: {
    account?: boolean
    scopes?: string[]
    kind?: 'agent-runtime' | 'human-session' | 'human-api-token'
    handler?: 'sandboxUsage' | 'summary' | 'agentSandboxUsage'
    agentId?: string
}) => {
    const reflector = new Reflector()
    const authz = new AuthzService(
        reflector,
        {
            select: () => ({
                from: () => ({
                    where: () => ({
                        limit: async () => [{ scopes: options.scopes ?? [] }]
                    })
                })
            })
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    const kind = options.kind ?? 'agent-runtime'
    const request = {
        headers: {
            authorization: 'Bearer owned-fixture',
            ...(options.account ? { [ACCOUNT_SCOPE_HEADER]: '1' } : {})
        },
        params: { agentId: options.agentId ?? 'fixture-agent' },
        auth: undefined as unknown
    }
    const guard = new AuthGuard(
        {
            verifyBearerToken: async () => ({
                kind,
                userId: 'fixture-user',
                agentId: 'fixture-agent',
                scopes: options.scopes
            })
        } as never,
        reflector,
        authz
    )
    const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getClass: () => RuntimeAccessController,
        getHandler: () =>
            RuntimeAccessController.prototype[options.handler ?? 'sandboxUsage']
    } as unknown as ExecutionContext
    return guard.canActivate(context)
}

test('account sandbox report requires explicit runtime intent and agents:read consent', async () => {
    assert.equal(
        await authorize({ account: true, scopes: ['agents:read'] }),
        true
    )
    await assert.rejects(authorize({ scopes: ['agents:read'] }))
    await assert.rejects(
        authorize({ account: true }),
        /agent permission missing scope: one of \[agents:read\]/
    )
})

test('storage scope does not open the rest of runtime-access to runtime identities', async () => {
    await assert.rejects(
        authorize({
            account: true,
            scopes: ['agents:read'],
            handler: 'summary'
        }),
        /api.full/
    )
})

test('current sandbox is free self scope and never authorizes another agent by default', async () => {
    assert.equal(await authorize({ handler: 'agentSandboxUsage' }), true)
    await assert.rejects(
        authorize({
            handler: 'agentSandboxUsage',
            agentId: 'other-agent',
            scopes: ['agents:read']
        }),
        /token bound/
    )
})

test('human and full-token account storage reads remain available', async () => {
    assert.equal(await authorize({ kind: 'human-session' }), true)
    assert.equal(
        await authorize({ kind: 'human-api-token', scopes: ['api.full'] }),
        true
    )
    await assert.rejects(
        authorize({ kind: 'human-api-token', scopes: ['chat.completions'] })
    )
})
