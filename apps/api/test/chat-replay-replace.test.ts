import type { ChatContentBlock } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TurnExecutionRow } from '@manyfold/db'
import type {
    ApiChatConvergeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { sanitizeForJsonb } from '../src/common/jsonb-sanitize'
import { ChatService } from '../src/modules/chat/chat.service'

// #689. chat_stream_events is the authoritative record of what a turn
// delivered and content_blocks_json is a cache of it (#688), so every recovery
// rebuilds its content by folding the log. `replace` is not a block in that
// log — it is a state transition that deletes the answer text delivered so
// far and installs a whole new one. That is how Dify reports output moderation
// and how the external convergence hands back a recovered answer.
//
// A fold that appends one block per row therefore reconstructs the answer the
// product already decided nobody should read, and the recovery writes it back
// at its terminal. These drive the real adoptTurnExecution over a scripted
// durable log: the property under test is that neither the terminal
// disposition nor the outcome of any checkpoint can put superseded text back
// in the row.

const OWNER_ID = 'instance-under-test'
const MODERATED = 'here is how to do the bad thing'
const SAFE = 'I cannot help with that.'

// The log holds what sse-broadcaster wrote, and writeRow() sanitises every
// payload on the way in — so a replayed payload is already jsonb-safe unless
// the row predates that.
const logged = (
    eventType: string,
    payload: Record<string, unknown>
): DurableRow => raw(eventType, sanitizeForJsonb(payload))

const raw = (eventType: string, payloadJson: unknown): DurableRow => ({
    eventType,
    payloadJson,
    sourceEventKey: null,
    sourceEventOrdinal: null
})

interface DurableRow {
    id?: bigint
    eventType: string
    payloadJson: unknown
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
}

interface ContentWrite {
    types: string[]
    text: string
    blocks: ChatContentBlock[]
    cursor: bigint | null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: 'conv-1',
    createdAt: new Date(0),
    updatedAt: new Date(0)
}

// The pre-recovery cache. Its value is the precondition each test sets up —
// the moderated text when the forced replace checkpoint never landed, the safe
// text when it did — and it is never what the recovery reads: the fold is over
// the log.
const messageRow = (contentBlocksJson: ChatContentBlock[]) => ({
    id: 'assistant-1',
    sessionId: 'session-1',
    role: 'assistant' as const,
    createdAt: new Date(),
    daemonId: null,
    daemonExecRef: null,
    contentBlocksJson,
    capabilityEventsJson: null,
    cancelRequestedAt: null,
    abortDispatchedAt: null
})

const executionRow = (): TurnExecutionRow => ({
    messageId: 'assistant-1',
    sessionId: 'session-1',
    agentId: 'agent-1',
    runtime: 'external',
    spriteName: null,
    execSessionId: null,
    upstreamTaskId: 'task-1',
    upstreamMessageId: 'dify-msg-1',
    ownerId: OWNER_ID,
    generation: 1,
    leaseExpiresAt: new Date(0),
    state: 'adopting',
    adoptCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0)
})

const makeHarness = (opts: {
    durable: DurableRow[]
    converge: () => AsyncIterable<EmittedChatEvent>
    cached?: ChatContentBlock[]
    failWriteAt?: number
    blockWriteAt?: number
}): {
    service: ChatService
    writes: ContentWrite[]
    emitted: string[]
    releaseWrite: () => void
} => {
    const writes: ContentWrite[] = []
    const emitted: string[] = []
    const message = messageRow(opts.cached ?? [])
    let attempted = 0
    let releaseWrite = (): void => undefined
    const blockedWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve
    })
    const writeContent = async (
        blocks: ChatContentBlock[],
        cursor: bigint | null
    ): Promise<boolean> => {
        const at = attempted++
        if (at === opts.blockWriteAt) await blockedWrite
        if (at === opts.failWriteAt) throw new Error('content write failed')
        writes.push({
            types: blocks.map((block) => block.type),
            text: blocks
                .map((block) => (block.type === 'text' ? block.text : ''))
                .join(''),
            blocks,
            cursor
        })
        return true
    }
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: 'dify',
        runtime: 'external',
        runtimeId: 'runtime-1',
        model: null,
        modelProviderId: null,
        modelProviderBuiltInId: null,
        daemonId: null,
        spriteName: null,
        workspacePath: null
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
        update: () => ({
            set: (values: {
                contentBlocksJson?: unknown
                contentCheckpointEventId?: bigint | null
            }) => ({
                where: async () => {
                    if (!('contentBlocksJson' in values)) return
                    await writeContent(
                        values.contentBlocksJson as ChatContentBlock[],
                        values.contentCheckpointEventId ?? null
                    )
                }
            })
        })
    }
    const repo = {
        getSession: async () => sessionRow,
        getSessionById: async () => sessionRow,
        getMessageById: async () => message,
        listStreamEventsSince: async () => opts.durable,
        maxStreamEventSeq: async () => 0n,
        writeAssistantContent: async (
            _messageId: string,
            blocks: ChatContentBlock[],
            cursor: bigint | null
        ) => writeContent(blocks, cursor),
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        upsertMessageSources: async () => undefined,
        releaseInflightTurn: async () => undefined,
        renewTurnLease: async () => true,
        handoffOwnedTurn: async () => true,
        upsertTurnExecution: async () => undefined,
        setTurnUpstreamRef: async () => undefined
    }
    const record = async (
        _messageId: string,
        event: { type: string },
        terminalContent?: {
            contentBlocksJson: ChatContentBlock[]
            contentCheckpointEventId: bigint | null
        }
    ): Promise<{ persisted: boolean }> => {
        emitted.push(event.type)
        if (terminalContent)
            await writeContent(
                terminalContent.contentBlocksJson,
                terminalContent.contentCheckpointEventId
            )
        return { persisted: true }
    }
    const broadcaster = {
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        hasStream: () => true,
        settle: async () => null,
        emit: record,
        emitDetached: async (messageId: string, event: { type: string }) => {
            await record(messageId, event)
            return true
        }
    }
    const adapter = {
        framework: 'dify',
        convergeTurn: (_ctx: ApiChatConvergeContext) => opts.converge()
    }
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        { record: async () => {} } as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        { event: () => {}, error: () => {} } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        {
            ownerId: OWNER_ID,
            enabled: true,
            kick: () => {},
            stopClaiming: async () => undefined
        } as never
    )
    return { service, writes, emitted, releaseWrite }
}

const until = async (ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000
    while (!ready()) {
        if (Date.now() > deadline)
            throw new Error('timed out waiting for state')
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
}

const serverRestart: EmittedChatEvent = {
    type: 'error',
    error: {
        code: 'server_restart',
        message: 'stream interrupted by server restart',
        retryable: true
    }
} as EmittedChatEvent

// The headline failure. The forced checkpoint #688 added had LANDED, so the
// row was correct when this process took over — and the recovery, folding a
// log it reads as append-only, overwrote a correct row with moderated text at
// its own terminal.
test('a recovery that errors out cannot resurrect a superseded answer', async () => {
    const h = makeHarness({
        cached: [{ type: 'text', text: SAFE }],
        durable: [
            { ...logged('token', { text: MODERATED }), id: 1n },
            {
                ...logged('replace', {
                    text: SAFE,
                    reason: 'output_moderation'
                }),
                id: 2n
            }
        ],
        converge: async function* () {
            yield serverRestart
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.ok(h.writes.length > 0, 'the recovery wrote the row')
    for (const write of h.writes) {
        assert.equal(write.text, SAFE)
        assert.ok(
            !write.text.includes(MODERATED),
            'no write may contain the superseded answer'
        )
    }
    assert.equal(
        h.writes[0]?.cursor,
        2n,
        'the repair is the exact fold through the replace row, so a cold attach must skip the superseded token'
    )
    assert.equal(
        h.writes.at(-1)?.cursor,
        null,
        'terminal content is cursorless'
    )
    assert.deepEqual(h.emitted, ['turn_status', 'error'])
})

// A cancel is the same window with a different terminal: the recovery gets no
// second replace from the upstream either way, so the fold is the only thing
// standing between the user and the moderated text.
test('a cancelled recovery cannot resurrect a superseded answer', async () => {
    const h = makeHarness({
        cached: [{ type: 'text', text: SAFE }],
        durable: [
            logged('token', { text: MODERATED }),
            logged('replace', { text: SAFE, reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield {
                type: 'error',
                error: {
                    code: 'cancelled_by_user',
                    message: 'cancelled',
                    retryable: false
                }
            } as EmittedChatEvent
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.ok(h.writes.length > 0, 'the recovery wrote the row')
    for (const write of h.writes) assert.equal(write.text, SAFE)
})

// The other half of #688's residual: the forced checkpoint FAILED, so the row
// still holds the moderated text, and the turn suspended inside the 2s retry
// backoff with no further event to drive a retry. Nothing else will ever look
// at this turn, so a recovery that reaches no terminal still has to repair
// what it inherited.
test('a recovery that suspends again repairs the row it inherited', async () => {
    const h = makeHarness({
        cached: [{ type: 'text', text: MODERATED }],
        durable: [
            { ...logged('token', { text: MODERATED }), id: 1n },
            {
                ...logged('replace', {
                    text: SAFE,
                    reason: 'output_moderation'
                }),
                id: 2n
            }
        ],
        converge: async function* () {
            yield {
                type: 'suspended',
                daemonId: 'dh-1',
                daemonExecRef: 'ref-1',
                reason: 'server_restart'
            } as EmittedChatEvent
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(
        h.writes.map((write) => write.text),
        [SAFE],
        'the superseded-content checkpoint landed before the suspend'
    )
})

test('a failed recovery-start repair is resampled before an immediate suspend', async () => {
    const h = makeHarness({
        cached: [{ type: 'text', text: MODERATED }],
        durable: [
            { ...logged('token', { text: MODERATED }), id: 1n },
            {
                ...logged('replace', {
                    text: SAFE,
                    reason: 'output_moderation'
                }),
                id: 2n
            }
        ],
        converge: async function* () {
            yield {
                type: 'suspended',
                daemonId: 'dh-1',
                daemonExecRef: 'ref-1',
                reason: 'server_restart'
            } as EmittedChatEvent
        },
        failWriteAt: 0
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(
        h.writes.map((write) => write.text),
        [SAFE],
        'the final drain retries the still-forced repair once from current content'
    )
    assert.equal(
        h.writes[0]?.cursor,
        2n,
        'an unchanged seed retains its durable cursor when the repair is retried'
    )
})

test('a failed repair cannot drop a later replace before suspension', async () => {
    const latest = 'the latest safe answer'
    const h = makeHarness({
        cached: [{ type: 'text', text: MODERATED }],
        durable: [
            logged('token', { text: MODERATED }),
            logged('replace', { text: SAFE, reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield {
                type: 'replace',
                text: latest,
                reason: 'upstream_converged'
            } as EmittedChatEvent
            yield {
                type: 'suspended',
                daemonId: 'dh-1',
                daemonExecRef: 'ref-1',
                reason: 'server_restart'
            } as EmittedChatEvent
        },
        blockWriteAt: 0,
        failWriteAt: 0
    })

    const adoption = h.service.adoptTurnExecution(executionRow())
    await until(() => h.emitted.includes('suspended'))
    h.releaseWrite()
    await adoption

    assert.deepEqual(
        h.writes.map((write) => write.text),
        [latest],
        'the failed in-flight prefix may drop its queued snapshot, but the final resample must recover the latest replace'
    )
    assert.equal(
        h.writes[0]?.cursor,
        null,
        'content extended by this recovery cannot claim the seed cursor'
    )
})

// "Checkpoint success or failure must not change the canonical content": here
// the recovery's OWN repair write fails, which the checkpointer absorbs by
// design, and the terminal content is still the superseding answer.
test('a failed repair checkpoint does not change what the terminal writes', async () => {
    const h = makeHarness({
        cached: [{ type: 'text', text: MODERATED }],
        durable: [
            logged('token', { text: MODERATED }),
            logged('replace', { text: SAFE, reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield serverRestart
        },
        failWriteAt: 0
    })

    await h.service.adoptTurnExecution(executionRow()).catch(() => undefined)

    assert.deepEqual(
        h.writes.map((write) => write.text),
        [SAFE],
        'the repair write failed; the terminal still superseded the answer'
    )
})

// A convergence that succeeds emits its own replace (#670), which is why this
// window was survivable at all — and it must compose with the replayed one
// rather than being confused by it.
test('a converged replace supersedes a replayed one', async () => {
    const h = makeHarness({
        durable: [
            logged('token', { text: MODERATED }),
            logged('replace', { text: SAFE, reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield {
                type: 'replace',
                text: 'the recovered answer',
                reason: 'upstream_converged'
            } as EmittedChatEvent
            yield {
                type: 'done',
                finalMessageId: 'assistant-1'
            } as EmittedChatEvent
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.equal(h.writes.at(-1)?.text, 'the recovered answer')
    for (const write of h.writes)
        assert.ok(!write.text.includes(MODERATED), write.text)
})

// Thinking and tool blocks record how the turn RAN and are not what was
// moderated, so the replayed transition keeps them exactly as the live buffer
// does — dropping them with the answer text would lose the turn's own record.
test('a replayed replace keeps the thinking and tool record', async () => {
    const h = makeHarness({
        durable: [
            logged('thinking', { text: 'reasoning' }),
            logged('tool_call', {
                toolCallId: 'call-1',
                toolName: 'read',
                args: { path: '/tmp/f' },
                elapsedMs: 3
            }),
            logged('tool_result', {
                toolCallId: 'call-1',
                result: { output: 'ok' },
                elapsedMs: 4
            }),
            logged('token', { text: MODERATED }),
            logged('replace', { text: SAFE, reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield serverRestart
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.writes.at(-1)?.blocks, [
        { type: 'thinking', text: 'reasoning' },
        {
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'read',
            args: { path: '/tmp/f' },
            elapsedMs: 3
        },
        {
            type: 'tool_result',
            toolCallId: 'call-1',
            result: { output: 'ok' },
            elapsedMs: 4
        },
        { type: 'text', text: SAFE }
    ])
})

// Dify's background moderation can fire more than once in a turn, and the
// convergence adds one of its own, so the fold has to keep only the last —
// while an empty replacement is a real outcome (moderation with no substitute)
// and must not fall back to the text it superseded.
test('consecutive and empty replayed replaces keep only the last answer', async () => {
    const h = makeHarness({
        durable: [
            logged('token', { text: 'first draft' }),
            logged('replace', { text: 'second', reason: 'output_moderation' }),
            logged('token', { text: ' plus tail' }),
            logged('replace', { text: 'third', reason: 'output_moderation' }),
            logged('replace', { text: SAFE, reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield serverRestart
        }
    })
    const empty = makeHarness({
        durable: [
            logged('token', { text: MODERATED }),
            logged('replace', { text: '', reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield serverRestart
        }
    })

    await h.service.adoptTurnExecution(executionRow())
    await empty.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.writes.at(-1)?.blocks, [{ type: 'text', text: SAFE }])
    assert.deepEqual(
        empty.writes.at(-1)?.blocks,
        [],
        'an empty replacement leaves no answer, exactly as a live one does'
    )
})

// Unlike every append case, a `replace` row with an unreadable payload is NOT
// skipped. The row's existence is the proof that the answer was superseded,
// and skipping the transition to keep the text it replaced is the whole bug —
// so an unreadable replacement supersedes the answer with nothing.
test('a replace row with no readable text still supersedes the answer', async () => {
    const h = makeHarness({
        durable: [
            logged('token', { text: MODERATED }),
            raw('replace', { reason: 'output_moderation' })
        ],
        converge: async function* () {
            yield serverRestart
        }
    })
    const nullPayload = makeHarness({
        durable: [logged('token', { text: MODERATED }), raw('replace', null)],
        converge: async function* () {
            yield serverRestart
        }
    })

    await h.service.adoptTurnExecution(executionRow())
    await nullPayload.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.writes.at(-1)?.blocks, [])
    assert.deepEqual(nullPayload.writes.at(-1)?.blocks, [])
})

// Blast radius. Rows the fold does not recognise, and payloads that do not
// carry the field their type promises, must leave the reconstruction alone
// rather than throwing inside a recovery — and a log with no replace in it
// must fold exactly as it always did.
test('a log without a replace folds to the same content as before', async () => {
    const h = makeHarness({
        durable: [
            logged('turn_status', { phase: 'recovering' }),
            logged('token', { text: 'partial ' }),
            raw('token', { text: 42 }),
            logged('thinking', { text: 'why' }),
            raw('tool_call', { toolName: 'read' }),
            logged('token', { text: 'answer' }),
            logged('usage', { usage: { inputTokens: 1, outputTokens: 2 } }),
            logged('error', {
                error: { code: 'server_restart', message: 'x', retryable: true }
            })
        ],
        converge: async function* () {
            yield serverRestart
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.writes.at(-1)?.blocks, [
        { type: 'text', text: 'partial ' },
        { type: 'thinking', text: 'why' },
        { type: 'text', text: 'answer' }
    ])
})

// The log is jsonb, so sse-broadcaster sanitised every payload on the way in
// and a replayed row is normally already safe. A row written before that
// sanitiser, or by anything else, must not be able to reach jsonb through the
// replay either — the replacement text goes through the same streaming
// sanitiser a live token does.
test('a replayed replace re-sanitises text a row should not have held', async () => {
    const NUL = String.fromCharCode(0)
    const HIGH = String.fromCharCode(0xd83d)
    const REPLACEMENT = String.fromCharCode(0xfffd)
    const h = makeHarness({
        durable: [
            raw('token', { text: `draft${NUL}` }),
            raw('replace', {
                text: `safe${NUL} ${HIGH}`,
                reason: 'output_moderation'
            })
        ],
        converge: async function* () {
            yield serverRestart
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.writes.at(-1)?.blocks, [
        { type: 'text', text: `safe ${REPLACEMENT}` }
    ])
})
