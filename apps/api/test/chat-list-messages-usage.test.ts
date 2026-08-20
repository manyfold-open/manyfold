import type { ChatContentBlock } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
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

const messageRow = (
    id: string,
    role: 'user' | 'assistant',
    blocks: ChatContentBlock[] = [{ type: 'text', text: 'x' }],
    capabilityEventsJson: unknown = null,
    createdAt = new Date('2026-04-30T00:00:00Z'),
    contentCheckpointEventId: bigint | null = null
): {
    id: string
    sessionId: string
    role: string
    contentBlocksJson: ChatContentBlock[]
    contentCheckpointEventId: bigint | null
    capabilityEventsJson: unknown
    createdAt: Date
} => ({
    id,
    sessionId: 'session-1',
    role,
    contentBlocksJson: blocks,
    contentCheckpointEventId,
    capabilityEventsJson,
    createdAt
})

const usageRow = (
    overrides: Partial<Record<string, unknown>> = {}
): {
    id: string
    userId: string
    agentId: string | null
    runtimeId: string | null
    sessionId: string | null
    messageId: string | null
    framework: string
    runtimeKind: string
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: string | null
    costSource: string
    isFallbackModel: boolean
    firstTokenMs: number | null
    totalMs: number | null
    createdAt: Date
} => ({
    id: 'usage-1',
    userId: 'user-1',
    agentId: 'agent-1',
    runtimeId: null,
    sessionId: 'session-1',
    messageId: 'msg-asst-1',
    framework: 'claude-code',
    runtimeKind: 'sprites',
    model: 'claude-sonnet-4-6',
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    costUsd: '0.045000',
    costSource: 'upstream',
    isFallbackModel: false,
    firstTokenMs: 800,
    totalMs: 4200,
    createdAt: new Date('2026-04-30T00:00:01Z'),
    ...overrides
})

type MessageRow = ReturnType<typeof messageRow>
type UsageRow = ReturnType<typeof usageRow>
type PageRow = { message: MessageRow; usage: UsageRow | null }

// Everything a listMessagePage read can observe, as one mutable value so a
// test can commit to it midway through a read the way a turn's owner commits
// to Postgres midway through a page fetch.
interface World {
    rows: PageRow[]
    inflight: string | null
    terminalErrors: Map<string, Record<string, unknown>>
    streamMaxEventId: bigint
}

const copyWorld = (world: World): World => ({
    rows: [...world.rows],
    inflight: world.inflight,
    terminalErrors: new Map(world.terminalErrors),
    streamMaxEventId: world.streamMaxEventId
})

const readsOf = (
    world: World,
    onPageRead?: () => void
): Record<string, unknown> => ({
    getSession: async () => sessionRow,
    terminalErrorsForMessages: async (ids: string[]) =>
        new Map([...world.terminalErrors].filter(([id]) => ids.includes(id))),
    latestInflightMessageId: async () => world.inflight,
    maxSessionStreamEventId: async () => world.streamMaxEventId,
    listMessagesWithUsage: async () => world.rows,
    listMessagePageWithUsage: async (
        _sessionId: string,
        opts: {
            limit: number
            before?: { createdAt: Date; id: string } | null
        }
    ) => {
        const page = world.rows
            .filter(({ message }) => {
                if (!opts.before) return true
                const timeDiff =
                    message.createdAt.getTime() -
                    opts.before.createdAt.getTime()
                if (timeDiff !== 0) return timeDiff < 0
                return message.id < opts.before.id
            })
            .sort((a, b) => {
                const timeDiff =
                    b.message.createdAt.getTime() -
                    a.message.createdAt.getTime()
                if (timeDiff !== 0) return timeDiff
                return b.message.id.localeCompare(a.message.id)
            })
            .slice(0, opts.limit)
        // The barrier: the rows are already read, so anything committed here
        // is exactly what lands between the page read and the reads after it.
        onPageRead?.()
        return page
    }
})

// A repository over a mutable world, plus readSnapshot() modelling what
// Postgres REPEATABLE READ gives listMessagePage: the callback reads from a
// view frozen when it opened, and a commit landing while it runs is invisible
// to it — while the same read taken OUTSIDE the callback sees that commit
// immediately. The asymmetry is the point, and the barrier fires on the page
// read either way: a listMessagePage that classified terminals or resolved
// the inflight identity outside the snapshot would observe the terminal,
// report no replay target, and still be shipping the pre-terminal row it read
// first.
const makeWorldRepo = (
    world: World,
    opts: { onPageRead?: () => void } = {}
): { repo: Record<string, unknown>; liveInflightReads: () => number } => {
    let liveInflightReads = 0
    const live = readsOf(world, opts.onPageRead)
    return {
        repo: {
            ...live,
            latestInflightMessageId: async () => {
                liveInflightReads += 1
                return world.inflight
            },
            readSnapshot: async (
                fn: (repo: unknown) => Promise<unknown>
            ): Promise<unknown> =>
                fn(readsOf(copyWorld(world), opts.onPageRead))
        },
        liveInflightReads: () => liveInflightReads
    }
}

const serviceOver = (repo: Record<string, unknown>): ChatService => {
    const db = {} as never
    const broadcaster = {} as never
    const adapters = {} as never
    const usage = {} as never
    const files = {} as never
    return new ChatService(
        db,
        repo as never,
        broadcaster,
        adapters,
        usage,
        files,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never
    )
}

const makeService = (
    rows: PageRow[],
    inflightAssistantMessageId: string | null = null
): ChatService =>
    serviceOver(
        makeWorldRepo({
            rows,
            inflight: inflightAssistantMessageId,
            terminalErrors: new Map(),
            streamMaxEventId: 0n
        }).repo
    )

test('listMessages attaches usage to assistant messages with a usage row', async () => {
    const userMsg = messageRow('msg-user-1', 'user')
    const asstMsg = messageRow(
        'msg-asst-1',
        'assistant',
        [{ type: 'text', text: 'x' }],
        { model: 'stale-config-model' }
    )
    const service = makeService([
        { message: userMsg, usage: null },
        { message: asstMsg, usage: usageRow() }
    ])

    const result = await service.listMessages('user-1', 'agent-1', 'session-1')

    assert.equal(result.length, 2)
    assert.equal(result[0].role, 'user')
    assert.equal(result[0].usage, null)
    assert.equal(result[1].role, 'assistant')
    assert.equal(result[1].model, 'claude-sonnet-4-6')
    assert.deepEqual(result[1].usage, {
        model: 'claude-sonnet-4-6',
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 500,
        cacheCreationTokens: 100,
        costUsd: 0.045,
        costSource: 'upstream',
        isFallbackModel: false,
        firstTokenMs: 800,
        totalMs: 4200
    })
})

test('listMessages returns null usage for assistant messages without a usage row', async () => {
    const asstMsg = messageRow(
        'msg-asst-1',
        'assistant',
        [{ type: 'text', text: 'x' }],
        { model: 'gpt-5.4' }
    )
    const service = makeService([{ message: asstMsg, usage: null }])

    const result = await service.listMessages('user-1', 'agent-1', 'session-1')

    assert.equal(result.length, 1)
    assert.equal(result[0].usage, null)
    assert.equal(result[0].model, 'gpt-5.4')
})

test('listMessages preserves null costUsd from rows where pricing was unknown', async () => {
    const asstMsg = messageRow('msg-asst-1', 'assistant')
    const service = makeService([
        {
            message: asstMsg,
            usage: usageRow({ costUsd: null, costSource: 'unknown' })
        }
    ])

    const result = await service.listMessages('user-1', 'agent-1', 'session-1')

    assert.equal(result[0].usage?.costUsd, null)
    assert.equal(result[0].usage?.costSource, 'unknown')
})

test('listMessages mixes assistant turns with and without usage rows', async () => {
    const m1 = messageRow('msg-asst-1', 'assistant')
    const m2 = messageRow('msg-asst-2', 'assistant')
    const m3 = messageRow('msg-asst-3', 'assistant')
    const service = makeService([
        { message: m1, usage: usageRow({ messageId: 'msg-asst-1' }) },
        { message: m2, usage: null },
        {
            message: m3,
            usage: usageRow({ id: 'usage-3', messageId: 'msg-asst-3' })
        }
    ])

    const result = await service.listMessages('user-1', 'agent-1', 'session-1')

    assert.equal(result.length, 3)
    assert.equal(result[0].usage?.model, 'claude-sonnet-4-6')
    assert.equal(result[1].usage, null)
    assert.equal(result[2].usage?.model, 'claude-sonnet-4-6')
})

test('listMessagePage returns the newest page in ascending order', async () => {
    const rows = [1, 2, 3, 4].map((n) => ({
        message: messageRow(
            `msg-${n}`,
            n % 2 === 0 ? 'assistant' : 'user',
            [{ type: 'text', text: String(n) }],
            null,
            new Date(`2026-04-30T00:00:0${n}Z`)
        ),
        usage: null
    }))
    const service = makeService(rows)

    const page = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        {
            limit: 2
        }
    )

    assert.deepEqual(
        page.messages.map((message) => message.id),
        ['msg-3', 'msg-4']
    )
    assert.equal(page.hasMore, true)
    assert.equal(typeof page.nextBefore, 'string')
})

test('listMessagePage uses nextBefore to load older messages', async () => {
    const rows = [1, 2, 3, 4].map((n) => ({
        message: messageRow(
            `msg-${n}`,
            'user',
            [{ type: 'text', text: String(n) }],
            null,
            new Date(`2026-04-30T00:00:0${n}Z`)
        ),
        usage: null
    }))
    const service = makeService(rows)
    const newest = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 2 }
    )

    const older = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 2, before: newest.nextBefore ?? undefined }
    )

    assert.deepEqual(
        older.messages.map((message) => message.id),
        ['msg-1', 'msg-2']
    )
    assert.equal(older.hasMore, false)
    assert.equal(older.nextBefore, null)
})

test('listMessagePage uses id as a stable timestamp tie breaker', async () => {
    const createdAt = new Date('2026-04-30T00:00:00Z')
    const rows = ['msg-a', 'msg-b', 'msg-c'].map((id) => ({
        message: messageRow(
            id,
            'user',
            [{ type: 'text', text: id }],
            null,
            createdAt
        ),
        usage: null
    }))
    const service = makeService(rows)

    const page = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        {
            limit: 2
        }
    )

    assert.deepEqual(
        page.messages.map((message) => message.id),
        ['msg-b', 'msg-c']
    )
})

test('listMessagePage reports the inflight assistant message id on the newest page', async () => {
    const userMsg = messageRow('msg-user-1', 'user')
    const asstMsg = messageRow('msg-asst-1', 'assistant')
    const service = makeService(
        [
            { message: userMsg, usage: null },
            { message: asstMsg, usage: null }
        ],
        'msg-asst-1'
    )

    const page = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    assert.equal(page.inflightAssistantMessageId, 'msg-asst-1')
})

// The cursor travels with the content it describes. It is read out of the
// rows this very response is returning, so a client can pair the two and
// attach with "these blocks plus the tail after this id" instead of replaying
// the turn from its first event.
test('listMessagePage ships the inflight turn checkpoint cursor beside its content', async () => {
    const userMsg = messageRow('msg-user-1', 'user')
    const asstMsg = messageRow(
        'msg-asst-1',
        'assistant',
        [{ type: 'text', text: 'partial answer' }],
        null,
        new Date('2026-04-30T00:00:00Z'),
        4242n
    )
    const service = makeService(
        [
            { message: userMsg, usage: null },
            { message: asstMsg, usage: null }
        ],
        'msg-asst-1'
    )

    const page = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    assert.equal(page.inflightCheckpointEventId, '4242')
    assert.deepEqual(
        page.messages.find((m) => m.id === 'msg-asst-1')?.contentBlocks,
        [{ type: 'text', text: 'partial answer' }]
    )
})

// No cursor means the pairing could not be trusted — the turn has not
// checkpointed yet, or it is on a path that cannot name one. The client has
// to fall back to the full replay, so this must not be invented.
test('listMessagePage reports no checkpoint cursor when the row carries none', async () => {
    const service = makeService(
        [{ message: messageRow('msg-asst-1', 'assistant'), usage: null }],
        'msg-asst-1'
    )

    const page = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    assert.equal(page.inflightAssistantMessageId, 'msg-asst-1')
    assert.equal(page.inflightCheckpointEventId, null)
})

test('listMessagePage omits the inflight id when paginating into older history', async () => {
    const rows = [1, 2, 3, 4].map((n) => ({
        message: messageRow(
            `msg-${n}`,
            'user',
            [{ type: 'text', text: String(n) }],
            null,
            new Date(`2026-04-30T00:00:0${n}Z`)
        ),
        usage: null
    }))
    const service = makeService(rows, 'msg-4')

    const newest = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 2 }
    )
    assert.equal(newest.inflightAssistantMessageId, 'msg-4')

    const older = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 2, before: newest.nextBefore ?? undefined }
    )
    assert.equal(older.inflightAssistantMessageId, null)
})

test('listMessagePage attaches usage to paginated assistant messages', async () => {
    const userMsg = messageRow('msg-user-1', 'user')
    const asstMsg = messageRow('msg-asst-1', 'assistant')
    const service = makeService([
        { message: userMsg, usage: null },
        { message: asstMsg, usage: usageRow() }
    ])

    const page = await service.listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        {
            limit: 2
        }
    )

    assert.equal(page.messages[0].id, 'msg-asst-1')
    assert.equal(page.messages[0].usage?.model, 'claude-sonnet-4-6')
})

// The terminal race (#723). These four build the interleaving directly: the
// page rows are read, the turn's owner then commits its terminal in the exact
// order runAdapter does — final content first, terminal event (which releases
// the inflight claim) second — and the rest of the read runs afterwards.
//
// The response must never be the one pairing that strands a tab: a
// PRE-terminal partial row shipped as ordinary history with no turn named for
// the client to replay. A bare SSE attach made after that terminal starts at
// the session's max event id, so the terminal is already behind the cursor
// and nothing else ever moves that tab off the half-answer.

const partialTurnWorld = (): World => ({
    rows: [
        { message: messageRow('msg-user-1', 'user'), usage: null },
        {
            message: messageRow(
                'msg-asst-1',
                'assistant',
                [{ type: 'text', text: 'half an ans' }],
                null,
                new Date('2026-04-30T00:00:01Z'),
                4242n
            ),
            usage: null
        }
    ],
    inflight: 'msg-asst-1',
    terminalErrors: new Map(),
    streamMaxEventId: 4242n
})

// persistTerminalContent() writes the finished blocks cursor-less and only
// then is the terminal row inserted, which is what clears the claim. Both
// land while the page read is between statements.
const commitTerminal = (
    world: World,
    error: Record<string, unknown> | null = null
): void => {
    world.rows = world.rows.map((row) =>
        row.message.id === 'msg-asst-1'
            ? {
                  ...row,
                  message: messageRow(
                      'msg-asst-1',
                      'assistant',
                      [
                          {
                              type: 'text',
                              text: 'half an answer, then the rest.'
                          }
                      ],
                      null,
                      new Date('2026-04-30T00:00:01Z'),
                      null
                  )
              }
            : row
    )
    if (error) world.terminalErrors.set('msg-asst-1', error)
    world.inflight = null
    world.streamMaxEventId = 4243n
}

test('a done terminal landing mid-read cannot strand a partial row without a replay target', async () => {
    const world = partialTurnWorld()
    const { repo, liveInflightReads } = makeWorldRepo(world, {
        onPageRead: () => commitTerminal(world)
    })

    const page = await serviceOver(repo).listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    // The row this response shipped is the pre-terminal one, so the turn it
    // belongs to has to be named. Stale by now — that is the safe direction:
    // subscribing with it replays the turn from its first event and delivers
    // the terminal the page could not see.
    assert.equal(page.inflightAssistantMessageId, 'msg-asst-1')
    assert.deepEqual(
        page.messages.find((message) => message.id === 'msg-asst-1')
            ?.contentBlocks,
        [{ type: 'text', text: 'half an ans' }]
    )
    // And the cursor still describes THAT content, not the finished row's.
    assert.equal(page.inflightCheckpointEventId, '4242')
    assert.equal(
        liveInflightReads(),
        0,
        'the inflight identity must come from the page snapshot'
    )
})

test('an error terminal landing mid-read is classified with the row it belongs to', async () => {
    const world = partialTurnWorld()
    const { repo } = makeWorldRepo(world, {
        onPageRead: () =>
            commitTerminal(world, {
                error: {
                    code: 'adapter_failed',
                    message: 'upstream gave up',
                    retryable: true
                }
            })
    })

    const page = await serviceOver(repo).listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    const assistant = page.messages.find(
        (message) => message.id === 'msg-asst-1'
    )
    assert.equal(page.inflightAssistantMessageId, 'msg-asst-1')
    assert.deepEqual(assistant?.contentBlocks, [
        { type: 'text', text: 'half an ans' }
    ])
    // A pre-terminal row carrying a terminal error is the same contradiction
    // read from the other end: the error arrived after this content, and the
    // client is told to replay the turn, which delivers it in order.
    assert.equal(assistant?.error, null)
})

test('an error terminal already committed before the read is attached to the finished row', async () => {
    const world = partialTurnWorld()
    commitTerminal(world, {
        error: {
            code: 'adapter_failed',
            message: 'upstream gave up',
            retryable: true
        }
    })
    const { repo } = makeWorldRepo(world)

    const page = await serviceOver(repo).listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    const assistant = page.messages.find(
        (message) => message.id === 'msg-asst-1'
    )
    assert.equal(page.inflightAssistantMessageId, null)
    assert.deepEqual(assistant?.contentBlocks, [
        { type: 'text', text: 'half an answer, then the rest.' }
    ])
    assert.deepEqual(assistant?.error, {
        code: 'adapter_failed',
        message: 'upstream gave up',
        retryable: true
    })
})

// The race read backwards. A turn that starts after the snapshot opens is
// absent from it rather than half-present, so there is no partial row for the
// response to strand. The page's idle stream cursor carries it across the
// handoff even if it finishes before subscribe; initialCursor is the fallback.
test('a turn starting after the snapshot opens is absent from the page, not half in it', async () => {
    const world: World = {
        rows: [{ message: messageRow('msg-user-1', 'user'), usage: null }],
        inflight: null,
        terminalErrors: new Map(),
        streamMaxEventId: 41n
    }
    const startTurn = (): void => {
        world.rows = [
            ...world.rows,
            {
                message: messageRow(
                    'msg-asst-1',
                    'assistant',
                    [{ type: 'text', text: 'half an ans' }],
                    null,
                    new Date('2026-04-30T00:00:01Z'),
                    4242n
                ),
                usage: null
            }
        ]
        world.inflight = 'msg-asst-1'
        world.streamMaxEventId = 4242n
    }
    const { repo, liveInflightReads } = makeWorldRepo(world, {
        onPageRead: startTurn
    })

    const page = await serviceOver(repo).listMessagePage(
        'user-1',
        'agent-1',
        'session-1',
        { limit: 10 }
    )

    assert.deepEqual(
        page.messages.map((message) => message.id),
        ['msg-user-1']
    )
    assert.equal(page.inflightAssistantMessageId, null)
    assert.equal(page.inflightCheckpointEventId, null)
    assert.equal(page.streamCursorEventId, '41')
    assert.equal(liveInflightReads(), 0)
})
