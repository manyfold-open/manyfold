import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import {
    createResourceRefresh,
    matchesResourceChange,
    publishResourceChanged,
    subscribeResourceChanges
} from '../src/lib/resourceChanges'

test('invalidations received during an in-flight read trigger one final read', async () => {
    let calls = 0
    let release!: () => void
    const first = new Promise<void>((resolve) => {
        release = resolve
    })
    const queue = createResourceRefresh(async () => {
        calls++
        if (calls === 1) await first
    }, 0)
    queue.request()
    await wait(10)
    queue.request()
    queue.request()
    assert.equal(calls, 1)
    release()
    await wait(10)
    assert.equal(calls, 2)
    queue.dispose()
})

test('disposal cancels queued and subsequent refresh work', async () => {
    let calls = 0
    const queue = createResourceRefresh(async () => {
        calls++
    }, 0)
    queue.request()
    queue.dispose()
    queue.request()
    await wait(10)
    assert.equal(calls, 0)
})

test('resource subscriptions carry reconnect invalidation and unsubscribe', () => {
    const received: unknown[] = []
    const unsubscribe = subscribeResourceChanges((event) =>
        received.push(event)
    )
    publishResourceChanged({ resource: 'automation', resourceId: 'auto-1' })
    publishResourceChanged({ resource: 'automation' })
    unsubscribe()
    publishResourceChanged({ resource: 'automation', resourceId: 'auto-2' })
    assert.deepEqual(received, [
        { resource: 'automation', resourceId: 'auto-1' },
        { resource: 'automation' }
    ])
})

test('invalidation matches the resource and agent, with collection and reconnect fallbacks', () => {
    const event = {
        resource: 'skill' as const,
        resourceId: 'install-1',
        agentId: 'agent-1'
    }
    assert.equal(
        matchesResourceChange(event, 'skill', undefined, 'agent-1'),
        true
    )
    assert.equal(
        matchesResourceChange(event, 'skill', undefined, 'agent-2'),
        false
    )
    assert.equal(matchesResourceChange(event, 'skill', 'install-2'), false)
    assert.equal(matchesResourceChange(event, 'channel'), false)
    assert.equal(
        matchesResourceChange(
            { resource: 'file', agentId: 'agent-1' },
            'file',
            undefined,
            'agent-2'
        ),
        false
    )
    assert.equal(
        matchesResourceChange(
            { resource: 'connection' },
            'connection',
            'conn-1'
        ),
        true
    )
    assert.equal(
        matchesResourceChange(
            { resource: 'channel', resourceId: 'channel-1' },
            'channel',
            undefined,
            'old-agent'
        ),
        true
    )
    for (const resource of [
        'automation',
        'channel',
        'skill',
        'skill-library',
        'connection',
        'agent',
        'model-config',
        'file',
        'backup'
    ] as const)
        assert.equal(
            matchesResourceChange({ resource: '*' }, resource, 'id', 'agent'),
            true
        )
})
