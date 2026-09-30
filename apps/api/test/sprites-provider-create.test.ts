import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import { SpritesProvider } from '../src/modules/hosts/providers/sprites.provider'

// A sprite create whose request timed out may still be made by sprites.dev:
// the provider looks for it under the host's name before it gives up.

const host = {
    id: 'sbx_1',
    name: 'sandbox-001',
    generation: 3,
    providerRef: null
}
const provider = { id: 'rtp_1', kind: 'sprites', name: 'org' }

class NoWait extends SpritesProvider {
    protected override delay(): Promise<void> {
        return Promise.resolve()
    }
}

const build = (opts: {
    createError: SpritesError
    // What each GET answers, in turn; null for a 404.
    gets: Array<Record<string, unknown> | null>
}) => {
    const calls: string[] = []
    const refs: unknown[] = []
    const gets = [...opts.gets]
    const client = {
        getSprite: async (name: string) => {
            calls.push(`get ${name}`)
            const found = gets.shift() ?? null
            if (!found)
                throw new SpritesError('not_found', 'sprite not found', 404)
            return found
        },
        createSprite: async ({ name }: { name: string }) => {
            calls.push(`create ${name}`)
            throw opts.createError
        },
        setNetworkPolicy: async (name: string) => {
            calls.push(`policy ${name}`)
        }
    }
    const adapter = new NoWait(
        { register: () => {} } as never,
        {
            findById: async () => host,
            setProviderRef: async (_id: string, ref: unknown) => {
                refs.push(ref)
            }
        } as never,
        {
            spritesClientForProvider: () => client,
            spritesLoggerFor: () => ({
                debug() {},
                info() {},
                warn() {},
                error() {}
            })
        } as never
    )
    const create = () =>
        adapter.create({
            host: host as never,
            provider: provider as never,
            generation: 3,
            spec: { name: 'sandbox-001' } as never
        })
    return { create, calls, refs }
}

const timedOut = new SpritesError(
    'transient',
    'sprites.dev POST /sprites timed out after 15000ms'
)

test('a sprite that comes up after its create timed out is the one used', async () => {
    const h = build({
        createError: timedOut,
        gets: [null, null, { id: 'sp-9', name: 'sbx-sbx_1', url: null }]
    })
    const ref = await h.create()
    assert.equal((ref as { spriteId: string }).spriteId, 'sp-9')
    assert.deepEqual(h.refs, [ref])
    assert.ok(
        h.calls.includes(`policy ${(ref as { spriteName: string }).spriteName}`)
    )
})

test('a create that stays failed gives up after its polls, for the rollback to clean up', async () => {
    const h = build({ createError: timedOut, gets: [] })
    await assert.rejects(h.create(), /timed out after 15000ms/)
    // The check before the create, then one per poll.
    assert.equal(h.calls.filter((call) => call.startsWith('get ')).length, 7)
    assert.deepEqual(h.refs, [])
})

test('a create sprites.dev refused outright is not waited on', async () => {
    const h = build({
        createError: new SpritesError('permanent', 'name taken', 422),
        gets: []
    })
    await assert.rejects(h.create(), /name taken/)
    assert.equal(h.calls.filter((call) => call.startsWith('get ')).length, 1)
})
