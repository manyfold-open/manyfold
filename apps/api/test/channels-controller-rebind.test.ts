import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'
import { ChannelsController } from '../src/modules/channels/channels.controller'
import type { UpdateChannelDto } from '../src/modules/channels/dto/channels.dto'

const makeController = (): {
    controller: ChannelsController
    updates: Array<{ userId: string; id: string; dto: UpdateChannelDto }>
} => {
    const updates: Array<{
        userId: string
        id: string
        dto: UpdateChannelDto
    }> = []
    const controller = new ChannelsController(
        {
            update: async (
                userId: string,
                id: string,
                dto: UpdateChannelDto
            ) => {
                updates.push({ userId, id, dto })
                return {}
            }
        } as never,
        { isEnabled: () => true } as never,
        {} as never,
        {} as never,
        {} as never
    )
    return { controller, updates }
}

const boundUser: AuthPrincipal = {
    kind: 'agent-runtime',
    userId: 'user-1',
    agentId: 'agent-1',
    runtimeTokenId: 'tok-1'
}

const humanUser: AuthPrincipal = {
    kind: 'human-session',
    userId: 'user-1',
    provider: 'email',
    subject: 'subject-1'
}

test('agent-bound tokens cannot rebind a channel to another agent', async () => {
    const h = makeController()

    await assert.rejects(
        async () =>
            h.controller.update(boundUser, 'chn-1', {
                agentId: 'agent-2'
            } as UpdateChannelDto),
        ForbiddenException
    )
    assert.equal(h.updates.length, 0)
})

test('agent-bound tokens may still send their own agentId (no-op rebind)', async () => {
    const h = makeController()

    await h.controller.update(boundUser, 'chn-1', {
        agentId: 'agent-1'
    } as UpdateChannelDto)

    assert.equal(h.updates.length, 1)
    assert.equal(h.updates[0]?.dto.agentId, 'agent-1')
})

test('human principals may rebind a channel to another agent', async () => {
    const h = makeController()

    await h.controller.update(humanUser, 'chn-1', {
        agentId: 'agent-2'
    } as UpdateChannelDto)

    assert.equal(h.updates.length, 1)
    assert.equal(h.updates[0]?.dto.agentId, 'agent-2')
})
