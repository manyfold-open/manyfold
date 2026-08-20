import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeminiThoughtTail } from '../src/modules/chat/adapters/gemini-thought-tail'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'

// gemini-cli emits no thought event on stdout, so the session JSONL is the ONLY
// place thinking exists. These tests pin what that costs us: thoughts must be
// emitted once (the same message id is re-appended as it grows), must belong to
// THIS turn (multi-turn session files hold every previous turn's thoughts too),
// and a broken/absent session file must degrade to silence, never break a turn.

const REF = 'dc52d624-311a-4664-93a9-9520e2b1ff31'
const PROMPT = 'explain what makes the color blue calming'
const FILE =
    '/home/sprite/.gemini/tmp/agt-x/chats/session-2026-07-24T12-27-dc52d624.jsonl'

const meta = (): string =>
    JSON.stringify({
        sessionId: REF,
        startTime: '2026-07-27T10:00:00.000Z',
        kind: 'main'
    })

const userMsg = (id: string, text: string): string =>
    JSON.stringify({
        id,
        timestamp: '2026-07-27T10:00:01.000Z',
        type: 'user',
        content: [{ text }]
    })

const geminiMsg = (
    id: string,
    content: string,
    thoughts: string[] = []
): string =>
    JSON.stringify({
        id,
        timestamp: '2026-07-27T10:00:02.000Z',
        type: 'gemini',
        content: [{ text: content }],
        thoughts: thoughts.map((description) => ({
            subject: '',
            description,
            timestamp: '2026-07-27T10:00:02.000Z'
        }))
    })

interface FakeFs {
    fs: RecoveryFs
    calls: { locate: number; read: number; exec: number }
    set(lines: string[] | null): void
    fail(err: Error | null): void
    gate(open: () => Promise<void>): void
}

// withExec adds the size-probe surface (production RecoveryFs always has it;
// the plain fake omits it to pin that the tail degrades to full reads).
const fakeFs = (
    lines: string[] | null,
    opts: { withExec?: boolean } = {}
): FakeFs => {
    const state = {
        lines,
        err: null as Error | null,
        gate: null as (() => Promise<void>) | null
    }
    const calls = { locate: 0, read: 0, exec: 0 }
    const content = (): string | null =>
        state.lines === null ? null : state.lines.join('\n') + '\n'
    const fs = {
        locate: async () => {
            calls.locate++
            return state.lines === null ? null : FILE
        },
        readFile: async () => {
            calls.read++
            if (state.gate) await state.gate()
            if (state.err) throw state.err
            return content()
        },
        listFiles: async () => [],
        ...(opts.withExec
            ? {
                  exec: async () => {
                      calls.exec++
                      const text = content()
                      return text === null
                          ? null
                          : `${Buffer.byteLength(text, 'utf8')}\n`
                  }
              }
            : {})
    } as never as RecoveryFs
    return {
        fs,
        calls,
        set: (lines) => {
            state.lines = lines
        },
        fail: (err) => {
            state.err = err
        },
        gate: (open) => {
            state.gate = open
        }
    }
}

// now() is frozen so throttling is exercised deliberately, not by wall clock.
const tailOf = (
    fs: RecoveryFs,
    opts?: { pollMs?: number; promptText?: string; now?: () => number }
) =>
    createGeminiThoughtTail({
        fs,
        frameworkSessionRef: REF,
        promptText: opts?.promptText ?? PROMPT,
        pollMs: opts?.pollMs ?? 1500,
        now: opts?.now ?? ((): number => 1_000_000)
    })

const texts = (events: Array<{ type: string }>): string[] =>
    events.map((e) => {
        assert.equal(e.type, 'thinking')
        return (e as unknown as { text: string }).text
    })

test('emits this turn thoughts once, then nothing on an unchanged file', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue is calming.', ['Considering the calm of blue'])
    ])
    const tail = tailOf(f.fs)

    assert.deepEqual(await tail.maybePoll(true), [
        { type: 'thinking', text: 'Considering the calm of blue' }
    ])
    assert.deepEqual(await tail.maybePoll(true), [])
    // The session file is located once, not per poll (locate costs an exec).
    assert.equal(f.calls.locate, 1)
    assert.equal(f.calls.read, 2)
})

test('a grown thoughts array emits only the new suffix', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['first thought'])
    ])
    const tail = tailOf(f.fs)
    assert.deepEqual(texts(await tail.maybePoll(true)), ['first thought'])

    // Same id re-appended as the message grows — last record wins.
    f.set([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['first thought']),
        geminiMsg('g1', 'Blue is calming.', ['first thought', 'second thought'])
    ])
    assert.deepEqual(texts(await tail.maybePoll(true)), ['\nsecond thought'])
    assert.deepEqual(await tail.maybePoll(true), [])
})

test('thoughts from earlier turns in the same session are never emitted', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u0', 'an older question'),
        geminiMsg('g0', 'older answer', ['stale thought from turn one']),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue is calming.', ['fresh thought'])
    ])
    const tail = tailOf(f.fs)
    assert.deepEqual(texts(await tail.maybePoll(true)), ['fresh thought'])
})

test('nothing is emitted until the turn prompt shows up in the session', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u0', 'an older question'),
        geminiMsg('g0', 'older answer', ['stale thought'])
    ])
    const tail = tailOf(f.fs)
    assert.deepEqual(await tail.maybePoll(true), [])

    f.set([
        meta(),
        userMsg('u0', 'an older question'),
        geminiMsg('g0', 'older answer', ['stale thought']),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue is calming.', ['fresh thought'])
    ])
    assert.deepEqual(texts(await tail.maybePoll(true)), ['fresh thought'])
})

test('throttles unforced polls to pollMs', async () => {
    let clock = 1_000_000
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['t1'])
    ])
    const tail = tailOf(f.fs, { pollMs: 1500, now: () => clock })

    assert.deepEqual(texts(await tail.maybePoll()), ['t1'])
    f.set([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['t1', 't2'])
    ])
    clock += 500
    assert.deepEqual(await tail.maybePoll(), [])
    assert.equal(f.calls.read, 1)
    clock += 1000
    assert.deepEqual(texts(await tail.maybePoll()), ['\nt2'])
    assert.equal(f.calls.read, 2)
})

test('pollMs=0 disables the tail without touching the filesystem', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['t1'])
    ])
    const tail = tailOf(f.fs, { pollMs: 0 })
    assert.deepEqual(await tail.maybePoll(true), [])
    assert.equal(f.calls.locate, 0)
    assert.equal(f.calls.read, 0)
})

test('a missing session file gives up after bounded locate attempts', async () => {
    const f = fakeFs(null)
    const tail = tailOf(f.fs)
    for (let i = 0; i < 5; i++) assert.deepEqual(await tail.maybePoll(true), [])
    assert.equal(f.calls.locate, 3)
    assert.equal(f.calls.read, 0)
})

test('read failures stay silent and disable the tail, never throw', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['t1'])
    ])
    f.fail(new Error('sprite fs read exploded'))
    const tail = tailOf(f.fs)
    assert.deepEqual(await tail.maybePoll(true), [])
    assert.deepEqual(await tail.maybePoll(true), [])
    // Disabled after the second failure: no third read.
    assert.deepEqual(await tail.maybePoll(true), [])
    assert.equal(f.calls.read, 2)
})

// #518: awaiting the tail's remote read inside the delivery loop let a 407KB
// session file pace token delivery to ~7s per line. pump() must return
// without touching the filesystem in the caller's await chain; the read runs
// in the background and its thoughts surface on a later pump.

const tick = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

test('pump never blocks on the read: events surface on a later pump', async () => {
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['slow thought'])
    ])
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    f.gate(() => held)
    const tail = tailOf(f.fs)

    assert.deepEqual(tail.pump(), [], 'first pump kicks the read, returns now')
    await tick()
    assert.equal(f.calls.read, 1, 'the kicked read is in flight')
    assert.deepEqual(tail.pump(), [], 'read still held: nothing to drain yet')
    await tick()
    assert.equal(f.calls.read, 1, 'no second read while one is in flight')

    release()
    await tick()
    assert.deepEqual(texts(tail.pump()), ['slow thought'])
    assert.deepEqual(tail.pump(), [])
})

test('finish flushes the in-flight poll before the forced read', async () => {
    let clock = 1_000_000
    const f = fakeFs([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['t1'])
    ])
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    f.gate(() => held)
    const tail = tailOf(f.fs, { now: () => clock })

    assert.deepEqual(tail.pump(), [])
    await tick()
    f.gate(async () => {})
    clock += 5000
    const finishing = tail.finish()
    release()
    // Were the in-flight result dropped, the forced read would find nothing
    // new (the dedupe map already recorded t1) and the turn would lose it.
    assert.deepEqual(texts(await finishing).join(''), 't1')
    assert.equal(f.calls.read, 2, 'in-flight read plus the forced final read')
})

test('an unchanged file size skips the re-read entirely', async () => {
    let clock = 1_000_000
    const f = fakeFs(
        [meta(), userMsg('u1', PROMPT), geminiMsg('g1', 'Blue', ['t1'])],
        { withExec: true }
    )
    const tail = tailOf(f.fs, { now: () => clock })

    assert.deepEqual(texts(await tail.maybePoll()), ['t1'])
    assert.equal(f.calls.read, 1)
    assert.equal(f.calls.exec, 0, 'first poll reads straight away')

    clock += 5000
    assert.deepEqual(await tail.maybePoll(), [])
    assert.equal(f.calls.exec, 1, 'unchanged size: probed')
    assert.equal(f.calls.read, 1, 'unchanged size: not re-read')

    f.set([
        meta(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue', ['t1', 't2'])
    ])
    clock += 5000
    assert.deepEqual(texts(await tail.maybePoll()), ['\nt2'])
    assert.equal(f.calls.read, 2, 'grown file: re-read')

    clock += 5000
    assert.deepEqual(texts(await tail.maybePoll(true)), [])
    assert.equal(f.calls.read, 3, 'forced poll bypasses the size gate')
})
