import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthController } from '../src/modules/auth/auth.controller'

test('AuthController whoami reports runtime identity without account profile fields', async () => {
    let userLookups = 0
    const controller = new AuthController(
        {
            upsertUser: async () => {
                userLookups += 1
                throw new Error('runtime whoami should not load user profile')
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    const res = await controller.whoami({
        kind: 'agent-runtime',
        userId: 'user-1',
        agentId: 'agt_A',
        runtimeTokenId: 'rtk_1'
    } as never)

    assert.deepEqual(res, {
        kind: 'agent-runtime',
        userId: 'user-1',
        agentId: 'agt_A'
    })
    assert.equal(userLookups, 0)
})
