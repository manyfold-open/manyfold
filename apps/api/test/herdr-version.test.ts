import test from 'node:test'
import assert from 'node:assert/strict'
import { HerdrVersionService } from '../src/modules/daemon/herdr-version.service'

// The newest herdr release, for the Update Center (ADR-0031): one manifest
// fetch shared by every host and sandbox summary, and a comparison that
// only ever points forward.

const service = (
    responses: Array<{ ok: boolean; body?: unknown }>
): { service: HerdrVersionService; fetches: string[] } => {
    const fetches: string[] = []
    const queue = [...responses]
    globalThis.fetch = (async (input: string | URL | Request) => {
        fetches.push(String(input))
        const next = queue.shift() ?? { ok: false }
        return {
            ok: next.ok,
            status: next.ok ? 200 : 503,
            json: async () => next.body
        } as Response
    }) as typeof fetch
    return {
        service: new HerdrVersionService({
            get: () => 'https://manifest.test/latest.json'
        } as never),
        fetches
    }
}

const realFetch = globalThis.fetch
test.afterEach(() => {
    globalThis.fetch = realFetch
})

test('an update is offered only for a strictly newer release', () => {
    assert.equal(HerdrVersionService.updateAvailable('0.9.0', '0.9.1'), true)
    assert.equal(HerdrVersionService.updateAvailable('0.9.1', '0.9.1'), false)
    // A preview build ahead of the manifest is left alone.
    assert.equal(HerdrVersionService.updateAvailable('0.10.0', '0.9.1'), false)
    assert.equal(
        HerdrVersionService.updateAvailable('0.9.1-beta.2', '0.9.1'),
        true
    )
    // Nothing installed is an install, decided by the caller, not an update.
    assert.equal(HerdrVersionService.updateAvailable(null, '0.9.1'), false)
    assert.equal(HerdrVersionService.updateAvailable('0.9.0', null), false)
})

test('the manifest is read once and served from cache afterwards', async () => {
    const h = service([{ ok: true, body: { version: '0.9.1' } }])
    assert.deepEqual(await h.service.getCachedLatest(), { version: '0.9.1' })
    assert.deepEqual(await h.service.getCachedLatest(), { version: '0.9.1' })
    assert.deepEqual(h.fetches, ['https://manifest.test/latest.json'])
})

test('a manifest that fails or says nothing usable yields no latest version', async () => {
    const down = service([{ ok: false }])
    assert.deepEqual(await down.service.getCachedLatest(), { version: null })
    const odd = service([{ ok: true, body: { version: 42 } }])
    assert.deepEqual(await odd.service.getCachedLatest(), { version: null })
})
