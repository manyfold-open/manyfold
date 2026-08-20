import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'
import { GrantsController } from '../src/modules/auth/grants.controller'

const user: AuthPrincipal = {
    kind: 'human-session',
    userId: 'user-1',
    email: 'user@example.com',
    provider: 'email',
    subject: 'user-1'
}

interface FakeService {
    mintGrant: (args: unknown) => Promise<unknown>
    mintArgs: unknown[]
    mintThrows?: Error
    nextTokenId?: string
}

const makeService = (overrides: Partial<FakeService> = {}): FakeService => {
    const svc: FakeService = {
        mintArgs: [],
        ...overrides,
        mintGrant: async (args: unknown): Promise<unknown> => {
            svc.mintArgs.push(args)
            if (svc.mintThrows) throw svc.mintThrows
            const argRec = args as {
                agentId: string
                scopes: string[]
                createdVia: string
                enforceAgentBinding: boolean
            }
            return {
                tokenId: svc.nextTokenId ?? 'pat_new',
                plaintext: 'nca_plaintext',
                expiresAt: null,
                scopes: argRec.scopes,
                agentId: argRec.agentId,
                enforceAgentBinding: argRec.enforceAgentBinding,
                createdVia: argRec.createdVia
            }
        }
    }
    return svc
}

test('GrantsController.addPermission mints token with user-grant createdVia and default enforceAgentBinding=true', async () => {
    const svc = makeService()
    const controller = new GrantsController(svc as never)

    const res = await controller.addPermission(user, 'agt_A', {
        approvedScopes: ['channels:edit', 'channels:read']
    })

    assert.equal(res.token, 'nca_plaintext')
    assert.equal(res.tokenId, 'pat_new')
    assert.equal(res.agentId, 'agt_A')
    assert.equal(res.enforceAgentBinding, true)
    assert.equal(res.createdVia, 'user-grant')
    assert.equal(res.expiresAt, null)
    assert.deepEqual(res.scopes, ['channels:edit', 'channels:read'])

    assert.equal(svc.mintArgs.length, 1)
    assert.deepEqual(svc.mintArgs[0], {
        userId: 'user-1',
        agentId: 'agt_A',
        scopes: ['channels:edit', 'channels:read'],
        name: undefined,
        createdVia: 'user-grant',
        enforceAgentBinding: true,
        replaceExisting: false
    })
})

test('GrantsController.addPermission respects explicit enforceAgentBinding=false', async () => {
    const svc = makeService()
    const controller = new GrantsController(svc as never)

    const res = await controller.addPermission(user, 'agt_A', {
        approvedScopes: ['channels:read'],
        enforceAgentBinding: false
    })

    assert.equal(res.enforceAgentBinding, false)
    const args = svc.mintArgs[0] as { enforceAgentBinding: boolean }
    assert.equal(args.enforceAgentBinding, false)
})

test('GrantsController.addPermission trims and forwards optional name', async () => {
    const svc = makeService()
    const controller = new GrantsController(svc as never)

    await controller.addPermission(user, 'agt_A', {
        approvedScopes: ['channels:read'],
        name: '  custom label  '
    })
    await controller.addPermission(user, 'agt_A', {
        approvedScopes: ['channels:read'],
        name: ''
    })

    const first = svc.mintArgs[0] as { name?: string }
    const second = svc.mintArgs[1] as { name?: string }
    assert.equal(first.name, 'custom label')
    assert.equal(second.name, undefined)
})

test('GrantsController.addPermission rejects empty scopes', async () => {
    const svc = makeService()
    const controller = new GrantsController(svc as never)
    await assert.rejects(
        () =>
            controller.addPermission(user, 'agt_A', {
                approvedScopes: []
            }),
        BadRequestException
    )
    assert.equal(svc.mintArgs.length, 0)
})

test('GrantsController.addPermission rejects non-grantable scopes (api.full / chat.completions)', async () => {
    const svc = makeService()
    const controller = new GrantsController(svc as never)
    await assert.rejects(
        () =>
            controller.addPermission(user, 'agt_A', {
                approvedScopes: ['api.full' as never]
            }),
        BadRequestException
    )
    await assert.rejects(
        () =>
            controller.addPermission(user, 'agt_A', {
                approvedScopes: ['chat.completions' as never]
            }),
        BadRequestException
    )
})

test('GrantsController.addPermission rejects unknown scope', async () => {
    const svc = makeService()
    const controller = new GrantsController(svc as never)
    await assert.rejects(
        () =>
            controller.addPermission(user, 'agt_A', {
                approvedScopes: ['nonsense:read' as never]
            }),
        BadRequestException
    )
})

test('GrantsController.addPermission surfaces NotFound from service', async () => {
    const svc = makeService({
        mintThrows: new NotFoundException(
            'agent not owned by user or not found'
        )
    })
    const controller = new GrantsController(svc as never)
    await assert.rejects(
        () =>
            controller.addPermission(user, 'agt_missing', {
                approvedScopes: ['channels:read']
            }),
        NotFoundException
    )
})

test('GrantsController.addPermission surfaces Conflict from service', async () => {
    const svc = makeService({
        mintThrows: new ConflictException('active grant exists')
    })
    const controller = new GrantsController(svc as never)
    await assert.rejects(
        () =>
            controller.addPermission(user, 'agt_A', {
                approvedScopes: ['channels:read']
            }),
        ConflictException
    )
})
