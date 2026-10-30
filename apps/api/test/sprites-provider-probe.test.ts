import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesProvider } from '../src/modules/hosts/providers/sprites.provider'

// The probe an admin runs on a sprites provider lists the account. A listing
// that stopped early still proves the credential works, and says how much of
// the account it saw rather than passing a partial count off as the total.

const probe = (listing: Record<string, unknown>) =>
    new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        {
            spritesClientForProvider: () => ({
                listSprites: async () => listing
            }),
            spritesLoggerFor: () => ({
                debug() {},
                info() {},
                warn() {},
                error() {}
            })
        } as never
    ).checkCredential({ id: 'rtp_1', kind: 'sprites', name: 'org' } as never)

test('a full listing reports how many sprites the account holds', async () => {
    const health = await probe({
        sprites: [{ name: 'a' }, { name: 'b' }],
        truncated: false
    })
    assert.deepEqual(health, {
        ok: true,
        message: 'reachable (listed 2 sprites)'
    })
})

test('a listing that stopped early says it saw at least that many', async () => {
    const health = await probe({ sprites: [{ name: 'a' }], truncated: true })
    assert.deepEqual(health, {
        ok: true,
        message:
            'reachable (listed at least 1 sprite; the listing stopped early)'
    })
})
