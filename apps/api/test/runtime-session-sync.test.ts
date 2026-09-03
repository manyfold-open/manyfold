import type { ChatContentBlock, ChatRole } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRecoveryService } from '../src/modules/chat/recovery/session-recovery.service'
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
    const repo = {
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
            messages: options.localMessages ?? []
        }),
        listCandidates: async () => []
    }
    const readers = {
        get: () => (options.hasReader === false ? undefined : reader)
    }
    const service = new SessionRecoveryService(
        db as never,
        repo as never,
        drivers as never,
        readers as never
    )
    return {
        service,
        messages,
        sourceRows,
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
