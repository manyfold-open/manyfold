import type { TurnExecutionRow } from '@manyfold/db'
import { ChatService } from '../src/modules/chat/chat.service'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'
import { readyChatRunner, withRunnerCursors } from './chat-runner-fixture'

// adoptTurnExecution end to end with its seams faked: a sprites turn whose
// relay already delivered `delivered`, re-read from `transcript` by the
// framework's recovery. Returns what the adopter wrote: the stream events,
// the runtime-sync cursors it settled (and whether under its fence), and the
// usage it recorded.
export const runAdoption = async (opts: {
    framework: string
    transcript: string
    delivered: EmittedChatEvent[]
    prompt: string
    // The assistant message's creation; the recoveries reject an anchor
    // much older than it.
    createdAt: Date
    frameworkSessionRef: string
    runtimeSyncCursor?: number | null
}): Promise<{
    emitted: Array<{ type: string; payload: Record<string, unknown> }>
    cursors: Array<{ cursor: number | null; fenced: boolean }>
    usage: Array<Record<string, unknown>>
}> => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> =
        []
    const cursors: Array<{ cursor: number | null; fenced: boolean }> = []
    const usage: Array<Record<string, unknown>> = []
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: opts.framework,
        runtime: 'sprites',
        runtimeId: 'runtime-1',
        model: 'fallback-model',
        modelProviderId: null,
        modelProviderBuiltInId: null,
        daemonId: null,
        spriteName: 'sprite-1',
        workspacePath: '/w'
    }
    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => [agentRow] })
                }),
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
    }
    const execRow = {
        messageId: 'assistant-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        runtime: 'sprites',
        spriteName: 'sprite-1',
        execSessionId: null,
        upstreamTaskId: null,
        upstreamMessageId: null,
        ownerId: 'instance-under-test',
        generation: 2,
        leaseExpiresAt: new Date(0),
        state: 'adopting',
        adoptCount: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0)
    } as unknown as TurnExecutionRow
    const message = (
        id: string,
        role: 'user' | 'assistant',
        createdAt: Date,
        contentBlocksJson: unknown[]
    ) => ({
        id,
        sessionId: 'session-1',
        role,
        daemonId: role === 'assistant' ? 'dh_runner' : null,
        daemonExecRef: role === 'assistant' ? id : null,
        contentBlocksJson,
        capabilityEventsJson: null,
        cancelRequestedAt: null,
        abortDispatchedAt: null,
        createdAt
    })
    const repo = {
        getSessionById: async () => ({
            id: 'session-1',
            userId: 'user-1',
            agentId: 'agent-1',
            title: null,
            frameworkSessionRef: opts.frameworkSessionRef,
            runtimeSyncCursor: opts.runtimeSyncCursor ?? null,
            createdAt: new Date(),
            updatedAt: new Date()
        }),
        getMessageById: async () =>
            message('assistant-1', 'assistant', opts.createdAt, []),
        getTurnExecution: async () => ({ ...execRow, state: 'running' }),
        maxStreamEventSeq: async () => opts.delivered.length,
        listStreamEventsSince: async () =>
            opts.delivered.map((e, i) => ({
                id: BigInt(i + 1),
                eventType: e.type,
                payloadJson: e,
                sourceEventKey: null,
                sourceEventOrdinal: null
            })),
        listMessageSourceRows: async () => [],
        listForeignSourceUuids: async () => new Set<string>(),
        latestUserMessageBefore: async () =>
            message(
                'user-msg-1',
                'user',
                new Date(opts.createdAt.getTime() - 1000),
                [{ type: 'text', text: opts.prompt }]
            ),
        setRuntimeSyncCursor: async (
            _sessionId: string,
            cursor: number | null,
            fence?: unknown
        ) => {
            cursors.push({ cursor, fenced: fence !== undefined })
        },
        touchSession: async () => undefined,
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length,
            fenceLost: false
        }),
        writeAssistantContent: async () => ({
            written: true,
            fenceLost: false
        }),
        releaseInflightTurn: async () => true,
        renewTurnLease: async () => true,
        handoffOwnedTurn: async () => true,
        daemonSeenWithin: async () => false
    }
    const record = async (
        _messageId: string,
        event: { type: string; payload: Record<string, unknown> }
    ) => {
        emitted.push({ type: event.type, payload: event.payload })
        return { persisted: true, fenceLost: false }
    }
    const fs: RecoveryFs = {
        locate: async () => '/w/transcript.jsonl',
        readFile: async () => opts.transcript,
        listFiles: async () => []
    } as never
    const service = new ChatService(
        db as never,
        withRunnerCursors(repo as never),
        {
            hasStream: () => false,
            beginStream: () => undefined,
            setStreamFence: () => undefined,
            beginResumeStream: async () => undefined,
            endStream: () => undefined,
            emit: record,
            emitDetached: async (
                messageId: string,
                event: { type: string; payload: Record<string, unknown> }
            ) => {
                await record(messageId, event)
            }
        } as never,
        { get: () => ({ framework: opts.framework }) } as never,
        {
            record: async (row: { usage: Record<string, unknown> }) => {
                usage.push(row.usage)
            }
        } as never,
        {} as never,
        { publishStatus: () => undefined } as never,
        { event: () => undefined, error: () => undefined } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        readyChatRunner({
            recoveryFsForAgent: async () => ({
                fs,
                agent: agentRow,
                spritesClient: null
            })
        } as never),
        undefined,
        { emit: () => undefined } as never,
        {
            ownerId: 'instance-under-test',
            enabled: true,
            kick: () => {},
            stopClaiming: async () => undefined
        } as never
    )
    await service.adoptTurnExecution(execRow)
    return { emitted, cursors, usage }
}
