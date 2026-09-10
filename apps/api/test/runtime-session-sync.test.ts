import type { ChatContentBlock, ChatRole } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRecoveryService } from '../src/modules/chat/recovery/session-recovery.service'
import { CandidateScanCache } from '../src/modules/chat/recovery/readers'
import type { RecoveredMessage } from '../src/modules/chat/recovery/readers'

interface DbMsg {
    id: string
    sessionId: string
    role: ChatRole
    contentBlocksJson: ChatContentBlock[]
    capabilityEventsJson: unknown
    createdAt: Date
}

const dbMessage = (
    id: string,
    role: ChatRole,
    text: string,
    createdAt: Date
): DbMsg => ({
    id,
    sessionId: 'session-1',
    role,
    contentBlocksJson: [{ type: 'text', text }],
    capabilityEventsJson: null,
    createdAt
})

const recovered = (
    externalId: string,
    role: ChatRole,
    text: string,
    seq: number
): RecoveredMessage => ({
    externalId,
    parentExternalId: null,
    role,
    contentBlocks: [{ type: 'text', text }],
    timestamp: `2026-05-10T10:00:0${seq}Z`,
    model: null,
    sources: [
        {
            sourceRef: 'local-ref',
            sourceFile: '/tmp/s.jsonl',
            sourceSeq: seq,
            externalId,
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText: JSON.stringify({ uuid: externalId, type: role, text }),
            rawJson: null,
            parserName: 'test',
            parserVersion: '1'
        }
    ]
})

const makeHarness = (
    options: {
        frameworkSessionRef?: string | null
        inflight?: boolean
        localMessages?: RecoveredMessage[]
        cloudMessages?: DbMsg[]
        hasReader?: boolean
        runtimeSyncCursor?: number | null
        lineCount?: number
        openTurnStartSeq?: number | null
    } = {}
) => {
    const session = {
        id: 'session-1',
        userId: 'user-1',
        agentId: 'agent-1',
        title: null,
        frameworkSessionRef:
            options.frameworkSessionRef === undefined
                ? 'local-ref'
                : options.frameworkSessionRef,
        inflightMessageId: options.inflight ? 'msg-live' : null,
        runtimeSyncCursor: options.runtimeSyncCursor ?? null,
        createdAt: new Date('2026-05-10T10:00:00Z'),
        updatedAt: new Date('2026-05-10T10:00:00Z')
    }
    const agent = {
        id: 'agent-1',
        userId: 'user-1',
        framework: 'claude-code',
        runtime: 'daemon',
        runtimeId: 'runtime-1'
    }
    const messages: DbMsg[] = options.cloudMessages ?? [
        dbMessage(
            'cloud-user',
            'user',
            'hello',
            new Date('2026-05-10T10:00:00Z')
        ),
        dbMessage(
            'cloud-assistant',
            'assistant',
            'hi there',
            new Date('2026-05-10T10:00:01Z')
        )
    ]
    const sourceRows: Array<{ sessionId: string; sourceEventKey: string }> = []
    const db = {
        select: () => ({
            from: () => ({ where: () => ({ limit: async () => [agent] }) })
        })
    }
    let appendCalls = 0
    const cursorMoves: Array<{ from: number | null; to: number }> = []
    const repo = {
        advanceRuntimeSyncCursor: async (
            _sessionId: string,
            from: number | null,
            to: number
        ) => {
            if (
                session.inflightMessageId !== null ||
                session.runtimeSyncCursor !== from
            )
                return false
            session.runtimeSyncCursor = to
            cursorMoves.push({ from, to })
            return true
        },
        getSession: async (id: string) => (id === session.id ? session : null),
        listMessages: async () =>
            [...messages].sort(
                (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
            ),
        appendRecoveredMessages: async (
            _sessionId: string,
            rows: DbMsg[],
            sources: Array<{ sessionId: string; sourceEventKey: string }>
        ) => {
            appendCalls++
            if (session.inflightMessageId !== null)
                return { appended: 0, conflicted: true, upsertedSources: 0 }
            for (const row of rows) messages.push(row)
            for (const s of sources)
                if (
                    !sourceRows.some(
                        (r) => r.sourceEventKey === s.sourceEventKey
                    )
                )
                    sourceRows.push(s)
            return {
                appended: rows.length,
                conflicted: false,
                upsertedSources: sources.length
            }
        }
    }
    const drivers = { recoveryFsForAgent: async () => ({ fs: {} }) }
    const reader = {
        readMessages: async () => ({
            sourceFile: '/tmp/s.jsonl',
            warnings: [],
            messages: options.localMessages ?? [],
            lineCount: options.lineCount,
            openTurnStartSeq: options.openTurnStartSeq
        }),
        listCandidates: async () => ({
            candidates: [],
            total: 0,
            listed: 0,
            filesByRef: new Map()
        })
    }
    const readers = {
        get: () => (options.hasReader === false ? undefined : reader)
    }
    const service = new SessionRecoveryService(
        db as never,
        repo as never,
        drivers as never,
        readers as never,
        new CandidateScanCache()
    )
    return {
        service,
        messages,
        sourceRows,
        cursorMoves,
        appendCallCount: () => appendCalls
    }
}

// The full local transcript is a superset of the cloud session: the two cloud
// turns plus what the TUI added. Only the addition is appended.
const localSuperset = [
    recovered('l-user-1', 'user', 'hello', 1),
    recovered('l-asst-1', 'assistant', 'hi there', 2),
    recovered('l-user-2', 'user', 'and now from the terminal', 3),
    recovered('l-asst-2', 'assistant', 'got it, from the TUI', 4)
]

test('appends the messages the TUI added, in order after the cloud ones', async () => {
    const h = makeHarness({ localMessages: localSuperset })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 2)
    assert.equal(res.skipped, null)
    assert.equal(h.messages.length, 4)
    const texts = h.messages
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => (m.contentBlocksJson[0] as { text: string }).text)
    assert.deepEqual(texts, [
        'hello',
        'hi there',
        'and now from the terminal',
        'got it, from the TUI'
    ])
})

// The diff is recomputed against the now-larger cloud each call, so a second
// sync of the same transcript is a no-op. This is the whole safety story for
// firing it on every switch-back and session open.
test('a second sync of the same transcript appends nothing', async () => {
    const h = makeHarness({ localMessages: localSuperset })
    await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    const second = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(second.appended, 0)
    assert.equal(h.messages.length, 4)
})

// A switch-back can catch the TUI mid-turn: the transcript already holds the
// user line but the assistant entry carries no text yet. Storing that shell
// would freeze an empty bubble (the finished turn later diffs as a NEW
// message), so the sync takes the user line and leaves the shell for the next
// pass.
test('skips an assistant entry the TUI has not finished writing', async () => {
    const h = makeHarness({
        localMessages: [
            recovered('l-user-1', 'user', 'hello', 1),
            recovered('l-asst-1', 'assistant', 'hi there', 2),
            recovered('l-user-2', 'user', 'and now from the terminal', 3),
            recovered('l-asst-2', 'assistant', '', 4)
        ]
    })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 1)
    assert.equal(h.messages.length, 3)
    const texts = h.messages
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => (m.contentBlocksJson[0] as { text: string }).text)
    assert.deepEqual(texts, ['hello', 'hi there', 'and now from the terminal'])
})

test('nothing new means appended:0 and no append call', async () => {
    const h = makeHarness({
        localMessages: [
            recovered('l-user-1', 'user', 'hello', 1),
            recovered('l-asst-1', 'assistant', 'hi there', 2)
        ]
    })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 0)
    assert.equal(res.skipped, null)
    assert.equal(h.appendCallCount(), 0)
})

// A live turn is the authoritative writer; syncing under it must not run.
test('skips while a turn is inflight', async () => {
    const h = makeHarness({ inflight: true, localMessages: localSuperset })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 0)
    assert.equal(res.skipped, 'inflight')
    assert.equal(h.appendCallCount(), 0)
})

test('skips a session the CLI never named', async () => {
    const h = makeHarness({ frameworkSessionRef: null })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.skipped, 'no-session-ref')
    assert.equal(res.appended, 0)
})

test('skips a framework with no recovery reader', async () => {
    const h = makeHarness({ hasReader: false, localMessages: localSuperset })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.skipped, 'unsupported')
    assert.equal(res.appended, 0)
})

// ---- cursor path -----------------------------------------------------------
//
// Once a turn on the ref has settled, the session carries how far the
// transcript reached (runtimeSyncCursor) and the sync takes what lies past
// it, complete turns only. Nothing is diffed against the cloud any more: the
// API's own turn sits below the cursor, however differently the file shapes
// it, and the TUI's turns sit above it.

const recoveredAt = (
    externalId: string,
    role: ChatRole,
    blocks: ChatContentBlock[],
    seqs: number[]
): RecoveredMessage => ({
    ...recovered(externalId, role, '', seqs[0]),
    contentBlocks: blocks,
    sources: seqs.map((seq) => ({
        ...recovered(externalId, role, '', seq).sources[0],
        externalId: `${externalId}:${seq}`,
        rawText: JSON.stringify({ line: seq, externalId })
    }))
})

// The staged turn: the cloud holds it as the stream persisted it, the file
// holds it as codex wrote it, and the two never compare equal.
const liveTurnInCloud = (): DbMsg[] => [
    dbMessage('cloud-user', 'user', 'hello?', new Date('2026-05-10T10:00:00Z')),
    {
        ...dbMessage(
            'cloud-assistant',
            'assistant',
            '',
            new Date('2026-05-10T10:00:01Z')
        ),
        contentBlocksJson: [
            { type: 'text', text: 'Checking the workspace first.' },
            {
                type: 'tool_call',
                toolCallId: 'item_1',
                toolName: 'command_execution',
                args: { command: '/bin/bash -lc "cat AGENTS.manyfold.md"' }
            },
            {
                type: 'tool_result',
                toolCallId: 'item_1',
                result: { output: 'No connections.\n', status: 'completed' }
            },
            { type: 'text', text: 'Hello. I am here and ready.' }
        ]
    }
]
const liveTurnInFile = (): RecoveredMessage[] => [
    recoveredAt('l-user-1', 'user', [{ type: 'text', text: 'hello?' }], [7]),
    recoveredAt(
        'l-asst-1',
        'assistant',
        [
            { type: 'text', text: 'Checking the workspace first.' },
            {
                type: 'tool_call',
                toolCallId: 'call_lxh',
                toolName: 'exec_command',
                args: { cmd: 'cat AGENTS.manyfold.md', workdir: '/ws' }
            },
            {
                type: 'tool_result',
                toolCallId: 'call_lxh',
                result: 'Chunk ID: e978a6\nOutput:\nNo connections.\n'
            },
            { type: 'text', text: 'Hello. I am here and ready.' }
        ],
        [12, 13, 16, 19]
    )
]
const tuiTurnInFile = (): RecoveredMessage[] => [
    recoveredAt(
        'l-user-2',
        'user',
        [{ type: 'text', text: 'and now from the terminal' }],
        [25]
    ),
    recoveredAt(
        'l-asst-2',
        'assistant',
        [{ type: 'text', text: 'got it, from the TUI' }],
        [27, 28]
    )
]

// Seen on staging [2026-09-10]: the sync that followed a first turn appended a
// second copy of the reply, because the rollout's `exec_command` never matched
// the stream's `command_execution`. With the turn below the cursor there is
// nothing to compare.
test('with a cursor, the turn the API streamed is not read back, whatever shape the file gives it', async () => {
    const h = makeHarness({
        cloudMessages: liveTurnInCloud(),
        localMessages: liveTurnInFile(),
        runtimeSyncCursor: 22,
        lineCount: 22,
        openTurnStartSeq: null
    })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 0)
    assert.equal(res.skipped, null)
    assert.equal(h.appendCallCount(), 0)
    assert.equal(h.messages.length, 2)
    assert.deepEqual(h.cursorMoves, [])
})

test('with a cursor, the TUI turn past it is appended and the cursor moves to the file end', async () => {
    const h = makeHarness({
        cloudMessages: liveTurnInCloud(),
        localMessages: [...liveTurnInFile(), ...tuiTurnInFile()],
        runtimeSyncCursor: 22,
        lineCount: 30,
        openTurnStartSeq: null
    })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 2)
    const texts = h.messages
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => (m.contentBlocksJson[0] as { text: string }).text)
    assert.deepEqual(texts, [
        'hello?',
        'Checking the workspace first.',
        'and now from the terminal',
        'got it, from the TUI'
    ])
    assert.deepEqual(h.cursorMoves, [{ from: 22, to: 30 }])
})

// A switch-back can catch the TUI mid-turn. The file says so (`task_started`
// with no end), so that turn is left whole and the cursor stops in front of
// it; the next sync takes the finished turn as one message.
test('with a cursor, a turn the file shows still running is held back whole', async () => {
    const h = makeHarness({
        cloudMessages: liveTurnInCloud(),
        localMessages: [
            ...liveTurnInFile(),
            ...tuiTurnInFile(),
            recoveredAt(
                'l-user-3',
                'user',
                [{ type: 'text', text: 'one more' }],
                [33]
            ),
            recoveredAt(
                'l-asst-3',
                'assistant',
                [{ type: 'text', text: 'partial' }],
                [35]
            )
        ],
        runtimeSyncCursor: 22,
        lineCount: 35,
        openTurnStartSeq: 32
    })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 2)
    assert.equal(h.messages.length, 4)
    assert.deepEqual(h.cursorMoves, [{ from: 22, to: 31 }])
})

// A session from before cursors (or whose last turn could not count) diffs by
// content once, as it always did, and comes out of it with a cursor.
test('without a cursor, the content diff runs once and establishes one', async () => {
    const h = makeHarness({
        localMessages: localSuperset,
        runtimeSyncCursor: null,
        lineCount: 40,
        openTurnStartSeq: null
    })
    const res = await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.equal(res.appended, 2)
    assert.deepEqual(h.cursorMoves, [{ from: null, to: 40 }])
})

// A reader that cannot count (no lineCount) keeps the session on the content
// diff: no cursor is ever written for it.
test('a reader without a line count never sets a cursor', async () => {
    const h = makeHarness({ localMessages: localSuperset })
    await h.service.syncRuntimeSessionIntoCloud(
        'user-1',
        'agent-1',
        'session-1'
    )
    assert.deepEqual(h.cursorMoves, [])
})
