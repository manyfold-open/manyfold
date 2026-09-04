import type {
    ChatContentBlock,
    ChatRole
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { SessionRecoveryService } from '../src/modules/chat/recovery/session-recovery.service'
import type {
    CandidateSession,
    RecoveredMessage
} from '../src/modules/chat/recovery/readers'

test('SessionRecoveryService recoverRuntimeSessionRawSources recovers only raw sources', async () => {
    const harness = makeHarness()

    const first = await harness.service.recoverRuntimeSessionRawSources(
        'user-1',
        'agent-1',
        'session-1'
    )

    assert.equal(first.inserted, 2)
    assert.equal(first.rawMissingCount, 2)
    assert.equal(harness.messages.length, 1)
    assert.equal(harness.sourceRows.length, 2)
    assert.equal(harness.sourceRows[0].messageId, 'cloud-user')
    assert.equal(harness.sourceRows[1].messageId, null)

    const firstKeys = harness.sourceRows.map((row) => row.sourceEventKey)
    const preview = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1'
    )

    assert.equal(preview.rawMissingCount, 0)
    assert.equal(preview.parsedLocalMessages.length, 2)
    assert.equal(preview.parsedLocalMessages[0].role, 'user')
    assert.equal(preview.parsedLocalMessages[0].model, null)
    assert.equal(preview.parsedLocalMessages[1].role, 'assistant')
    assert.equal(preview.parsedLocalMessages[1].model, 'gpt-5.4')

    const second = await harness.service.recoverRuntimeSessionRawSources(
        'user-1',
        'agent-1',
        'session-1'
    )

    assert.equal(second.inserted, 0)
    assert.deepEqual(
        harness.sourceRows.map((row) => row.sourceEventKey),
        firstKeys
    )
})

test('SessionRecoveryService recoverRuntimeSessionRawSources repairs unbound common raw sources without duplicating rows', async () => {
    const harness = makeHarness()

    await harness.service.recoverRuntimeSessionRawSources(
        'user-1',
        'agent-1',
        'session-1'
    )
    const firstKeys = harness.sourceRows.map((row) => row.sourceEventKey)
    harness.sourceRows[0].messageId = null

    const repaired = await harness.service.recoverRuntimeSessionRawSources(
        'user-1',
        'agent-1',
        'session-1'
    )

    assert.equal(repaired.inserted, 1)
    assert.deepEqual(
        harness.sourceRows.map((row) => row.sourceEventKey),
        firstKeys
    )
    assert.equal(harness.sourceRows[0].messageId, 'cloud-user')
})

test('raw recovery applies an override ref with its idle-session write', async () => {
    const harness = makeHarness()

    await harness.service.recoverRuntimeSessionRawSources(
        'user-1',
        'agent-1',
        'session-1',
        'other-ref'
    )

    assert.equal(harness.sessions[0]?.frameworkSessionRef, 'other-ref')
})

test('SessionRecoveryService viewRuntimeSession previews only local runtime parsed messages', async () => {
    const harness = makeHarness()

    const result = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1'
    )

    assert.equal(result.rawMissingCount, 2)
    assert.equal(result.parsedLocalMessages.length, 2)
    assert.equal(result.selectedCloudSessionId, 'session-1')
})

test('SessionRecoveryService viewRuntimeSession identifies local-only runtime sessions', async () => {
    const harness = makeHarness()

    const current = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1',
        'local-ref'
    )
    assert.equal(current.selectedCloudSessionId, 'session-1')

    const localOnly = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1',
        'other-ref'
    )
    assert.equal(localOnly.selectedSessionRef, 'other-ref')
    assert.equal(localOnly.selectedCloudSessionId, null)
})

test('SessionRecoveryService treats same-ref runtime sessions with no matching messages as local-only', async () => {
    const harness = makeHarness()
    harness.messages[0].contentBlocksJson = [
        { type: 'text', text: 'unrelated cloud message' }
    ]

    const viewed = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1',
        'local-ref'
    )

    assert.equal(viewed.selectedSessionRef, 'local-ref')
    assert.equal(viewed.selectedCloudSessionId, null)
    await assert.rejects(
        () =>
            harness.service.recoverRuntimeSessionRawSources(
                'user-1',
                'agent-1',
                'session-1'
            ),
        (err: unknown) =>
            err instanceof Error &&
            err.message.includes(
                'selected runtime session does not match the current cloud session'
            )
    )
})

test('SessionRecoveryService restoreRuntimeSession imports a local-only runtime session into cloud DB', async () => {
    const harness = makeHarness()

    const restored = await harness.service.restoreRuntimeSession(
        'user-1',
        'agent-1',
        'other-ref'
    )

    assert.notEqual(restored.session.id, 'session-1')
    assert.equal(restored.session.frameworkSessionRef, 'other-ref')
    assert.equal(restored.restoredMessageCount, 2)
    assert.equal(harness.sessions.length, 2)
    const restoredMessages =
        harness.messagesBySession.get(restored.session.id) ?? []
    assert.equal(restoredMessages.length, 2)
    const userMeta = restoredMessages[0]
        .capabilityEventsJson as unknown as Record<string, unknown>
    const assistantMeta = restoredMessages[1]
        .capabilityEventsJson as unknown as Record<string, unknown>
    assert.equal(userMeta.model, undefined)
    assert.equal(assistantMeta.model, 'gpt-5.4')
    assert.equal(
        (assistantMeta.recoveredFrom as { sourceRef?: string }).sourceRef,
        'other-ref'
    )
    assert.equal(
        harness.sourceRows.filter(
            (row) => row.sessionId === restored.session.id
        ).length,
        2
    )
})

test('SessionRecoveryService restoreRuntimeSession preserves runtime preview order with duplicate timestamps', async () => {
    const harness = makeHarness()
    const preview = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1',
        'same-time-ref'
    )

    const restored = await harness.service.restoreRuntimeSession(
        'user-1',
        'agent-1',
        'same-time-ref'
    )
    const restoredRows =
        harness.messagesBySession.get(restored.session.id) ?? []

    assert.deepEqual(
        restoredRows.map((row) => row.contentBlocksJson),
        preview.parsedLocalMessages.map((message) => message.contentBlocks)
    )
    assert.deepEqual(
        restoredRows.map((row) => row.role),
        preview.parsedLocalMessages.map((message) => message.role)
    )
    assert.ok(
        restoredRows[0].createdAt.getTime() <
            restoredRows[1].createdAt.getTime()
    )
})

test('SessionRecoveryService rebuildRuntimeSessionParsedMessages replaces restored parsed messages', async () => {
    const harness = makeHarness()
    const restored = await harness.service.restoreRuntimeSession(
        'user-1',
        'agent-1',
        'other-ref'
    )
    const rows = harness.messagesBySession.get(restored.session.id) ?? []
    rows[1].contentBlocksJson = [{ type: 'text', text: 'old parsed text' }]

    const rebuilt = await harness.service.rebuildRuntimeSessionParsedMessages(
        'user-1',
        'agent-1',
        restored.session.id,
        'other-ref'
    )
    const rebuiltRows = harness.messagesBySession.get(restored.session.id) ?? []

    assert.equal(rebuilt.session.id, restored.session.id)
    assert.equal(rebuilt.rebuiltMessageCount, 2)
    assert.equal(rebuiltRows.length, 2)
    assert.deepEqual(rebuiltRows[1].contentBlocksJson, [
        { type: 'text', text: 'missing' }
    ])
    assert.equal(
        (
            rebuiltRows[1].capabilityEventsJson as unknown as {
                model?: string
                recoveredFrom?: { sourceRef?: string }
            }
        ).model,
        'gpt-5.4'
    )
    assert.equal(
        (
            rebuiltRows[1].capabilityEventsJson as unknown as {
                recoveredFrom?: { sourceRef?: string }
            }
        ).recoveredFrom?.sourceRef,
        'other-ref'
    )
})

test('SessionRecoveryService recoverRuntimeSessionRawSources rejects a session without a runtime ref', async () => {
    const harness = makeHarness({ frameworkSessionRef: null })

    await assert.rejects(
        () =>
            harness.service.recoverRuntimeSessionRawSources(
                'user-1',
                'agent-1',
                'session-1'
            ),
        (error: unknown) => {
            assert.ok(error instanceof BadRequestException)
            assert.deepEqual(error.getResponse(), {
                code: 'recovery_no_session_ref',
                message:
                    'session has no framework_session_ref; pick a runtime session first'
            })
            return true
        }
    )
})

test('SessionRecoveryService recoverRuntimeSessionRawSources rejects an empty runtime session', async () => {
    const harness = makeHarness({ recoveredMessages: [] })

    await assert.rejects(
        () =>
            harness.service.recoverRuntimeSessionRawSources(
                'user-1',
                'agent-1',
                'session-1'
            ),
        (error: unknown) => {
            assert.ok(error instanceof BadRequestException)
            assert.deepEqual(error.getResponse(), {
                code: 'recovery_empty',
                message:
                    'no messages could be recovered from local session file'
            })
            return true
        }
    )
})

const makeHarness = (
    options: {
        frameworkSessionRef?: string | null
        recoveredMessages?: RecoveredMessage[]
        candidates?: CandidateSession[]
        recoveryFsError?: Error
    } = {}
) => {
    const listCandidateCalls = { count: 0 }
    const session = {
        id: 'session-1',
        userId: 'user-1',
        agentId: 'agent-1',
        title: null,
        frameworkSessionRef:
            options.frameworkSessionRef === undefined
                ? 'local-ref'
                : options.frameworkSessionRef,
        createdAt: new Date('2026-05-10T10:00:00Z'),
        updatedAt: new Date('2026-05-10T10:00:00Z')
    }
    const agent = {
        id: 'agent-1',
        userId: 'user-1',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId: 'runtime-1'
    }
    const sessions = [session]
    const messages = [
        dbMessage('cloud-user', 'user', [{ type: 'text', text: 'hello' }])
    ]
    const messagesBySession = new Map<string, typeof messages>([
        [session.id, messages]
    ])
    const sourceRows: Array<{
        sessionId: string
        messageId: string | null
        sourceEventKey: string
        rawText?: string | null
        rawJson?: unknown
    }> = [] as never[]
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agent]
                })
            })
        })
    }
    const repo = {
        listSessions: async () => sessions,
        sessionMessageStats: async (ids: string[]) =>
            new Map(
                ids.map((id) => [
                    id,
                    {
                        messageCount: (messagesBySession.get(id) ?? []).length,
                        lastMessageAt:
                            (messagesBySession.get(id) ?? []).at(-1)
                                ?.createdAt ?? null
                    }
                ])
            ),
        getSession: async (sessionId: string) =>
            sessions.find((s) => s.id === sessionId) ?? null,
        findSessionByFrameworkSessionRef: async (
            _userId: string,
            _agentId: string,
            ref: string
        ) => sessions.find((s) => s.frameworkSessionRef === ref) ?? null,
        createSession: async (row: typeof session) => {
            sessions.push(row)
            messagesBySession.set(row.id, [] as never)
            return row
        },
        createSessionWithRecoveredMessages: async (input: {
            session: typeof session
            messages: typeof messages
            sources: Array<{
                sessionId: string
                messageId: string | null
                sourceEventKey: string
                rawText?: string | null
                rawJson?: unknown
            }>
        }) => {
            sessions.push(input.session)
            messagesBySession.set(input.session.id, [...input.messages])
            for (const row of input.sources) {
                const existing = sourceRows.find(
                    (item) => item.sourceEventKey === row.sourceEventKey
                )
                if (existing) {
                    existing.messageId = existing.messageId ?? row.messageId
                    existing.sessionId = row.sessionId
                    continue
                }
                sourceRows.push(row)
            }
            return {
                session: input.session,
                upsertedSources: input.sources.length
            }
        },
        appendSessionMessages: async (
            sessionId: string,
            rows: typeof messages
        ) => {
            const target = messagesBySession.get(sessionId)
            if (!target) throw new Error(`missing session ${sessionId}`)
            target.push(...rows)
            return { inserted: rows.length }
        },
        replaceSessionMessages: async (
            sessionId: string,
            rows: typeof messages,
            ref?: string | null,
            guard?: (existing: typeof messages) => boolean,
            sources: typeof sourceRows = []
        ) => {
            const existing = messagesBySession.get(sessionId) ?? []
            if (guard && !guard(existing))
                return {
                    replaced: 0,
                    conflicted: true,
                    upsertedSources: 0
                }
            messagesBySession.set(sessionId, [...rows])
            const target = sessions.find((s) => s.id === sessionId)
            if (target) {
                if (ref !== undefined) target.frameworkSessionRef = ref
                target.updatedAt = new Date('2026-05-10T10:01:00Z')
            }
            for (const source of sourceRows) {
                if (source.sessionId === sessionId) source.messageId = null
            }
            for (const row of sources) {
                const existingSource = sourceRows.find(
                    (item) => item.sourceEventKey === row.sourceEventKey
                )
                if (existingSource) {
                    existingSource.messageId =
                        existingSource.messageId ?? row.messageId
                    existingSource.sessionId = row.sessionId
                    continue
                }
                sourceRows.push(row)
            }
            return {
                replaced: rows.length,
                conflicted: false,
                upsertedSources: sources.length
            }
        },
        listMessages: async (sessionId: string) =>
            [...(messagesBySession.get(sessionId) ?? [])].sort(
                (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
            ),
        listMessageSources: async (sessionId: string) =>
            sourceRows.filter((row) => row.sessionId === sessionId),
        upsertMessageSources: async (
            rows: Array<{
                sessionId: string
                messageId: string | null
                sourceEventKey: string
                rawText?: string | null
                rawJson?: unknown
            }>
        ) => {
            for (const row of rows) {
                const existing = sourceRows.find(
                    (item) => item.sourceEventKey === row.sourceEventKey
                )
                if (existing) {
                    existing.messageId = existing.messageId ?? row.messageId
                    existing.sessionId = row.sessionId
                    continue
                }
                sourceRows.push(row)
            }
            return { upserted: rows.length }
        },
        upsertMessageSourcesForIdleSession: async (
            sessionId: string,
            rows: Array<{
                sessionId: string
                messageId: string | null
                sourceEventKey: string
                rawText?: string | null
                rawJson?: unknown
            }>,
            frameworkSessionRef?: string
        ) => {
            for (const row of rows) {
                const existing = sourceRows.find(
                    (item) => item.sourceEventKey === row.sourceEventKey
                )
                if (existing) {
                    existing.messageId = existing.messageId ?? row.messageId
                    existing.sessionId = row.sessionId
                    continue
                }
                sourceRows.push(row)
            }
            if (frameworkSessionRef !== undefined) {
                const target = sessions.find((s) => s.id === sessionId)
                if (target) target.frameworkSessionRef = frameworkSessionRef
            }
            return { upserted: rows.length, conflicted: false }
        }
    }
    const drivers = {
        recoveryFsForAgent: async () => {
            if (options.recoveryFsError) throw options.recoveryFsError
            return { fs: {} }
        }
    }
    const reader = {
        readMessages: async (ctx: { frameworkSessionRef: string }) => {
            const duplicateTimestamp =
                ctx.frameworkSessionRef === 'same-time-ref'
                    ? '2026-05-10T10:00:00Z'
                    : undefined
            return {
                sourceFile: '/tmp/local-session.jsonl',
                warnings: [],
                messages: options.recoveredMessages ?? [
                    recovered(
                        'local-user',
                        'user',
                        'hello',
                        1,
                        ctx.frameworkSessionRef,
                        duplicateTimestamp
                    ),
                    recovered(
                        'local-assistant',
                        'assistant',
                        'missing',
                        2,
                        ctx.frameworkSessionRef,
                        duplicateTimestamp
                    )
                ]
            }
        },
        listCandidates: async () => {
            listCandidateCalls.count++
            return options.candidates ?? []
        }
    }
    const readers = {
        get: () => reader
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
        messagesBySession,
        sessions,
        sourceRows,
        listCandidateCalls
    }
}

const dbMessage = (
    id: string,
    role: ChatRole,
    contentBlocksJson: ChatContentBlock[]
) => ({
    id,
    sessionId: 'session-1',
    role,
    contentBlocksJson,
    capabilityEventsJson: null,
    createdAt: new Date('2026-05-10T10:00:00Z')
})

const recovered = (
    externalId: string,
    role: ChatRole,
    text: string,
    sourceSeq: number,
    sourceRef = 'local-ref',
    timestampOverride?: string
): RecoveredMessage => {
    const timestamp = timestampOverride ?? `2026-05-10T10:00:0${sourceSeq}Z`
    return {
        externalId,
        parentExternalId: null,
        role,
        contentBlocks: [{ type: 'text', text }],
        timestamp,
        model: role === 'assistant' ? 'gpt-5.4' : undefined,
        sources: [
            {
                sourceRef,
                sourceFile: '/tmp/local-session.jsonl',
                sourceSeq,
                externalId,
                parentExternalId: null,
                rawFormat: 'jsonl',
                rawText: JSON.stringify({
                    uuid: externalId,
                    parentUuid: null,
                    sessionId: sourceRef,
                    type: role,
                    timestamp,
                    message: {
                        role,
                        content: [{ type: 'text', text }]
                    }
                }),
                parserName: 'claude-code-session-jsonl',
                parserVersion: '1'
            }
        ]
    }
}

const candidate = (
    sessionRef: string,
    over: Partial<CandidateSession> = {}
): CandidateSession => ({
    sessionRef,
    sourceFile: `/tmp/${sessionRef}.jsonl`,
    firstUserMessage: 'hello',
    lastAssistantMessage: 'a reply',
    timestamp: '2026-05-10T10:00:00.000Z',
    lastActiveAt: '2026-05-10T12:00:00.000Z',
    messageCount: 4,
    model: 'gpt-5.4',
    ...over
})

test('agent session list joins a cloud session to its runtime transcript', async () => {
    // session-1's framework_session_ref is 'local-ref', so the two sides are
    // one row rather than two.
    const harness = makeHarness({ candidates: [candidate('local-ref')] })

    const listed = await harness.service.listAgentSessions('user-1', 'agent-1')

    assert.equal(listed.localScan, 'ok')
    assert.equal(listed.sessions.length, 1)
    const row = listed.sessions[0]
    assert.equal(row.cloudSessionId, 'session-1')
    assert.equal(row.sessionRef, 'local-ref')
    assert.equal(row.inCloud, true)
    assert.equal(row.inLocal, true)
    // The transcript is the fuller record, so its fields win on a joined row.
    assert.equal(row.lastAssistantMessage, 'a reply')
    assert.equal(row.lastActiveAt, '2026-05-10T12:00:00.000Z')
    assert.equal(row.model, 'gpt-5.4')
})

test('agent session list keeps local-only and cloud-only sessions apart', async () => {
    const harness = makeHarness({
        // 'other-ref' matches no cloud session; session-1 stays cloud-side
        // with its own 'local-ref' unscanned.
        candidates: [candidate('other-ref')]
    })

    const listed = await harness.service.listAgentSessions('user-1', 'agent-1')

    assert.equal(listed.sessions.length, 2)
    const localOnly = listed.sessions.find((r) => r.sessionRef === 'other-ref')
    assert.ok(localOnly)
    assert.equal(localOnly!.inLocal, true)
    assert.equal(localOnly!.inCloud, false)
    assert.equal(localOnly!.cloudSessionId, null)

    const cloudOnly = listed.sessions.find(
        (r) => r.cloudSessionId === 'session-1'
    )
    assert.ok(cloudOnly)
    assert.equal(cloudOnly!.inCloud, true)
    assert.equal(cloudOnly!.inLocal, false)
    // Nothing was read for it, so it must not claim the agent never replied.
    assert.equal(cloudOnly!.lastAssistantMessage, null)
    assert.equal(cloudOnly!.messageCount, 1)
})

test('agent session list is newest first across both sides', async () => {
    const harness = makeHarness({
        candidates: [
            candidate('older-ref', { lastActiveAt: '2026-05-01T00:00:00.000Z' }),
            candidate('newest-ref', { lastActiveAt: '2026-06-01T00:00:00.000Z' })
        ]
    })

    const listed = await harness.service.listAgentSessions('user-1', 'agent-1')

    const order = listed.sessions.map((r) => r.lastActiveAt ?? '')
    assert.deepEqual(order, [...order].sort().reverse())
    assert.equal(listed.sessions[0].sessionRef, 'newest-ref')
})

// A stopped sandbox used to 503 the whole panel. The cloud half is still
// knowable, and absence on the local side becomes unknown rather than false.
test('an unreachable runtime degrades the list instead of failing it', async () => {
    const harness = makeHarness({
        candidates: [candidate('local-ref')],
        recoveryFsError: new Error('sandbox is stopped')
    })

    const listed = await harness.service.listAgentSessions('user-1', 'agent-1')

    assert.equal(listed.localScan, 'unavailable')
    assert.equal(listed.sessions.length, 1)
    assert.equal(listed.sessions[0].cloudSessionId, 'session-1')
    assert.equal(listed.sessions[0].inCloud, true)
    assert.equal(listed.sessions[0].inLocal, false)
    assert.match(listed.warnings.join(' '), /sandbox is stopped/)
})

// Opening a session from the list must not re-scan every other transcript:
// the caller already paid for that scan, and the scan is the expensive half.
test('SessionRecoveryService viewRuntimeSession skips the scan when given a ref', async () => {
    const harness = makeHarness({ candidates: [candidate('local-ref')] })

    const viewed = await harness.service.viewRuntimeSession(
        'user-1',
        'agent-1',
        'session-1',
        'local-ref'
    )

    assert.equal(harness.listCandidateCalls.count, 0)
    assert.deepEqual(viewed.candidates, [])
    assert.equal(viewed.selectedSessionRef, 'local-ref')

    // Control: with no ref the server still has to pick, so it still scans.
    const control = makeHarness({ candidates: [candidate('local-ref')] })
    await control.service.viewRuntimeSession('user-1', 'agent-1')
    assert.equal(control.listCandidateCalls.count, 1)
})
