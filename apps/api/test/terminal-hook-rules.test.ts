import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ChatSessionsChangedEvent,
    TerminalSessionHookRequest
} from '@manyfold/shared'
import { TerminalHookService } from '../src/modules/terminal/terminal-hook.service'

// The ownership table of ADR-0029 §3, one row at a time, against fakes of
// the three stores the rules touch (the refs, the chat session's holder
// state, the holder service) and the import.

const TERMINAL = {
    id: 'tms_1',
    userId: 'user-1',
    agentId: 'agt_1',
    runtime: 'daemon' as const,
    hostId: null,
    runtimeId: 'art_1',
    heldSessionId: null as string | null,
    processHandle: 'ref-1',
    tokenId: 'tok_1',
    leaseExpiresAt: new Date(),
    createdAt: new Date(),
    endedAt: null,
    endedReason: null
}

interface SessionState {
    inflightMessageId: string | null
    holderTerminalId: string | null
    holderAcquiredAt: Date | null
    importPendingSince: Date | null
    frameworkSessionRef: string | null
}

const buildHarness = (opts: {
    framework?: string
    sessions?: Record<string, SessionState>
    importTail?: () => Promise<{
        appended: number
        transcript: 'read' | 'missing' | 'unreadable' | null
        warnings: string[]
    }>
    acquireOutcome?: string
    // The release compare-and-set finds the hold already gone.
    releaseLost?: boolean
}) => {
    const sessions = opts.sessions ?? {}
    const refs = new Map<
        string,
        {
            id: string
            terminalId: string
            sessionRef: string
            source: string
            chatSessionId: string | null
            lastEvent: string
        }
    >()
    const calls = {
        moved: [] as Array<{
            sessionId: string
            terminalId: string
            ref: string
        }>,
        released: [] as string[],
        acquired: [] as string[],
        events: [] as ChatSessionsChangedEvent[]
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        { framework: opts.framework ?? 'claude-code' }
                    ]
                })
            })
        })
    }
    const refsRepo = {
        recordStart: async (input: {
            terminalId: string
            sessionRef: string
            source: string
            chatSessionId: string | null
        }) => {
            const key = `${input.terminalId}:${input.sessionRef}`
            const existing = refs.get(key)
            const row = existing
                ? {
                      ...existing,
                      lastEvent: 'start',
                      chatSessionId:
                          existing.chatSessionId ?? input.chatSessionId
                  }
                : {
                      id: `tsr_${refs.size + 1}`,
                      terminalId: input.terminalId,
                      sessionRef: input.sessionRef,
                      source: input.source,
                      chatSessionId: input.chatSessionId,
                      lastEvent: 'start'
                  }
            refs.set(key, row)
            return row
        },
        recordEnd: async (terminalId: string, sessionRef: string) => {
            const row = refs.get(`${terminalId}:${sessionRef}`)
            if (!row) return false
            row.lastEvent = 'end'
            return true
        },
        countForTerminal: async (terminalId: string) =>
            [...refs.values()].filter((row) => row.terminalId === terminalId)
                .length
    }
    const chatRepo = {
        sessionHolderState: async (sessionId: string) =>
            sessions[sessionId] ?? null,
        findSessionByFrameworkSessionRef: async (
            _userId: string,
            _agentId: string,
            ref: string
        ) => {
            const entry = Object.entries(sessions).find(
                ([, state]) => state.frameworkSessionRef === ref
            )
            return entry ? { id: entry[0] } : null
        },
        moveHeldSessionRef: async (
            sessionId: string,
            terminalId: string,
            ref: string
        ) => {
            const state = sessions[sessionId]
            if (!state || state.holderTerminalId !== terminalId) return false
            state.frameworkSessionRef = ref
            calls.moved.push({ sessionId, terminalId, ref })
            return true
        }
    }
    const holder = {
        acquire: async (args: { sessionId: string; terminalId: string }) => {
            const outcome = opts.acquireOutcome ?? 'applied'
            if (outcome === 'applied') {
                sessions[args.sessionId].holderTerminalId = args.terminalId
                calls.acquired.push(args.sessionId)
            }
            return outcome
        },
        releaseHeldByHook: async (
            _row: unknown,
            sessionId: string
        ): Promise<boolean> => {
            const state = sessions[sessionId]
            if (opts.releaseLost || !state?.holderTerminalId) return false
            state.holderTerminalId = null
            calls.released.push(sessionId)
            return true
        }
    }
    const recovery = {
        importHeldSessionTail:
            opts.importTail ??
            (async () => ({ appended: 0, transcript: 'read', warnings: [] }))
    }
    const broadcaster = {
        emitSessionsChanged: (
            _userId: string,
            event: ChatSessionsChangedEvent
        ) => calls.events.push(event)
    }
    const service = new TerminalHookService(
        db as never,
        refsRepo as never,
        chatRepo as never,
        holder as never,
        recovery as never,
        broadcaster as never,
        undefined
    )
    return { service, refs, calls, sessions }
}

const start = (
    sessionRef: string,
    source: TerminalSessionHookRequest['source'] = 'startup'
): TerminalSessionHookRequest => ({
    framework: 'claude-code',
    event: 'start',
    source,
    sessionRef
})

const end = (sessionRef: string): TerminalSessionHookRequest => ({
    framework: 'claude-code',
    event: 'end',
    source: 'other',
    sessionRef
})

const held = (ref: string, terminalId = TERMINAL.id): SessionState => ({
    inflightMessageId: null,
    holderTerminalId: terminalId,
    holderAcquiredAt: new Date(),
    importPendingSince: null,
    frameworkSessionRef: ref
})

const idle = (ref: string): SessionState => ({
    inflightMessageId: null,
    holderTerminalId: null,
    holderAcquiredAt: null,
    importPendingSince: null,
    frameworkSessionRef: ref
})

test("another framework's session in the terminal is ignored", async () => {
    const h = buildHarness({ framework: 'codex' })
    assert.equal(await h.service.report(TERMINAL, start('ref-a')), 'ignored')
    assert.equal(h.refs.size, 0)
})

test('the resumed TUI starting on the held ref is a no-op that binds the ref', async () => {
    const h = buildHarness({ sessions: { cts_1: held('ref-a') } })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(
        await h.service.report(terminal, start('ref-a', 'resume')),
        'noop'
    )
    assert.equal(h.refs.get('tms_1:ref-a')?.chatSessionId, 'cts_1')
})

test('a first start on a different ref imports the old tail and moves the session', async () => {
    const h = buildHarness({
        sessions: { cts_1: held('ref-a') },
        importTail: async () => ({
            appended: 2,
            transcript: 'read',
            warnings: []
        })
    })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(
        await h.service.report(terminal, start('ref-b', 'resume')),
        'ref-moved'
    )
    assert.deepEqual(h.calls.moved, [
        { sessionId: 'cts_1', terminalId: 'tms_1', ref: 'ref-b' }
    ])
    assert.equal(h.sessions.cts_1.frameworkSessionRef, 'ref-b')
    assert.equal(h.refs.get('tms_1:ref-b')?.chatSessionId, 'cts_1')
    assert.deepEqual(
        h.calls.events.map((event) => [event.reason, event.detail]),
        [['import-settled', { kind: 'import-done', appended: 2 }]]
    )
})

test('a compaction that changed the ref moves the session too', async () => {
    const h = buildHarness({ sessions: { cts_1: held('ref-a') } })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(
        await h.service.report(terminal, start('ref-a', 'resume')),
        'noop'
    )
    assert.equal(
        await h.service.report(terminal, start('ref-c', 'compact')),
        'ref-moved'
    )
    assert.equal(h.sessions.cts_1.frameworkSessionRef, 'ref-c')
    // Nothing was appended, so no import event reaches the tab.
    assert.deepEqual(h.calls.events, [])
})

test('an unreadable old transcript defers the move and records the new ref instead', async () => {
    const h = buildHarness({
        sessions: { cts_1: held('ref-a') },
        importTail: async () => ({
            appended: 0,
            transcript: 'unreadable',
            warnings: []
        })
    })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(
        await h.service.report(terminal, start('ref-b', 'compact')),
        'recorded'
    )
    assert.deepEqual(h.calls.moved, [])
    assert.equal(h.sessions.cts_1.frameworkSessionRef, 'ref-a')
    assert.equal(h.refs.get('tms_1:ref-b')?.chatSessionId, null)
})

test('a runtime that cannot be read defers the move the same way', async () => {
    const h = buildHarness({
        sessions: { cts_1: held('ref-a') },
        importTail: async () => {
            throw new Error('daemon offline')
        }
    })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(
        await h.service.report(terminal, start('ref-b', 'resume')),
        'recorded'
    )
    assert.equal(h.sessions.cts_1.frameworkSessionRef, 'ref-a')
})

test('a later fresh start under a standing hold releases it before filing the new ref', async () => {
    const h = buildHarness({ sessions: { cts_1: held('ref-a') } })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    await h.service.report(terminal, start('ref-a', 'resume'))
    assert.equal(
        await h.service.report(terminal, start('ref-new', 'startup')),
        'recorded'
    )
    assert.deepEqual(h.calls.released, ['cts_1'])
    assert.equal(h.sessions.cts_1.holderTerminalId, null)
    assert.equal(h.refs.get('tms_1:ref-new')?.chatSessionId, null)
})

test('a start on an idle chat session takes its hold (acquire b)', async () => {
    const h = buildHarness({ sessions: { cts_2: idle('ref-x') } })
    assert.equal(
        await h.service.report(TERMINAL, start('ref-x', 'resume')),
        'acquired'
    )
    assert.deepEqual(h.calls.acquired, ['cts_2'])
    assert.equal(h.refs.get('tms_1:ref-x')?.chatSessionId, 'cts_2')
})

test('a start on a session with a turn in flight is refused and warned about', async () => {
    const h = buildHarness({
        sessions: {
            cts_2: { ...idle('ref-x'), inflightMessageId: 'msg_1' }
        }
    })
    assert.equal(
        await h.service.report(TERMINAL, start('ref-x', 'resume')),
        'refused-turn-in-flight'
    )
    assert.deepEqual(h.calls.acquired, [])
    assert.deepEqual(
        h.calls.events.map((event) => [
            event.sessionId,
            event.reason,
            event.detail
        ]),
        [
            [
                'cts_2',
                'terminal-refused',
                { kind: 'terminal-attach-refused', reason: 'turn-in-flight' }
            ]
        ]
    )
})

test('a start on a session another terminal holds is refused', async () => {
    const h = buildHarness({ sessions: { cts_2: held('ref-x', 'tms_other') } })
    assert.equal(
        await h.service.report(TERMINAL, start('ref-x', 'resume')),
        'refused-held-elsewhere'
    )
    assert.equal(h.calls.events[0]?.detail?.kind, 'terminal-attach-refused')
})

test('losing the acquire race reports the refusal the race decided', async () => {
    const h = buildHarness({
        sessions: { cts_2: idle('ref-x') },
        acquireOutcome: 'turn-in-flight'
    })
    assert.equal(
        await h.service.report(TERMINAL, start('ref-x', 'resume')),
        'refused-turn-in-flight'
    )
})

test('an unknown ref is recorded for startup, clear and fork, ignored for a resume', async () => {
    const h = buildHarness({})
    assert.equal(
        await h.service.report(TERMINAL, start('ref-1', 'startup')),
        'recorded'
    )
    assert.equal(
        await h.service.report(TERMINAL, start('ref-2', 'clear')),
        'recorded'
    )
    assert.equal(
        await h.service.report(TERMINAL, start('ref-3', 'fork')),
        'recorded'
    )
    assert.equal(
        await h.service.report(TERMINAL, start('ref-4', 'resume')),
        'ignored'
    )
    assert.deepEqual(
        [...h.refs.keys()],
        ['tms_1:ref-1', 'tms_1:ref-2', 'tms_1:ref-3']
    )
    assert.equal(h.refs.get('tms_1:ref-2')?.source, 'clear')
})

test('the end of the held session releases the hold; other ends only mark the ref', async () => {
    const h = buildHarness({ sessions: { cts_1: held('ref-a') } })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    await h.service.report(terminal, start('ref-a', 'resume'))
    await h.service.report(terminal, start('ref-fresh', 'clear'))
    // `clear` releases the stale hold on the way in (see above), so the end
    // for ref-a that arrives late is just a marked ref now.
    assert.equal(await h.service.report(terminal, end('ref-a')), 'noop')
    assert.equal(h.refs.get('tms_1:ref-a')?.lastEvent, 'end')
    assert.equal(await h.service.report(terminal, end('ref-fresh')), 'noop')
    assert.equal(await h.service.report(terminal, end('ref-never')), 'ignored')
})

test('the end for the ref the terminal holds gives the hold back', async () => {
    const h = buildHarness({ sessions: { cts_1: held('ref-a') } })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(await h.service.report(terminal, end('ref-a')), 'released')
    assert.deepEqual(h.calls.released, ['cts_1'])
})

test('an end that loses the release to a concurrent start is a no-op, not an unknown ref', async () => {
    const h = buildHarness({
        sessions: { cts_1: held('ref-a') },
        releaseLost: true
    })
    const terminal = { ...TERMINAL, heldSessionId: 'cts_1' }
    assert.equal(await h.service.report(terminal, end('ref-a')), 'noop')
    assert.deepEqual(h.calls.released, [])
})
