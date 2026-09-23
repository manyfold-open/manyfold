import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '../src/client'

test('the authenticated status stream dispatches resource changes', async () => {
    const events = [
        'automation',
        'channel',
        'skill',
        'skill-library',
        'connection',
        'agent',
        'model-config',
        'file',
        'backup'
    ].map((resource) => ({
        type: 'resource-changed',
        resource,
        ...(resource === 'file' ? {} : { resourceId: 'resource-1' }),
        ...(['connection', 'skill-library'].includes(resource)
            ? {}
            : { agentId: 'agent-1' }),
        reason: 'created',
        at: new Date().toISOString()
    }))
    const received: unknown[] = []
    let closed!: () => void
    const finished = new Promise<void>((resolve) => {
        closed = resolve
    })
    const client = createClient({
        baseUrl: 'https://api.example.test/api',
        token: 'test-token',
        fetch: async (input, init) => {
            assert.equal(
                String(input),
                'https://api.example.test/api/agents/sprite-status/stream'
            )
            assert.equal(
                new Headers(init?.headers).get('authorization'),
                'Bearer test-token'
            )
            return new Response(
                events
                    .map(
                        (event) =>
                            `event: resource-changed\ndata: ${JSON.stringify(event)}\n\n`
                    )
                    .join(''),
                {
                    headers: { 'content-type': 'text/event-stream' }
                }
            )
        }
    })
    const handle = client.agents.streamSpriteStatus({
        onResourceChanged: (value) => received.push(value),
        onClose: closed,
        onError: (error) => {
            throw error
        }
    })
    await finished
    handle.close()
    assert.deepEqual(received, events)
})
