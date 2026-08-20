import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
    ChatRepository,
    ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
} from '../src/modules/chat/chat.repository'
import { ChatService } from '../src/modules/chat/chat.service'

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

interface DeadCandidate {
    messageId: string
    lastSeq: number
}

interface EmittedRecord {
    messageId: string
    event: {
        type: string
        payload: { error?: { code?: string; retryable?: boolean } }
        sourceEventKey?: unknown
        sourceEventOrdinal?: unknown
    }
}

const makeService = (
    dead: DeadCandidate | null,
    options?: {
        turnAdoption?: {
            enabled: boolean
            ownerId?: string
            kick: () => void
        }
        turnExecutionState?: string
        turnExecutionRuntime?: 'sprites' | 'daemon' | 'external'
        reconciliationClaim?: boolean
    }
): {
    service: ChatService
    emitted: EmittedRecord[]
    beginStreamCalls: Array<{ messageId: string; startingSeq: number }>
    endStreamCalls: string[]
    hasStreamResult: { value: boolean }
    runningAdapters: Map<string, AbortController>
} => {
    const emitted: EmittedRecord[] = []
    const beginStreamCalls: Array<{ messageId: string; startingSeq: number }> =
        []
    const endStreamCalls: string[] = []
    const hasStreamResult = { value: false }

    const repo = {
        getSession: async () => sessionRow,
        latestDeadInflightMessage: async () => dead,
        deadInflightMessageById: async () =>
            dead ? { ...dead, sessionId: sessionRow.id } : null,
        getTurnExecution: async () =>
            options?.turnExecutionState
                ? {
                      state: options.turnExecutionState,
                      runtime: options.turnExecutionRuntime ?? 'sprites'
                  }
                : null,
        claimTurnForReconciliation: async () =>
            options?.reconciliationClaim
                ? { ownerId: 'owner-1', generation: 2 }
                : null,
        maxStreamEventSeq: async () => dead?.lastSeq ?? 0
    }
    const broadcaster = {
        hasStream: () => hasStreamResult.value,
        setStreamFence: () => undefined,
        beginStream: (
            _sessionId: string,
            messageId: string,
            startingSeq = 0
        ) => {
            beginStreamCalls.push({ messageId, startingSeq })
        },
        beginResumeStream: async (_sessionId: string, messageId: string) => {
            beginStreamCalls.push({
                messageId,
                startingSeq: dead?.lastSeq ?? 0
            })
        },
        emit: async (messageId: string, event: EmittedRecord['event']) => {
            emitted.push({ messageId, event })
            return { persisted: true }
        },
        emitDetached: async (
            messageId: string,
            event: EmittedRecord['event']
        ) => {
            emitted.push({ messageId, event })
        },
        endStream: (messageId: string) => {
            endStreamCalls.push(messageId)
        }
    }

    const service = new ChatService(
        {} as never,
        repo as never,
        broadcaster as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { event: () => {}, error: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        options?.turnAdoption as never
    )
    const runningAdapters = (
        service as unknown as {
            runningAdapters: Map<string, AbortController>
        }
    ).runningAdapters
    return {
        service,
        emitted,
        beginStreamCalls,
        endStreamCalls,
        hasStreamResult,
        runningAdapters
    }
}

test('subscribeStream terminalizes a truly-dead inflight turn with a retryable error', async () => {
    const h = makeService({ messageId: 'message-1', lastSeq: 4 })

    const session = await h.service.subscribeStream(
        'user-1',
        'agent-1',
        'session-1'
    )

    assert.equal(session.id, 'session-1')
    assert.equal(h.emitted.length, 1, 'expected one terminal emit')
    const rec = h.emitted[0]
    assert.equal(rec.messageId, 'message-1')
    assert.equal(rec.event.type, 'error')
    assert.equal(rec.event.payload.error?.code, 'server_restart')
    assert.equal(
        rec.event.payload.error?.retryable,
        true,
        'the interrupted terminal must be retryable so the UI offers a retry'
    )
    // The terminal must land at lastSeq + 1, so the stream is begun at the dead
    // turn's last persisted seq.
    assert.deepEqual(h.beginStreamCalls, [
        { messageId: 'message-1', startingSeq: 4 }
    ])
    assert.deepEqual(h.endStreamCalls, [])
    // Deterministic dedup key guards against double-terminalization when several
    // tabs / API instances subscribe to the same dead turn at once.
    assert.equal(rec.event.sourceEventKey, '__server_restart__')
    assert.equal(rec.event.sourceEventOrdinal, 0)
})

test('subscribeStream leaves a resumable daemon turn untouched', async () => {
    // latestDeadInflightMessage applies the daemon-liveness predicate, so a
    // daemon turn whose host is within the grace window is reported as null —
    // the working indicator stays and DaemonExecResumeService resumes it.
    const h = makeService(null)

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.equal(h.emitted.length, 0)
    assert.equal(h.beginStreamCalls.length, 0)
    assert.equal(h.endStreamCalls.length, 0)
})

test('subscribeStream does not terminalize a turn still running in this process', async () => {
    const h = makeService({ messageId: 'message-1', lastSeq: 2 })
    h.runningAdapters.set('message-1', new AbortController())

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.equal(h.emitted.length, 0)
    assert.equal(h.beginStreamCalls.length, 0)
})

test('subscribeStream leaves an existing broadcaster carrier untouched', async () => {
    const h = makeService({ messageId: 'message-1', lastSeq: 7 })
    h.hasStreamResult.value = true

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.equal(h.beginStreamCalls.length, 0)
    assert.equal(h.emitted.length, 0)
    assert.deepEqual(h.endStreamCalls, [])
})

test('subscribeStream defers an adoptable turn to the adoption sweep', async () => {
    // A turn with a live execution record is a deploy orphan the sweep will
    // recover — terminalizing it here would kill work adoption saves. The
    // subscribe nudges the sweep instead.
    let kicks = 0
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        {
            turnAdoption: { enabled: true, kick: () => kicks++ },
            turnExecutionState: 'handoff'
        }
    )

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.equal(h.emitted.length, 0, 'adoptable turn must not be terminalized')
    assert.equal(kicks, 1, 'subscribe must nudge the adoption sweep')
})

test('subscribeStream still terminalizes when the execution record is terminal', async () => {
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        {
            turnAdoption: { enabled: true, kick: () => {} },
            turnExecutionState: 'failed'
        }
    )

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.equal(h.emitted.length, 1)
    assert.equal(h.emitted[0].event.type, 'error')
})

test('subscribeStream claims an expired execution before terminalizing when adoption is disabled', async () => {
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        {
            turnAdoption: {
                enabled: false,
                ownerId: 'owner-1',
                kick: () => {}
            },
            turnExecutionState: 'running',
            reconciliationClaim: true
        }
    )

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.deepEqual(h.beginStreamCalls, [
        { messageId: 'message-1', startingSeq: 4 }
    ])
    assert.equal(h.emitted.length, 1)
    assert.equal(h.emitted[0].event.type, 'error')
})

test('subscribeStream cannot terminalize an actively leased execution when adoption is disabled', async () => {
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        {
            turnAdoption: {
                enabled: false,
                ownerId: 'owner-1',
                kick: () => {}
            },
            turnExecutionState: 'running'
        }
    )

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.deepEqual(h.beginStreamCalls, [])
    assert.deepEqual(h.emitted, [])
})

test('subscribeStream reconciles an expired daemon row even when transcript adoption is enabled', async () => {
    let kicks = 0
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        {
            turnAdoption: {
                enabled: true,
                ownerId: 'owner-1',
                kick: () => kicks++
            },
            turnExecutionState: 'running',
            turnExecutionRuntime: 'daemon',
            reconciliationClaim: true
        }
    )

    await h.service.subscribeStream('user-1', 'agent-1', 'session-1')

    assert.equal(kicks, 0, 'the adoption sweep cannot claim daemon rows')
    assert.equal(h.emitted.length, 1)
    assert.equal(h.emitted[0].event.type, 'error')
})

test('terminalizeDeadInflightMessage defers an adoptable turn to the adoption sweep', async () => {
    // The A2A resubscribe path names one assistant turn directly; mid-gap it
    // must apply the SAME adoption guard as the session-scoped subscribe, or an
    // A2A reconnect kills a turn the sweep would have recovered.
    let kicks = 0
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        {
            turnAdoption: { enabled: true, kick: () => kicks++ },
            turnExecutionState: 'adopting'
        }
    )

    await h.service.terminalizeDeadInflightMessage('message-1')

    assert.equal(h.emitted.length, 0, 'adoptable turn must not be terminalized')
    assert.equal(kicks, 1)
})

test('terminalizeDeadInflightMessage still closes a turn without a live execution record', async () => {
    const h = makeService(
        { messageId: 'message-1', lastSeq: 4 },
        { turnAdoption: { enabled: true, kick: () => {} } }
    )

    await h.service.terminalizeDeadInflightMessage('message-1')

    assert.equal(h.emitted.length, 1)
    assert.equal(h.emitted[0].event.type, 'error')
    assert.equal(h.emitted[0].event.payload.error?.code, 'server_restart')
})

test('terminalizeDeadInflightMessage leaves an existing broadcaster carrier untouched', async () => {
    const h = makeService({ messageId: 'message-1', lastSeq: 4 })
    h.hasStreamResult.value = true

    await h.service.terminalizeDeadInflightMessage('message-1')

    assert.deepEqual(h.beginStreamCalls, [])
    assert.deepEqual(h.emitted, [])
    assert.deepEqual(h.endStreamCalls, [])
})

test('latestDeadInflightMessage gates on daemon liveness with no message-age delay', async () => {
    const now = new Date('2026-06-13T12:00:00.000Z')
    const query = await captureDeadInflightWhereQuery(now)

    // Scoped to this session's assistant turns.
    assert.match(query.sql, /"chat_messages"\."session_id" = \$/)
    assert.ok(query.params.includes('session-1'))
    assert.ok(query.params.includes('assistant'))

    // The daemon-liveness predicate, identical to listOrphanedAssistantMessages:
    // a daemon seen within the grace window is resumable and never reported dead.
    assert.match(query.sql, /"runtime_hosts"/)
    assert.match(query.sql, /last_seen_at/)
    assert.ok(
        query.params.includes(
            new Date(
                now.getTime() - ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
            ).toISOString()
        ),
        'the daemon grace cutoff must match the bootstrap reconcile window so a resumable daemon turn is never killed early'
    )

    // Unlike the bootstrap sweep there is NO message created_at age guard, so a
    // freshly-dead turn clears on the next reload rather than ~24h later.
    assert.doesNotMatch(query.sql, /"chat_messages"\."created_at" </)
})

const captureDeadInflightWhereQuery = async (
    now: Date
): Promise<{ sql: string; params: unknown[] }> => {
    let selectCalls = 0
    let whereExpr: unknown
    const subquery = {
        from: () => ({
            where: () => ({
                getSQL: () => ({ queryChunks: [] })
            })
        })
    }
    const mainQuery = {
        from: () => ({
            leftJoin: () => ({
                where: (expr: unknown) => {
                    whereExpr = expr
                    return {
                        groupBy: () => ({
                            orderBy: () => ({
                                limit: async () => []
                            })
                        })
                    }
                }
            })
        })
    }
    const db = {
        select: () => {
            selectCalls += 1
            return selectCalls === 1 ? mainQuery : subquery
        }
    }

    await new ChatRepository(db as never).latestDeadInflightMessage(
        'session-1',
        { now }
    )

    assert.ok(
        whereExpr,
        'expected latestDeadInflightMessage to build a where clause'
    )
    return new PgDialect().sqlToQuery(whereExpr as never)
}
