import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeAccountView } from '@manyfold/shared'
import {
    readCachedRuntimeAccountView,
    writeCachedRuntimeAccountView
} from '../src/lib/runtimeAccount'

const view = (patch: Partial<RuntimeAccountView> = {}): RuntimeAccountView => ({
    runtimeId: 'art_1',
    framework: 'codex',
    kind: 'daemon',
    status: 'ok',
    checkedAt: '2026-09-18T10:00:00.000Z',
    credentialStatus: 'valid',
    credentialReason: 'oauth-live',
    tokenSource: 'file',
    identity: null,
    usage: null,
    host: null,
    error: null,
    ...patch
})

const withMockLocalStorage = (run: () => void): void => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    const storage: Storage = {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => {
            values.set(key, value)
        }
    }

    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage
    })

    try {
        run()
    } finally {
        if (previous) {
            Object.defineProperty(globalThis, 'localStorage', previous)
        } else {
            Reflect.deleteProperty(globalThis, 'localStorage')
        }
    }
}

test('an ok probe round-trips through the cache, keyed by runtime', () => {
    withMockLocalStorage(() => {
        writeCachedRuntimeAccountView(view())
        assert.deepEqual(readCachedRuntimeAccountView('art_1'), view())
        assert.equal(readCachedRuntimeAccountView('art_2'), null)
    })
})

test('only a successful probe is worth caching', () => {
    withMockLocalStorage(() => {
        writeCachedRuntimeAccountView(view({ status: 'sandbox-asleep' }))
        assert.equal(readCachedRuntimeAccountView('art_1'), null)
        writeCachedRuntimeAccountView(view())
        writeCachedRuntimeAccountView(view({ status: 'probe-failed' }))
        assert.deepEqual(readCachedRuntimeAccountView('art_1'), view())
    })
})

test('a corrupt or foreign cache entry reads as empty and is dropped', () => {
    withMockLocalStorage(() => {
        localStorage.setItem('mf.runtimeAccountView.art_1', 'not json')
        assert.equal(readCachedRuntimeAccountView('art_1'), null)
        assert.equal(localStorage.getItem('mf.runtimeAccountView.art_1'), null)
        localStorage.setItem(
            'mf.runtimeAccountView.art_1',
            JSON.stringify({ version: 999, view: view() })
        )
        assert.equal(readCachedRuntimeAccountView('art_1'), null)
    })
})

test('without storage the cache is silently absent', () => {
    assert.equal(readCachedRuntimeAccountView('art_1'), null)
    writeCachedRuntimeAccountView(view())
})
