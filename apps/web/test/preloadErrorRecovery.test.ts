import test from 'node:test'
import assert from 'node:assert/strict'
import {
    GUARD_WINDOW_MS,
    RELOAD_COMMIT_TIMEOUT_MS,
    SWALLOWED_MODULE_DIAGNOSTIC,
    createPreloadErrorRecovery,
    type PreloadErrorRecovery,
    type PreloadErrorRecoveryEnv
} from '../src/lib/preloadErrorRecovery'

type Timer = { run: () => void; ms: number }

type Harness = {
    env: PreloadErrorRecoveryEnv
    recovery: PreloadErrorRecovery
    dispatch: (payload?: unknown) => { defaultPrevented: boolean }
    store: Map<string, string>
    reloads: () => number
    reports: () => string[]
    timers: () => Timer[]
    advance: (ms: number) => void
}

const chunkError = (): TypeError =>
    new TypeError(
        'Failed to fetch dynamically imported module: /assets/MessageList-DpgarOUz.js'
    )

const makeHarness = (
    overrides: Partial<PreloadErrorRecoveryEnv> = {},
    store = new Map<string, string>()
): Harness => {
    const listeners: Array<(event: Event & { payload?: unknown }) => void> = []
    const timers: Timer[] = []
    let reloadCount = 0
    const reported: string[] = []
    let now = 1_000_000

    const env: PreloadErrorRecoveryEnv = {
        addEventListener: (_type, listener) => listeners.push(listener),
        storage: () => ({
            getItem: (key) => store.get(key) ?? null,
            setItem: (key, value) => {
                store.set(key, value)
            }
        }),
        reload: () => {
            reloadCount += 1
        },
        now: () => now,
        setTimer: (run, ms) => {
            timers.push({ run, ms })
        },
        report: (message) => {
            reported.push(message)
        },
        ...overrides
    }

    return {
        env,
        recovery: createPreloadErrorRecovery(env),
        dispatch: (payload) => {
            const event = {
                payload,
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true
                }
            }
            for (const listener of listeners) {
                listener(event as unknown as Event & { payload?: unknown })
            }
            return event
        },
        store,
        reloads: () => reloadCount,
        reports: () => reported,
        timers: () => timers,
        advance: (ms) => {
            now += ms
        }
    }
}

// Shape-for-shape replica of the helper Vite 6.4.2 generates around every
// dynamic import (vite/dist/node/chunks/dep-*.js, preload() and its inner
// handlePreloadError). The load-bearing detail is the trailing
// `baseModule().catch(handlePreloadError)`: a listener that prevents the event
// stops the rethrow, and the import then fulfils with undefined.
const vitePreload = <T>(
    baseModule: () => Promise<T>,
    dispatch: (payload?: unknown) => { defaultPrevented: boolean }
): Promise<T | undefined> => {
    const handlePreloadError = (err: unknown): undefined => {
        const event = dispatch(err)
        if (!event.defaultPrevented) throw err
        return undefined
    }
    return Promise.resolve().then(() => baseModule().catch(handlePreloadError))
}

// What React.lazy does with whatever the factory settles to.
const readLazyDefault = async <T>(
    load: () => Promise<{ default: T }>
): Promise<T> => (await load()).default

const settle = async <T>(
    promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; reason: unknown }> =>
    promise.then(
        (value) => ({ ok: true as const, value }),
        (reason) => ({ ok: false as const, reason })
    )

// A macrotask boundary drains the whole microtask queue, so the answer does
// not depend on how many .then hops Vite's helper and guardedImport add.
const stillPending = async (promise: Promise<unknown>): Promise<boolean> => {
    let settled = false
    const mark = (): void => {
        settled = true
    }
    void promise.then(mark, mark)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return !settled
}

test('a preload failure never fulfils the dynamic import with undefined', async () => {
    const harness = makeHarness()
    harness.recovery.install()

    const settled = await settle(
        vitePreload(() => Promise.reject(chunkError()), harness.dispatch)
    )

    assert.ok(
        !settled.ok || settled.value !== undefined,
        'React.lazy reads .default off whatever this fulfils with; undefined is the production TypeError'
    )
    assert.equal(settled.ok, false)
})

test('the whole Vite chain leaves React.lazy suspended instead of reading .default off undefined', async () => {
    const harness = makeHarness()
    harness.recovery.install()

    const read = readLazyDefault(() =>
        harness.recovery.guardedImport(
            () =>
                vitePreload(
                    () => Promise.reject(chunkError()),
                    harness.dispatch
                ) as Promise<{ default: string }>
        )
    )

    assert.equal(await stillPending(read), true)
    assert.equal(harness.reloads(), 1)
})

test('a rejected import requests one reload and stays pending while it commits', async () => {
    const harness = makeHarness()

    const loading = harness.recovery.guardedImport(() =>
        Promise.reject(chunkError())
    )

    assert.equal(await stillPending(loading), true)
    assert.equal(harness.reloads(), 1)
    assert.equal(harness.store.size, 1)
    assert.match(harness.reports().join('\n'), /stale chunk after deployment/)
})

test('an import fulfilled with undefined is treated as a swallowed preload failure', async () => {
    const harness = makeHarness()

    const loading = harness.recovery.guardedImport(async () => undefined)

    assert.equal(await stillPending(loading), true)
    assert.equal(harness.reloads(), 1)
})

test('a second failure within the guard window rejects into the crash pipeline', async () => {
    const store = new Map<string, string>()
    const first = makeHarness({}, store)
    await stillPending(
        first.recovery.guardedImport(() => Promise.reject(chunkError()))
    )
    assert.equal(first.reloads(), 1)

    // the reloaded document builds a fresh recovery over the same
    // sessionStorage, still inside the guard window
    const second = makeHarness({}, store)
    second.advance(GUARD_WINDOW_MS - 1)
    const error = chunkError()
    const settled = await settle(
        second.recovery.guardedImport(() => Promise.reject(error))
    )

    assert.equal(settled.ok, false)
    assert.equal(settled.ok === false && settled.reason, error)
    assert.equal(second.reloads(), 0)
    assert.match(second.reports().join('\n'), /guard window/)
})

test('a failure after the guard window expires reloads again', async () => {
    const store = new Map<string, string>()
    const first = makeHarness({}, store)
    await stillPending(
        first.recovery.guardedImport(() => Promise.reject(chunkError()))
    )

    const later = makeHarness({}, store)
    later.advance(GUARD_WINDOW_MS)
    const loading = later.recovery.guardedImport(() =>
        Promise.reject(chunkError())
    )

    assert.equal(await stillPending(loading), true)
    assert.equal(later.reloads(), 1)
})

test('concurrent lazy boundaries failing together reload only once', async () => {
    const harness = makeHarness()

    const first = harness.recovery.guardedImport(() =>
        Promise.reject(chunkError())
    )
    const second = harness.recovery.guardedImport(() =>
        Promise.reject(chunkError())
    )
    const third = harness.recovery.guardedImport(async () => undefined)

    assert.equal(await stillPending(first), true)
    assert.equal(await stillPending(second), true)
    assert.equal(await stillPending(third), true)
    assert.equal(harness.reloads(), 1)
})

test('an error thrown while the module evaluates is not a stale deployment', async () => {
    const harness = makeHarness()
    const error = new Error('Cannot read properties of null (reading map)')

    const settled = await settle(
        harness.recovery.guardedImport(() => Promise.reject(error))
    )

    assert.equal(settled.ok, false)
    assert.equal(settled.ok === false && settled.reason, error)
    assert.equal(harness.reloads(), 0)
    assert.equal(harness.store.size, 0)
})

test('a module that loads is handed through untouched', async () => {
    const harness = makeHarness()
    const loadedModule = { default: 'MessageList' }

    const result = await harness.recovery.guardedImport(
        async () => loadedModule
    )

    assert.equal(result, loadedModule)
    assert.equal(harness.reloads(), 0)
    assert.equal(harness.store.size, 0)
})

test('a reload that never commits surfaces the error instead of hanging forever', async () => {
    const harness = makeHarness()
    const error = chunkError()

    const loading = harness.recovery.guardedImport(() => Promise.reject(error))
    assert.equal(await stillPending(loading), true)

    const [timer] = harness.timers()
    assert.equal(timer.ms, RELOAD_COMMIT_TIMEOUT_MS)
    timer.run()

    const settled = await settle(loading)
    assert.equal(settled.ok, false)
    assert.equal(settled.ok === false && settled.reason, error)
    assert.match(harness.reports().join('\n'), /never committed/)
})

test('a throwing storage disables recovery instead of risking a reload loop', async () => {
    const harness = makeHarness({
        storage: () => {
            throw new Error('sessionStorage disabled')
        }
    })
    const error = chunkError()

    const settled = await settle(
        harness.recovery.guardedImport(() => Promise.reject(error))
    )

    assert.equal(settled.ok, false)
    assert.equal(settled.ok === false && settled.reason, error)
    assert.equal(harness.reloads(), 0)
    assert.match(harness.reports().join('\n'), /not persistable/)
})

test('a storage that drops writes disables recovery', async () => {
    const harness = makeHarness({
        storage: () => ({
            getItem: () => null,
            setItem: () => {}
        })
    })

    const settled = await settle(
        harness.recovery.guardedImport(async () => undefined)
    )

    assert.equal(settled.ok, false)
    assert.equal(
        settled.ok === false && (settled.reason as Error).message,
        SWALLOWED_MODULE_DIAGNOSTIC
    )
    assert.equal(harness.reloads(), 0)
})

test('recovery reloads in place and never navigates, so pathname and query survive', async () => {
    // the env deliberately exposes reload() and nothing else — no href setter,
    // no assign/replace — so a regression toward navigation cannot typecheck;
    // this pins the contract that recovery replays no POST and keeps
    // /agents/:id/chat?sessionId=... intact
    const harness = makeHarness()
    const loading = harness.recovery.guardedImport(() =>
        Promise.reject(chunkError())
    )

    assert.equal(await stillPending(loading), true)
    assert.equal(harness.reloads(), 1)
})

test('the vite:preloadError listener reports without preventing the rethrow', () => {
    const harness = makeHarness()
    harness.recovery.install()

    const event = harness.dispatch(chunkError())

    assert.equal(event.defaultPrevented, false)
    assert.equal(harness.reloads(), 0)
    assert.match(harness.reports().join('\n'), /failed chunk preload/)
})
