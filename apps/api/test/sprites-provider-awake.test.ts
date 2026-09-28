import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesProvider } from '../src/modules/hosts/providers/sprites.provider'

// ADR-0038's awake hold is a /v1/tasks entry inside the sprite, reached with
// `sprite-env curl`, which has no status code to read (it rejects -f, -w and
// -o). The listing after each call is the only proof it took effect.

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

test('a hold that is already there is renewed and proven by the listing, nothing more', async () => {
    const { adapter, scripts } = build([listing([{ name: 'mf-hold-0123abcd' }])])

    await adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' })

    assert.equal(scripts.length, 1)
    assert.match(scripts[0], /-X PUT '\/v1\/tasks\/mf-hold-0123abcd' -d '\{"expire":"30m"\}'/)
    assert.match(scripts[0], /sprite-env curl -s \/v1\/tasks$/)
    assert.doesNotMatch(scripts[0], /-X POST/)
})

test('a hold that is not there yet is created after the renew finds nothing', async () => {
    const { adapter, scripts } = build([
        listing([]),
        listing([{ name: 'mf-hold-0123abcd' }])
    ])

    await adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' })

    assert.equal(scripts.length, 2)
    assert.match(scripts[1], /-X POST \/v1\/tasks -d '\{"name":"mf-hold-0123abcd","expire":"30m"\}'/)
})

// WHY: a create that silently failed used to read as a hold, so the machine
// could suspend under the work it was meant to keep awake.
test('a hold the listing never shows fails loudly', async () => {
    const { adapter } = build([listing([{ name: 'someone-else' }]), listing([])])

    await assert.rejects(
        adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' }),
        /not listed after create-or-renew/
    )
})

// WHY: a create against a name that is already listed could leave two under
// it, and one DELETE would release only one.
test('a renewal the listing shows as not extended fails without creating a second', async () => {
    const { adapter, scripts } = build([
        listing([{ name: 'mf-hold-0123abcd', expiresInMs: 5 * 60_000 }])
    ])

    await assert.rejects(
        adapter.holdAwake(call, { name: 'mf-hold-0123abcd', ttl: '30m' }),
        /was not renewed/
    )
    assert.equal(scripts.length, 1)
})

test('a release is done once the listing no longer shows the hold', async () => {
    const { adapter, scripts } = build([listing([])])

    await adapter.releaseAwake(call, { name: 'mf-hold-0123abcd' })

    assert.equal(scripts.length, 1)
    assert.match(scripts[0], /-X DELETE '\/v1\/tasks\/mf-hold-0123abcd'/)
})

// WHY: two creates racing can leave two tasks under one name; one DELETE takes
// only one of them, and the one left would hold the VM for its full TTL.
test('a release repeats while the hold is still listed, then fails loudly', async () => {
    const still = listing([{ name: 'mf-hold-0123abcd' }])
    const twice = build([still, listing([])])
    await twice.adapter.releaseAwake(call, { name: 'mf-hold-0123abcd' })
    assert.equal(twice.scripts.length, 2)

    const stuck = build([still, still, still])
    await assert.rejects(
        stuck.adapter.releaseAwake(call, { name: 'mf-hold-0123abcd' }),
        /still listed after 3 deletes/
    )
})
