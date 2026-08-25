import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
    createWhatsappAuthStore,
    deserializeWhatsappAuth,
    serializeWhatsappAuth,
    waCloseCode,
    WA_LOGGED_OUT,
    WA_RESTART_REQUIRED,
    type WhatsappAuthSnapshot
} from '../src/modules/channels/providers/whatsapp-baileys'

// The debounce inside the store is 400ms; every wait here clears it with room
// to spare so a slow machine cannot make these flake.
const SETTLE_MS = 700

const collectStore = async (
    initial: WhatsappAuthSnapshot | null = null
): Promise<{
    store: Awaited<ReturnType<typeof createWhatsappAuthStore>>
    writes: WhatsappAuthSnapshot[]
}> => {
    const writes: WhatsappAuthSnapshot[] = []
    const store = await createWhatsappAuthStore({
        load: async () => initial,
        save: async (snapshot) => {
            // Structured-clone the record so a later mutation of the live
            // object cannot rewrite what this write observed.
            writes.push(JSON.parse(JSON.stringify(snapshot)))
        }
    })
    return { store, writes }
}

test('a fresh store mints usable creds', async () => {
    const { store } = await collectStore()
    assert.ok(store.state.creds)
    assert.equal(store.state.creds.registered, false)
    store.stop()
})

test('key writes coalesce instead of one write per rotation', async () => {
    const { store, writes } = await collectStore()
    for (let i = 0; i < 20; i += 1)
        await store.state.keys.set({
            'pre-key': { [`k${i}`]: { public: new Uint8Array([i]) } }
        } as never)
    await store.flush()
    // Baileys rotates Signal keys in bursts; without coalescing this would be
    // one database round trip per key and the row would be rewritten 20 times.
    assert.equal(writes.length, 1)
    assert.equal(Object.keys(writes[0].keys['pre-key']).length, 20)
    store.stop()
})

test('flush lands pending writes without waiting out the debounce', async () => {
    const { store, writes } = await collectStore()
    await store.state.keys.set({
        session: { s1: { some: 'value' } }
    } as never)
    // Nothing has been written yet — the debounce timer is still pending.
    assert.equal(writes.length, 0)
    await store.flush()
    assert.equal(writes.length, 1)
    store.stop()
})

test('the debounce timer eventually writes on its own', async () => {
    const { store, writes } = await collectStore()
    await store.state.keys.set({ session: { s1: { a: 1 } } } as never)
    await delay(SETTLE_MS)
    assert.equal(writes.length, 1)
    store.stop()
})

test('stop halts further persistence so a torn-down socket cannot resurrect state', async () => {
    const { store, writes } = await collectStore()
    store.stop()
    await store.state.keys.set({ session: { s1: { a: 1 } } } as never)
    await delay(SETTLE_MS)
    assert.equal(writes.length, 0)
})

test('a save failure is reported rather than crashing the socket', async () => {
    const errors: Error[] = []
    const store = await createWhatsappAuthStore({
        load: async () => null,
        save: async () => {
            throw new Error('db down')
        },
        onError: (err) => errors.push(err)
    })
    await store.state.keys.set({ session: { s1: { a: 1 } } } as never)
    await store.flush()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'db down')
    store.stop()
})

// Baileys mutates `creds` in place and announces it through `creds.update`,
// which never goes through the key store. Seen on local self-host [2026-08-25]:
// a creds-only rotation left the snapshot null, so a paired session risked
// being persisted with no Signal keys at all.
test('touch persists a creds-only rotation that never touched a key', async () => {
    const { store, writes } = await collectStore()
    Object.assign(store.state.creds, {
        me: { id: '15550001111:12@s.whatsapp.net', name: 'Agent' }
    })
    store.touch()
    await store.flush()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].creds.me?.id, '15550001111:12@s.whatsapp.net')
    store.stop()
})

test('flush without anything pending writes nothing', async () => {
    const { store, writes } = await collectStore()
    await store.flush()
    // Otherwise every creds.update in the provider path would force a row
    // write and the debounce would buy nothing.
    assert.equal(writes.length, 0)
    store.stop()
})

test('a restored store returns the keys it was loaded with', async () => {
    const seeded: WhatsappAuthSnapshot = {
        creds: { registered: true } as never,
        keys: { session: { s1: { marker: 'kept' } } }
    }
    const { store } = await collectStore(seeded)
    const got = await store.state.keys.get('session' as never, ['s1'])
    assert.deepEqual(got, { s1: { marker: 'kept' } })
    store.stop()
})

test('deleting a key removes it rather than storing a null', async () => {
    const seeded: WhatsappAuthSnapshot = {
        creds: { registered: true } as never,
        keys: { session: { s1: { marker: 'kept' } } }
    }
    const { store, writes } = await collectStore(seeded)
    await store.state.keys.set({ session: { s1: null } } as never)
    await store.flush()
    assert.deepEqual(writes[0].keys.session, {})
    const got = await store.state.keys.get('session' as never, ['s1'])
    // A null left in place would be handed back to Baileys as a real session
    // and fail to decrypt instead of triggering a clean re-handshake.
    assert.deepEqual(got, {})
    store.stop()
})

test('binary auth material survives the serialize round trip', async () => {
    const snapshot: WhatsappAuthSnapshot = {
        creds: {
            noiseKey: {
                private: new Uint8Array([1, 2, 3, 250]),
                public: new Uint8Array([9, 8, 7])
            },
            registered: true,
            me: { id: '15550001111:12@s.whatsapp.net', name: 'Agent' }
        } as never,
        keys: { session: { s1: { data: new Uint8Array([4, 5, 6]) } } }
    }
    const restored = await deserializeWhatsappAuth(
        await serializeWhatsappAuth(snapshot)
    )
    const noiseKey = (restored.creds as never as {
        noiseKey: { private: Uint8Array; public: Uint8Array }
    }).noiseKey
    // Plain JSON turns a Uint8Array into {"0":1,"1":2,...}; Baileys then fails
    // every decryption after a restart. This is the guard for that.
    assert.ok(Buffer.isBuffer(noiseKey.private) || noiseKey.private instanceof Uint8Array)
    assert.deepEqual(Array.from(noiseKey.private), [1, 2, 3, 250])
    assert.deepEqual(Array.from(noiseKey.public), [9, 8, 7])
    const session = restored.keys.session.s1 as { data: Uint8Array }
    assert.deepEqual(Array.from(session.data), [4, 5, 6])
    assert.equal(restored.creds.me?.id, '15550001111:12@s.whatsapp.net')
})

test('close codes are read off the Boom-style output envelope', () => {
    assert.equal(
        waCloseCode({ output: { statusCode: WA_LOGGED_OUT } }),
        WA_LOGGED_OUT
    )
    assert.equal(
        waCloseCode({ output: { statusCode: WA_RESTART_REQUIRED } }),
        WA_RESTART_REQUIRED
    )
    // 440 (connection replaced) has no constant: it takes the same recoverable
    // path as any other unclassified close, and must still read as a number.
    assert.equal(waCloseCode({ output: { statusCode: 440 } }), 440)
    // An unclassifiable error must read as null so the caller falls back to the
    // recoverable path instead of mistaking it for a logout.
    assert.equal(waCloseCode(new Error('socket died')), null)
    assert.equal(waCloseCode(null), null)
    assert.equal(waCloseCode(undefined), null)
})
