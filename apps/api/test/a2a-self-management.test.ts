import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { A2aSelfController } from '../src/modules/a2a/a2a-self.controller'
import { A2aSelfService } from '../src/modules/a2a/a2a-self.service'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'
import { SUBJECT_AGENT_META } from '../src/common/decorators/subject-agent.decorator'

const humanUser = {
    kind: 'human-api-token',
    userId: 'u1',
    tokenId: 'pat',
    scopes: ['a2a:read', 'a2a:edit']
} as never

const agentUser = {
    kind: 'agent-runtime',
    userId: 'u1',
    agentId: 'agt_self',
    runtimeTokenId: 'rt1'
} as never

const externalCaller = {
    kind: 'legacy-runtime',
    userId: 'u1',
    agentId: 'agt_target',
    tokenId: 'pat_external',
    tokenKind: 'a2a-grant',
    scopes: ['a2a:edit'],
    callerAgentId: null,
    enforceAgentBinding: true,
    createdVia: 'api'
} as never

const scopeOf = (method: keyof A2aSelfController): string[] | undefined =>
    Reflect.getMetadata(
        REQUIRED_API_TOKEN_SCOPES_META,
        A2aSelfController.prototype[method]
    ) as string[] | undefined

test('agent-self A2A management declares read and edit scopes per operation', () => {
    assert.deepEqual(scopeOf('exposure'), ['a2a:read'])
    assert.deepEqual(scopeOf('callers'), ['a2a:read'])
    assert.deepEqual(scopeOf('setExposure'), ['a2a:edit'])
    assert.deepEqual(scopeOf('addCaller'), ['a2a:edit'])
    assert.deepEqual(scopeOf('revokeCaller'), ['a2a:edit'])
    assert.equal(
        (
            Reflect.getMetadata(
                SUBJECT_AGENT_META,
                A2aSelfController.prototype.addCaller
            ) as { type: string }
        ).type,
        'allowlisted'
    )
})

const makeController = (owned: string[] = []) => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const self = {
        exposureView: (agentId: string, exposure: { enabled: boolean }) => ({
            agentId,
            ...exposure,
            cardUrl: `https://api.test/a2a/agents/${agentId}/agent-card.json`,
            rpcUrl: `https://api.test/a2a/agents/${agentId}/rpc`
        }),
        listCallers: async (...args: unknown[]) => {
            calls.push({ name: 'listCallers', args })
            return []
        },
        addCaller: async (...args: unknown[]) => {
            calls.push({ name: 'addCaller', args })
            const body = args[2] as
                | { kind: 'external' }
                | { kind: 'peer'; callerAgentId: string }
            return body.kind === 'external'
                ? {
                      kind: 'external',
                      agentId: args[1],
                      token: 'nca_secret',
                      tokenId: 'pat_external',
                      scopes: ['a2a:edit'],
                      callerAgentId: null,
                      expiresAt: null,
                      cardUrl: 'https://api.test/card',
                      rpcUrl: 'https://api.test/rpc'
                  }
                : {
                      kind: 'peer',
                      agentId: args[1],
                      callerAgentId: body.callerAgentId,
                      tokenId: 'pat_peer',
                      expiresAt: null
                  }
        },
        revokeCaller: async (...args: unknown[]) => {
            calls.push({ name: 'revokeCaller', args })
        }
    }
    const a2a = {
        assertOwner: async (agentId: string) => {
            calls.push({ name: 'assertOwner', args: [agentId] })
            if (!owned.includes(agentId)) throw new Error('agent not found')
        },
        getExposure: async (agentId: string) => {
            calls.push({ name: 'getExposure', args: [agentId] })
            return { enabled: true }
        },
        setExposure: async (...args: unknown[]) => {
            calls.push({ name: 'setExposure', args })
            return { enabled: (args[1] as { enabled: boolean }).enabled }
        }
    }
    return {
        controller: new A2aSelfController(self as never, a2a as never),
        calls
    }
}

test('runtime management ignores a supplied agentId and stays self-bound', async () => {
    const { controller, calls } = makeController(['agt_other'])
    const result = await controller.setExposure(
        agentUser,
        { enabled: true },
        'agt_other'
    )
    assert.equal(result.agentId, 'agt_self')
    const call = calls.find((item) => item.name === 'setExposure')
    assert.deepEqual(call?.args, ['agt_self', { enabled: true }])
    assert.equal(
        calls.some((item) => item.name === 'assertOwner'),
        false
    )
})

test('human management requires and verifies an owned agent context', async () => {
    const { controller, calls } = makeController(['agt_owned'])
    const result = await controller.exposure(humanUser, 'agt_owned')
    assert.equal(result.agentId, 'agt_owned')
    assert.deepEqual(calls.find((item) => item.name === 'assertOwner')?.args, [
        'agt_owned'
    ])
    await assert.rejects(
        () => controller.exposure(humanUser, undefined),
        /agent context/
    )
})

test('an External client caller token cannot manage the target agent', async () => {
    const { controller } = makeController()
    await assert.rejects(
        () => controller.setExposure(externalCaller, { enabled: false }),
        /caller grants cannot manage/
    )
})

test('add caller normalizes valid bodies and rejects mixed caller modes', async () => {
    const { controller, calls } = makeController()
    const result = await controller.addCaller(
        agentUser,
        {
            kind: 'external',
            name: '  zapier  ',
            expiresInDays: 7
        },
        undefined
    )
    assert.equal(result.kind, 'external')
    assert.deepEqual(calls.find((item) => item.name === 'addCaller')?.args, [
        'u1',
        'agt_self',
        { kind: 'external', name: 'zapier', expiresInDays: 7 }
    ])
    await assert.rejects(
        () =>
            controller.addCaller(
                agentUser,
                {
                    kind: 'external',
                    callerAgentId: 'agt_peer'
                } as never,
                undefined
            ),
        /do not accept callerAgentId/
    )
})

test('revoke caller keeps the target agent in the service boundary', async () => {
    const { controller, calls } = makeController()
    await controller.revokeCaller(agentUser, 'pat_1', 'agt_other')
    assert.deepEqual(calls.find((item) => item.name === 'revokeCaller')?.args, [
        'u1',
        'agt_self',
        'pat_1'
    ])
})

test('A2aSelfService returns plaintext only for an external caller', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const tokens = {
        mintA2aGrant: async (args: unknown) => {
            calls.push({ name: 'mintA2aGrant', args: [args] })
            return {
                plaintext: 'nca_external_secret',
                tokenId: 'pat_external',
                scopes: ['a2a:edit'],
                expiresAt: null
            }
        },
        mintA2aGrants: async (args: unknown) => {
            calls.push({ name: 'mintA2aGrants', args: [args] })
            return [
                {
                    callerAgentId: 'agt_peer',
                    tokenId: 'pat_peer',
                    expiresAt: null
                }
            ]
        }
    }
    const config = {
        get: () => 'https://api.test/api'
    }
    const service = new A2aSelfService(
        {} as never,
        tokens as never,
        {} as never,
        config as never
    )

    const external = await service.addCaller('u1', 'agt_target', {
        kind: 'external',
        name: 'zapier'
    })
    assert.equal(external.kind, 'external')
    assert.equal(external.token, 'nca_external_secret')
    assert.equal(
        external.rpcUrl,
        'https://api.test/api/a2a/agents/agt_target/rpc'
    )

    const peer = await service.addCaller('u1', 'agt_target', {
        kind: 'peer',
        callerAgentId: 'agt_peer'
    })
    assert.equal(peer.kind, 'peer')
    assert.equal('token' in peer, false)
    assert.equal(calls[1].name, 'mintA2aGrants')
})
