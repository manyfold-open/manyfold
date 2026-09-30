import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'
import { ChannelsController } from '../src/modules/channels/channels.controller'

const user = { kind: 'user', userId: 'user-1' } as unknown as AuthPrincipal

test('a new channel session without a scopeKey is a bad request, not a missing channel', () => {
    let created = 0
    const controller = new ChannelsController(
        {
            createChannelSession: async () => {
                created += 1
                return {}
            }
        } as never,
        { isEnabled: () => true } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    for (const body of [{}, { scopeKey: 42 }, null])
        assert.throws(
            () => controller.createSession(user, 'chn-1', body as never),
            BadRequestException
        )
    assert.equal(created, 0)
})
