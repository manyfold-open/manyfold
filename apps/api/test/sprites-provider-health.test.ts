import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import {
    SpritesProvider,
    spriteHealthVerdict
} from '../src/modules/hosts/providers/sprites.provider'

// sprites.dev's health check takes the sprite's name — its id answers 404 —
// and answers a status of its own. What the platform acts on is the verdict
// mapped from it, so the mapping and the name are what is pinned here.

const host = {
    id: 'sbx_1',
    kind: 'hosted',
    providerRef: {
        kind: 'sprites',
        spriteName: 'sbx-1',
        spriteId: 'sprite-da10be4f-8a36-4a08-8914-cab1da8c452a'
    }
}
const provider = { id: 'rtp_1', kind: 'sprites', name: 'org' }

const build = (checkSprite: (name: string) => Promise<unknown>) => {
    const asked: string[] = []
    const clients = {
        spritesLoggerFor: () => ({
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {}
        }),
        spritesClientForProvider: () => ({
            checkSprite: async (name: string) => {
                asked.push(name)
                return checkSprite(name)
            }
        })
    }
    const adapter = new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        clients as never
    )
    return { adapter, asked }
}

const call = { host: host as never, provider: provider as never }

test('the verdicts sprites.dev answered map to the host vocabulary; anything else is unknown', () => {
    assert.equal(spriteHealthVerdict('healthy'), 'healthy')
    assert.equal(spriteHealthVerdict('unhealthy'), 'unhealthy')
    assert.equal(spriteHealthVerdict('needs_repair'), 'needs_repair')
    assert.equal(spriteHealthVerdict('repaired'), 'repaired')
    // An unseen literal is a problem until a check says healthy, never a guess.
    assert.equal(spriteHealthVerdict('ok'), 'unknown')
    assert.equal(spriteHealthVerdict(''), 'unknown')
    assert.equal(spriteHealthVerdict(undefined), 'unknown')
})

test('a check asks by the sprite name and keeps what the provider said', async () => {
    const { adapter, asked } = build(async () => ({
        status: 'unhealthy',
        reason: 'failed to start machine',
        sprite_name: 'sbx-1',
        sprite_id: 'sprite-da10be4f-8a36-4a08-8914-cab1da8c452a',
        elapsed: 1000,
        checked_at: '2026-10-08T11:20:54.176150Z'
    }))

    const report = await adapter.checkHealth(call)

    assert.deepEqual(asked, ['sbx-1'])
    assert.deepEqual(report, {
        verdict: 'unhealthy',
        rawStatus: 'unhealthy',
        reason: 'failed to start machine',
        elapsedMs: 1000
    })
})

test('an unrecognised status is reported as unknown with the literal kept', async () => {
    const { adapter } = build(async () => ({ status: 'quarantined' }))

    const report = await adapter.checkHealth(call)

    assert.deepEqual(report, {
        verdict: 'unknown',
        rawStatus: 'quarantined',
        reason: null,
        elapsedMs: null
    })
})

test('a sprite the provider no longer has is gone; any other failure is the caller\'s to handle', async () => {
    const gone = build(async () => {
        throw new SpritesError('not_found', 'sprite not found', 404)
    })
    assert.equal(await gone.adapter.checkHealth(call), 'gone')

    const faulty = build(async () => {
        throw new SpritesError('transient', 'bad gateway', 502)
    })
    await assert.rejects(faulty.adapter.checkHealth(call), SpritesError)
})
