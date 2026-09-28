import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesProvider } from '../src/modules/hosts/providers/sprites.provider'

// ADR-0038's awake hold is a /v1/tasks entry inside the sprite, reached with
// `sprite-env curl`. A PUT creates or renews it (measured on a real sprite), and
// the listing after the call is the proof it took effect.

const host = {
    id: 'sbx_1',
    kind: 'hosted',
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sp-1' }
}
const provider = { id: 'rtp_1', kind: 'sprites', name: 'org' }

const listing = (tasks: Array<{ name: string; expiresInMs?: number }>) =>
    JSON.stringify({
        tasks: tasks.map((task) => ({
            name: task.name,
            started_at: new Date().toISOString(),
            expires_at: new Date(
                Date.now() + (task.expiresInMs ?? 30 * 60_000)
            ).toISOString()
        }))
    })

const build = (stdouts: string[]) => {
    const scripts: string[] = []
    const clients = {
        spritesLoggerFor: () => ({
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {}
        }),
        spriteExecForHost: async () => async (args: { cmd: string[] }) => {
            scripts.push(args.cmd[2] ?? '')
            return { exitCode: 0, stdout: stdouts.shift() ?? '', stderr: '' }
        }
    }
    const adapter = new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        clients as never
    )
    return { adapter, scripts }
}

const call = { host: host as never, provider: provider as never }

test('a hold is one PUT, proven by the listing after it', async () => {
    const { adapter, scripts } = build([listing([{ name: 'mf-hold-0123abcd' }])])

    await adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' })

    assert.equal(scripts.length, 1)
    assert.match(scripts[0], /-X PUT '\/v1\/tasks\/mf-hold-0123abcd' -d '\{"expire":"30m"\}'/)
    assert.match(scripts[0], /sprite-env curl -s \/v1\/tasks$/)
    assert.doesNotMatch(scripts[0], /-X POST/)
})

// WHY: a hold that did not take used to read as one, so the machine could
// suspend under the work it was meant to keep awake.
test('a hold the listing does not show fails loudly', async () => {
    const { adapter } = build([listing([{ name: 'someone-else' }])])

    await assert.rejects(
        adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' }),
        /not listed after its renew/
    )
})

test('output that is not a listing is not a hold', async () => {
    const { adapter } = build(['curl: (7) Failed to connect'])

    await assert.rejects(
        adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' }),
        /not listed after its renew/
    )
})

test('a renewal the listing shows as not extended fails loudly', async () => {
    const { adapter } = build([
        listing([{ name: 'mf-hold-0123abcd', expiresInMs: 5 * 60_000 }])
    ])

    await assert.rejects(
        adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' }),
        /was not renewed/
    )
})

test('a release is done once the listing no longer shows the hold', async () => {
    const { adapter, scripts } = build([listing([])])

    await adapter.releaseAwake(call, { name: 'mf-hold-0123abcd' })

    assert.equal(scripts.length, 1)
    assert.match(scripts[0], /-X DELETE '\/v1\/tasks\/mf-hold-0123abcd'/)
})

// WHY: a hold left behind keeps the VM running, and billed, for its full TTL.
test('a release the listing still shows fails loudly', async () => {
    const { adapter } = build([listing([{ name: 'mf-hold-0123abcd' }])])

    await assert.rejects(
        adapter.releaseAwake(call, { name: 'mf-hold-0123abcd' }),
        /still listed after its delete/
    )
})
