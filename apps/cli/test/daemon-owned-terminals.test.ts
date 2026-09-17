import test from 'node:test'
import assert from 'node:assert/strict'
import type { PtyProcess } from '../src/daemon/pty-backend'
import {
    attachOwnedTerminal,
    attachedTerminalCount,
    closeOwnedTerminal,
    detachOwnedTerminal,
    isOwnedTerminalId,
    listOwnedTerminals,
    ownedTerminalCount,
    registerOwnedTerminal,
    resetOwnedTerminalsForTest,
    resizeOwnedTerminal,
    OWNED_TERMINAL_LIMIT
} from '../src/daemon/owned-terminals'

// Terminals the daemon owns (ADR-0029 §6), against a fake pty: what an
// attachment sees (the screen first, then the tail), what a preempted or
// dead attachment gets, and what happens when nobody is attached.

// The headless parser runs on a zero timer, so let a few turns pass.
const settle = async (n = 3) => {
    for (let i = 0; i < n; i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
}
const decode = (base64: string) =>
    Buffer.from(base64, 'base64').toString('utf8')

const fakePty = () => {
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
        resolveExit = resolve
    })
    const calls: string[] = []
    const term: PtyProcess = {
        write: (data) => calls.push(`write:${data}`),
        resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
        kill: (signal) => {
            calls.push(`kill:${signal ?? ''}`)
            resolveExit(143)
        },
        exited
    }
    return { term, calls, exit: resolveExit }
}

const attachment = (refId: string, opts: { dead?: boolean } = {}) => {
    const received: string[] = []
    const settled: Array<Record<string, unknown>> = []
    return {
        received,
        settled,
        attachment: {
            refId,
            send: (base64: string) => {
                if (opts.dead) throw new Error('ws not open')
                received.push(decode(base64))
            },
            settle: (result: Record<string, unknown>) => {
                settled.push(result)
            }
        }
    }
}

const ID = 'tms_abcdefghijklmnopqrstuvwxyz'
const ID2 = 'tms_bbcdefghijklmnopqrstuvwxyz'

test.afterEach(() => resetOwnedTerminalsForTest())

test('a terminal id is a format, never a path', () => {
    assert.equal(isOwnedTerminalId(ID), true)
    assert.equal(isOwnedTerminalId('tms_../../etc'), false)
    assert.equal(isOwnedTerminalId('agt_abcdefghijklmnopqrstuvwxyz'), false)
    assert.equal(isOwnedTerminalId(42), false)
})

test('an attachment gets the screen so far, then the live tail; a second attachment preempts the first', async () => {
    const pty = fakePty()
    const exits: number[] = []
    const { feed } = registerOwnedTerminal({
        terminalId: ID,
        term: pty.term,
        cols: 40,
        rows: 6,
        profileBound: false,
        onExit: (code) => exits.push(code),
        log: () => {}
    })
    feed('first line\r\n')
    feed(Buffer.from('second line\r\n'))
    await settle()
    assert.equal(ownedTerminalCount(), 1)
    assert.equal(attachedTerminalCount(), 0)

    const a = attachment('ref-a')
    assert.equal(
        attachOwnedTerminal(ID, a.attachment, { cols: 40, rows: 6 }),
        true
    )
    await settle()
    assert.equal(attachedTerminalCount(), 1)
    assert.ok(a.received[0].includes('first line'), 'the snapshot comes first')
    assert.ok(a.received[0].includes('second line'))
    assert.ok(
        pty.calls.includes('resize:39x6') && pty.calls.includes('resize:40x6'),
        'the jiggle repaints a full-screen TUI'
    )
    feed('third line\r\n')
    await settle()
    assert.equal(a.received[a.received.length - 1], 'third line\r\n')

    const b = attachment('ref-b')
    assert.equal(
        attachOwnedTerminal(ID, b.attachment, { cols: 80, rows: 24 }),
        true
    )
    await settle()
    assert.deepEqual(
        a.settled,
        [{ detached: true }],
        'the first attachment is told it was preempted'
    )
    assert.ok(
        b.received[0].includes('third line'),
        'the newcomer sees the whole screen'
    )
    feed('fourth\r\n')
    await settle()
    assert.equal(b.received[b.received.length - 1], 'fourth\r\n')
    assert.equal(
        a.received.some((s) => s.includes('fourth')),
        false
    )
    assert.deepEqual(
        listOwnedTerminals().map((t) => [
            t.terminalId,
            t.attached,
            t.profileBound
        ]),
        [[ID, true, false]]
    )

    pty.exit(0)
    await settle()
    assert.deepEqual(b.settled, [{ exitCode: 0 }])
    assert.deepEqual(exits, [0])
    assert.equal(ownedTerminalCount(), 0)
})

test('a dead attachment is dropped on the first failed send and the terminal lives on, unattached', async () => {
    const pty = fakePty()
    const { feed } = registerOwnedTerminal({
        terminalId: ID,
        term: pty.term,
        cols: 40,
        rows: 6,
        profileBound: false,
        onExit: () => {},
        log: () => {}
    })
    const dead = attachment('ref-dead', { dead: true })
    attachOwnedTerminal(ID, dead.attachment, { cols: 40, rows: 6 })
    await settle()
    feed('anything\r\n')
    await settle()
    assert.equal(attachedTerminalCount(), 0)
    assert.equal(ownedTerminalCount(), 1, 'not killed')
    assert.equal(
        pty.calls.some((c) => c.startsWith('kill')),
        false
    )
    // A later attachment still gets everything the screen holds.
    const late = attachment('ref-late')
    attachOwnedTerminal(ID, late.attachment, { cols: 40, rows: 6 })
    await settle()
    assert.ok(late.received[0].includes('anything'))
})

test('detaching keeps the pty; resize and close reach it; an unknown id is refused', async () => {
    const pty = fakePty()
    registerOwnedTerminal({
        terminalId: ID,
        term: pty.term,
        cols: 40,
        rows: 6,
        profileBound: true,
        onExit: () => {},
        log: () => {}
    })
    const a = attachment('ref-a')
    attachOwnedTerminal(ID, a.attachment, { cols: 40, rows: 6 })
    await settle()
    assert.equal(
        detachOwnedTerminal(ID, 'ref-other'),
        false,
        'only the current attachment detaches'
    )
    assert.equal(detachOwnedTerminal(ID, 'ref-a'), true)
    assert.deepEqual(a.settled, [{ detached: true }])
    assert.equal(attachedTerminalCount(), 0)
    assert.equal(resizeOwnedTerminal(ID, 100, 30), true)
    assert.ok(pty.calls.includes('resize:100x30'))
    assert.equal(
        attachOwnedTerminal(ID2, a.attachment, { cols: 1, rows: 1 }),
        false
    )
    assert.equal(closeOwnedTerminal(ID), true)
    assert.ok(pty.calls.includes('kill:SIGHUP'))
    await settle()
    assert.equal(ownedTerminalCount(), 0)
})

test('the daemon refuses more terminals than it will keep', () => {
    for (let i = 0; i < OWNED_TERMINAL_LIMIT; i++)
        registerOwnedTerminal({
            terminalId: `tms_${String.fromCharCode(97 + i).repeat(26)}`,
            term: fakePty().term,
            cols: 10,
            rows: 2,
            profileBound: false,
            onExit: () => {},
            log: () => {}
        })
    assert.throws(
        () =>
            registerOwnedTerminal({
                terminalId: ID2,
                term: fakePty().term,
                cols: 10,
                rows: 2,
                profileBound: false,
                onExit: () => {},
                log: () => {}
            }),
        /too many terminals/
    )
})
