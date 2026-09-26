import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResourceChangedEvent } from '@manyfold/shared'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'
import { ResourceChangesService } from '../src/modules/resource-events/resource-changes.service'
import { SpriteStatusBroadcaster } from '../src/modules/agents/sprite-status/sprite-status-broadcaster'

test('channel writes notify the persisted owner after commit, and rejected writes emit nothing', async () => {
    const published: { owner: string; event: ResourceChangedEvent }[] = []
    let committed = false
    let fail = false
    const row = { id: 'channel-1', userId: 'owner', agentId: 'agent-1' }
    const changes = new ResourceChangesService(
        new SpriteStatusBroadcaster({
            onEvent: () => {},
            publish: (owner: string, event: ResourceChangedEvent) => {
                assert.equal(committed, true)
                published.push({ owner, event })
            }
        } as never)
    )
    const returning = async () => {
        if (fail) throw new Error('write rejected')
        committed = true
        return [row]
    }
    const repo = new ChannelsRepository(
        {
            insert: () => ({ values: () => ({ returning }) }),
            update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
            delete: () => ({ where: () => ({ returning }) })
        } as never,
        changes
    )
    await repo.insert(row as never)
    await repo.update(row.id, { label: 'renamed' })
    await repo.delete(row.id)
    assert.deepEqual(
        published.map(({ owner, event }) => [
            owner,
            event.resource,
            event.reason
        ]),
        [
            ['owner', 'channel', 'created'],
            ['owner', 'channel', 'updated'],
            ['owner', 'channel', 'deleted'],
            ['owner', 'automation', 'updated']
        ]
    )
    fail = true
    committed = false
    await assert.rejects(
        repo.update(row.id, { label: 'rejected' }),
        /write rejected/
    )
    assert.equal(published.length, 4)
})

test('resource signals whitelist identifiers, excluding contents and credentials', () => {
    let event: Record<string, unknown> | undefined
    const changes = new ResourceChangesService(
        new SpriteStatusBroadcaster({
            onEvent: () => {},
            publish: (_owner: string, value: Record<string, unknown>) => {
                event = value
            }
        } as never)
    )
    changes.emit('owner', {
        resource: 'connection',
        resourceId: 'connection-1',
        reason: 'updated',
        token: 'must-not-leak',
        content: 'private'
    } as never)
    assert.equal(event?.resource, 'connection')
    assert.equal(event?.token, undefined)
    assert.equal(event?.content, undefined)
    assert.equal(event?.agentId, undefined)
})
