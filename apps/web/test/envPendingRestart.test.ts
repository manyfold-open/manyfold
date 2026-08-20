import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = new Map<string, string>()

;(globalThis as { window?: unknown }).window = {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value)
        }
    }
}

const {
    clearEnvPendingRestart,
    markEnvPendingRestart,
    readEnvPendingRestart
} = await import('../src/lib/envPendingRestart')

// Both sides of the comparison are server timestamps: `savedAt` is the save's
// own `updatedAt`, `startedAt` is stamped by the restart. These fixtures stand
// in for a server clock, so a mark saved "now" is `SAVED_AT`.
const SAVED_AT = Date.parse('2026-08-11T12:00:00.000Z')
const iso = (offsetMs: number): string =>
    new Date(SAVED_AT + offsetMs).toISOString()

beforeEach(() => {
    store.clear()
})

test('a saved edit stays pending until something restarts the agent', () => {
    markEnvPendingRestart('agt_1', ['NPM_TOKEN'], SAVED_AT)
    const pending = readEnvPendingRestart('agt_1', null)
    assert.deepEqual(pending?.keys, ['NPM_TOKEN'])
})

test('an agent that came up after the edit is already applied', () => {
    markEnvPendingRestart('agt_1', ['NPM_TOKEN'], SAVED_AT)
    assert.equal(readEnvPendingRestart('agt_1', iso(60_000)), null)
    // Self-corrected, so a later read without a timestamp agrees.
    assert.equal(readEnvPendingRestart('agt_1', null), null)
})

test('an agent that came up before the edit is still stale', () => {
    markEnvPendingRestart('agt_1', ['NPM_TOKEN'], SAVED_AT)
    assert.ok(readEnvPendingRestart('agt_1', iso(-60_000)))
})

// The restart's own stamp can land on the same millisecond as the save it
// applies (env is saved and applied back-to-back), and that restart did carry
// the new values — so equality has to read as applied, not as still owed.
test('a restart stamped at the save instant counts as applied', () => {
    markEnvPendingRestart('agt_1', ['NPM_TOKEN'], SAVED_AT)
    assert.equal(readEnvPendingRestart('agt_1', iso(0)), null)
})

test('successive edits accumulate their keys', () => {
    markEnvPendingRestart('agt_1', ['NPM_TOKEN'], SAVED_AT)
    markEnvPendingRestart('agt_1', ['DEBUG', 'NPM_TOKEN'], SAVED_AT + 1_000)
    const pending = readEnvPendingRestart('agt_1', null)
    assert.deepEqual(pending?.keys.sort(), ['DEBUG', 'NPM_TOKEN'])
})

// A second save moves the obligation forward: a restart between the two saves
// applied the first edit but not the second.
test('the newest save decides when the mark is satisfied', () => {
    markEnvPendingRestart('agt_1', ['NPM_TOKEN'], SAVED_AT)
    markEnvPendingRestart('agt_1', ['DEBUG'], SAVED_AT + 60_000)
    assert.ok(readEnvPendingRestart('agt_1', iso(30_000)))
    assert.equal(readEnvPendingRestart('agt_1', iso(90_000)), null)
})

test('restarting clears the obligation', () => {
    markEnvPendingRestart('agt_1', ['DEBUG'], SAVED_AT)
    clearEnvPendingRestart('agt_1')
    assert.equal(readEnvPendingRestart('agt_1', null), null)
})

test('agents do not read each others marks', () => {
    markEnvPendingRestart('agt_1', ['DEBUG'], SAVED_AT)
    assert.equal(readEnvPendingRestart('agt_2', null), null)
    assert.ok(readEnvPendingRestart('agt_1', null))
})

test('a corrupt store reads as nothing pending', () => {
    store.set('nca.web.envPendingRestart', '{not json')
    assert.equal(readEnvPendingRestart('agt_1', null), null)
})

test('an unparseable startedAt does not silently clear the mark', () => {
    markEnvPendingRestart('agt_1', ['DEBUG'], SAVED_AT)
    assert.ok(readEnvPendingRestart('agt_1', 'not-a-date'))
})
