import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow, ChannelSessionRow } from '@manyfold/db'
import { parseSlashCommand } from '../src/modules/channels/slash/parser'
import {
    SLASH_COMMAND_SPECS,
    buildHelpText
} from '../src/modules/channels/slash/commands'
import { matchSession } from '../src/modules/channels/slash/match-session'
import {
    ChannelSlashDispatcher,
    type SlashDispatchContext
} from '../src/modules/channels/slash/slash-dispatcher.service'
import type { ChannelSessionWithChatTitle } from '../src/modules/channels/channels.repository'

test('parseSlashCommand recognizes /new without args', () => {
    const parsed = parseSlashCommand('/new')
    assert.deepEqual(parsed, { command: 'new', args: [], rest: '' })
})

test('parseSlashCommand parses /new with a multi-word name', () => {
    const parsed = parseSlashCommand('/new feat login fix')
    assert.equal(parsed?.command, 'new')
    assert.deepEqual(parsed?.args, ['feat', 'login', 'fix'])
    assert.equal(parsed?.rest, 'feat login fix')
})

test('parseSlashCommand normalizes command to lowercase', () => {
    const parsed = parseSlashCommand('/SWITCH 2')
    assert.equal(parsed?.command, 'switch')
})

test('parseSlashCommand returns null for plain text', () => {
    assert.equal(parseSlashCommand('hello'), null)
    assert.equal(parseSlashCommand('not /a slash command'), null)
    assert.equal(parseSlashCommand('/'), null)
    assert.equal(parseSlashCommand(''), null)
})

test('parseSlashCommand tolerates leading whitespace', () => {
    const parsed = parseSlashCommand('   /list 2')
    assert.equal(parsed?.command, 'list')
    assert.deepEqual(parsed?.args, ['2'])
})

const session = (
    over: Partial<ChannelSessionRow> & { id: string }
): ChannelSessionRow => ({
    channelId: 'chn-1',
    chatSessionId: `cts_${over.id}`,
    scopeKey: 'fake:chat-1',
    scopeName: null,
    remoteUserId: 'u',
    remoteThreadId: null,
    displayName: null,
    isActive: false,
    archivedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over
})

const item = (
    over: Partial<ChannelSessionRow> & { id: string },
    chatTitle: string | null = null
): ChannelSessionWithChatTitle => ({
    session: session(over),
    chatTitle
})

test('matchSession matches by numeric index (1-based)', () => {
    const items = [item({ id: 'chs_a' }), item({ id: 'chs_b' })]
    assert.equal(matchSession(items, '2')?.session.id, 'chs_b')
})

test('matchSession matches exact display_name case-insensitively', () => {
    const items = [
        item({ id: 'chs_a', displayName: 'Login Fix' }),
        item({ id: 'chs_b', displayName: 'Prod Debug' })
    ]
    assert.equal(matchSession(items, 'prod debug')?.session.id, 'chs_b')
    assert.equal(matchSession(items, 'PROD DEBUG')?.session.id, 'chs_b')
})

test('matchSession matches channel_session id prefix', () => {
    const items = [item({ id: 'chs_abc12345' }), item({ id: 'chs_xyz98765' })]
    assert.equal(matchSession(items, 'chs_xyz')?.session.id, 'chs_xyz98765')
})

test('matchSession matches chat_session id prefix', () => {
    const items = [
        item({ id: 'chs_a', chatSessionId: 'cts_aaaa' }),
        item({ id: 'chs_b', chatSessionId: 'cts_bbbb' })
    ]
    assert.equal(matchSession(items, 'cts_bbb')?.session.id, 'chs_b')
})

test('matchSession matches display_name prefix', () => {
    const items = [
        item({ id: 'chs_a', displayName: 'login fix' }),
        item({ id: 'chs_b', displayName: 'database migration' })
    ]
    assert.equal(matchSession(items, 'log')?.session.id, 'chs_a')
})

test('matchSession matches chat_session.title substring', () => {
    const items = [
        item({ id: 'chs_a' }, 'Refactor billing module'),
        item({ id: 'chs_b' }, 'Investigate flaky test')
    ]
    assert.equal(matchSession(items, 'flaky')?.session.id, 'chs_b')
})

test('matchSession returns null on no match', () => {
    const items = [item({ id: 'chs_a', displayName: 'foo' })]
    assert.equal(matchSession(items, 'nonexistent'), null)
})

test('matchSession ignores out-of-range numeric query', () => {
    const items = [item({ id: 'chs_a' })]
    assert.equal(matchSession(items, '5'), null)
    assert.equal(matchSession(items, '0'), null)
})

const baseChannel: ChannelRow = {
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'fake',
    label: 'test',
    status: 'active',
    configJson: { note: null },
    credentialsCiphertext: null,
    keyVersion: 1,
    externalId: null,
    origin: null,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    reconnectAttempts: 0,
    nextReconnectAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const baseCtx: SlashDispatchContext = {
    channel: baseChannel,
    scopeKey: 'fake:chat-1',
    scopeName: null,
    senderId: 'user-1',
    senderName: 'User 1',
    operator: true
}

const makeRouterMock = (
    rows: ChannelSessionRow[]
): {
    fork: (...args: unknown[]) => Promise<unknown>
    switchTo: (...args: unknown[]) => Promise<unknown>
    state: { forkCalls: number; switchCalls: number }
} => {
    const state = { forkCalls: 0, switchCalls: 0 }
    return {
        fork: async () => {
            state.forkCalls += 1
            for (const r of rows) r.isActive = false
            const newRow = session({
                id: `chs_new${rows.length + 1}`,
                isActive: true,
                createdAt: new Date(Date.now() + rows.length)
            })
            rows.push(newRow)
            return {
                session: newRow,
                chatSessionId: newRow.chatSessionId,
                isNew: true
            }
        },
        switchTo: async (...args: unknown[]) => {
            const targetId = args[2] as string
            state.switchCalls += 1
            for (const r of rows) r.isActive = r.id === targetId
            return {
                session: rows.find((r) => r.id === targetId),
                chatSessionId: rows.find((r) => r.id === targetId)
                    ?.chatSessionId,
                isNew: false
            }
        },
        state
    }
}

const inertChat = {
    hasInflightTurn: async () => false,
    cancelStream: async () => {}
}

const inertModelConfig = {
    getForAgent: async () => {
        throw new Error('not configured in test')
    },
    updateForAgent: async () => {
        throw new Error('not configured in test')
    }
}

const inertUsage = {
    summary: async () => ({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUsd: null,
        eventCount: 0,
        fallbackEventCount: 0,
        byModel: []
    })
}

const makeChatMock = (
    opts: { inflight?: boolean; callLog?: string[] } = {}
): {
    hasInflightTurn: (sessionId: string) => Promise<boolean>
    cancelStream: (
        userId: string,
        agentId: string,
        sessionId: string
    ) => Promise<void>
    calls: Array<{ userId: string; agentId: string; sessionId: string }>
} => {
    const calls: Array<{
        userId: string
        agentId: string
        sessionId: string
    }> = []
    return {
        hasInflightTurn: async () => opts.inflight === true,
        cancelStream: async (userId, agentId, sessionId) => {
            opts.callLog?.push('cancel')
            calls.push({ userId, agentId, sessionId })
        },
        calls
    }
}

const makeRepoMock = (
    rows: ChannelSessionRow[],
    opts: { dropCount?: number; callLog?: string[] } = {}
): {
    listScopeSessionsWithChatTitle: (
        channelId: string,
        scopeKey: string,
        opts?: { includeArchived?: boolean; archivedSince?: Date }
    ) => Promise<ChannelSessionWithChatTitle[]>
    findActiveSession: (
        channelId: string,
        scopeKey: string
    ) => Promise<ChannelSessionRow | null>
    renameSession: (
        id: string,
        name: string | null
    ) => Promise<ChannelSessionRow | null>
    archiveSession: (
        id: string,
        opts?: { activateFallback?: boolean }
    ) => Promise<{
        archived: ChannelSessionRow
        fallbackActivated: ChannelSessionRow | null
    }>
    dropQueuedInboundForScope: (
        channelId: string,
        scopeKey: string
    ) => Promise<number>
} => ({
    dropQueuedInboundForScope: async () => {
        opts.callLog?.push('drop')
        return opts.dropCount ?? 0
    },
    listScopeSessionsWithChatTitle: async (_ch, _sk, opts) => {
        return rows
            .filter((r) =>
                opts?.includeArchived
                    ? true
                    : opts?.archivedSince
                      ? r.archivedAt === null ||
                        r.archivedAt >= opts.archivedSince
                      : r.archivedAt === null
            )
            .map((r) => ({ session: r, chatTitle: null }))
    },
    findActiveSession: async () =>
        rows.find((r) => r.isActive && r.archivedAt === null) ?? null,
    renameSession: async (id, name) => {
        const row = rows.find((r) => r.id === id)
        if (!row) return null
        row.displayName = name
        return row
    },
    archiveSession: async (id, opts) => {
        const row = rows.find((r) => r.id === id)
        if (!row) throw new Error('not found')
        const wasActive = row.isActive
        row.isActive = false
        row.archivedAt = new Date()
        let fallback: ChannelSessionRow | null = null
        if (wasActive && opts?.activateFallback) {
            fallback =
                [...rows]
                    .filter((r) => !r.isActive && r.archivedAt === null)
                    .sort(
                        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
                    )[0] ?? null
            if (fallback) fallback.isActive = true
        }
        return { archived: row, fallbackActivated: fallback }
    }
})

test('tryParse ignores plain text and unknown slashes', () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    assert.equal(d.tryParse('hello'), null)
    assert.equal(d.tryParse('/summarize'), null)
    assert.equal(d.tryParse('/current-session'), null)
})

test('dispatcher tryParse ignores unknown commands', () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    assert.equal(d.tryParse('/foo'), null)
    assert.deepEqual(d.tryParse('/new')?.command, 'new')
})

test('/new creates a new active session and reports its index', async () => {
    const initial = session({
        id: 'chs_existing',
        isActive: true,
        createdAt: new Date(Date.now() - 1000)
    })
    const rows: ChannelSessionRow[] = [initial]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/new feat')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'session_forked')
    assert.match(result.replyText, /✓ New session #2/)
    assert.match(result.replyText, /feat/)
    assert.equal(router.state.forkCalls, 1)
})

test('/list with empty scope nudges to /new', async () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/list')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.match(result.replyText, /No sessions yet/)
})

test('/list renders active marker', async () => {
    const rows: ChannelSessionRow[] = [
        session({ id: 'chs_a', isActive: true, displayName: 'main' }),
        session({ id: 'chs_b' })
    ]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/list')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.match(result.replyText, /▶ 1\. 🏷️ «main»/)
    assert.match(result.replyText, /◻ 2\./)
})

test('/switch to existing inactive session activates it', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const b = session({
        id: 'chs_b',
        isActive: false,
        displayName: 'second',
        createdAt: new Date(Date.now() + 1)
    })
    const rows: ChannelSessionRow[] = [a, b]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/switch second')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'session_switched')
    assert.equal(router.state.switchCalls, 1)
    assert.equal(b.isActive, true)
    assert.equal(a.isActive, false)
})

test('/switch to archived session is rejected', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const b = session({
        id: 'chs_b',
        isActive: false,
        archivedAt: new Date(),
        displayName: 'old'
    })
    const rows: ChannelSessionRow[] = [a, b]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/switch old')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'noop')
    assert.match(result.replyText, /deleted/i)
    assert.equal(router.state.switchCalls, 0)
})

test('/rename without active session errors out', async () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/rename anything')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'noop')
    assert.match(result.replyText, /No active session/)
})

test('/rename sets display_name on active session', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const rows: ChannelSessionRow[] = [a]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/rename my feature')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'session_renamed')
    assert.equal(a.displayName, 'my feature')
})

test('/rename with empty value clears the display_name', async () => {
    const a = session({
        id: 'chs_a',
        isActive: true,
        displayName: 'old name'
    })
    const rows: ChannelSessionRow[] = [a]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/rename')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'session_renamed')
    assert.equal(a.displayName, null)
    assert.match(result.replyText, /Cleared/)
    assert.match(result.replyText, /old name/)
})

test('/rename with empty value on already-unnamed session is a no-op', async () => {
    const a = session({ id: 'chs_a', isActive: true, displayName: null })
    const rows: ChannelSessionRow[] = [a]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/rename')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'noop')
    assert.match(result.replyText, /No custom name/)
    assert.equal(a.displayName, null)
})

test('/delete archives a non-active session', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const b = session({ id: 'chs_b', displayName: 'old' })
    const rows: ChannelSessionRow[] = [a, b]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/delete old')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'session_archived')
    assert.notEqual(b.archivedAt, null)
    assert.equal(a.isActive, true)
})

test('/delete on active auto-activates the most recent fallback', async () => {
    const a = session({
        id: 'chs_a',
        isActive: true,
        createdAt: new Date(Date.now() - 1000)
    })
    const b = session({
        id: 'chs_b',
        isActive: false,
        createdAt: new Date(Date.now() - 500)
    })
    const c = session({
        id: 'chs_c',
        isActive: false,
        createdAt: new Date(Date.now() - 100)
    })
    const rows: ChannelSessionRow[] = [a, b, c]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/delete 1')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.sideEffect, 'session_archived')
    assert.notEqual(a.archivedAt, null)
    assert.equal(c.isActive, true)
    assert.equal(b.isActive, false)
})

test('/help lists all commands', async () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/help')!
    const result = await d.dispatch(parsed, baseCtx)
    for (const cmd of [
        '/new',
        '/list',
        '/switch',
        '/current',
        '/rename',
        '/delete',
        '/stop',
        '/help'
    ])
        assert.match(result.replyText, new RegExp(cmd.replace('/', '\\/')))
})

test('/help renders every command spec line verbatim', async () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/help')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.replyText, buildHelpText())
    assert.match(
        result.replyText,
        /\/rename \[name\] — rename the active session; empty value clears the custom name/
    )
})

test('slash command specs satisfy Telegram and Discord constraints', () => {
    for (const spec of SLASH_COMMAND_SPECS) {
        assert.match(spec.name, /^[a-z0-9_]{1,32}$/)
        assert.ok(
            spec.description.length >= 3 && spec.description.length <= 100,
            `description length out of range for /${spec.name}`
        )
        // /model is the only agent-wide (operator-gated) command; everything
        // else is session-scoped. If a new agent-scoped command is added, this
        // pins the reviewer to also wire its operator gate.
        assert.equal(
            spec.scope === 'agent',
            spec.name === 'model',
            `unexpected scope for /${spec.name}`
        )
        if (spec.arg) {
            assert.match(spec.arg.name, /^[a-z0-9_]{1,32}$/)
            assert.ok(
                spec.arg.description.length >= 1 &&
                    spec.arg.description.length <= 100
            )
        }
    }
})

test('/current with no active session nudges /new', async () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/current')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.match(result.replyText, /No active session/)
})

test('/current reports the active session', async () => {
    const a = session({ id: 'chs_a', isActive: true, displayName: 'main' })
    const rows: ChannelSessionRow[] = [a]
    const router = makeRouterMock(rows)
    const repo = makeRepoMock(rows)
    const d = new ChannelSlashDispatcher(
        repo as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const parsed = d.tryParse('/current')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.match(result.replyText, /Current: #1 🏷️ «main»/)
})

test('tryParse recognizes /stop', () => {
    const rows: ChannelSessionRow[] = []
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    assert.equal(d.tryParse('/stop')?.command, 'stop')
    assert.match(buildHelpText(), /\/stop/)
})

test('/stop cancels the inflight turn and reports discarded queue', async () => {
    const a = session({
        id: 'chs_a',
        isActive: true,
        chatSessionId: 'cts_active'
    })
    const rows: ChannelSessionRow[] = [a]
    const callLog: string[] = []
    const repo = makeRepoMock(rows, { dropCount: 2, callLog })
    const chat = makeChatMock({ inflight: true, callLog })
    const d = new ChannelSlashDispatcher(
        repo as never,
        makeRouterMock(rows) as never,
        chat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/stop')!, baseCtx)

    assert.equal(result.sideEffect, 'turn_stopped')
    assert.match(result.replyText, /Stopping/)
    assert.match(result.replyText, /Discarded 2 queued message\(s\)/)
    assert.deepEqual(chat.calls, [
        {
            userId: baseChannel.userId,
            agentId: baseChannel.agentId,
            sessionId: 'cts_active'
        }
    ])
    // The queue must be dropped before the cancel so the finalize drain kick
    // cannot start a queued message in the gap.
    assert.deepEqual(callLog, ['drop', 'cancel'])
})

test('/stop with no inflight turn but a queue only reports the discard', async () => {
    const a = session({
        id: 'chs_a',
        isActive: true,
        chatSessionId: 'cts_active'
    })
    const rows: ChannelSessionRow[] = [a]
    const repo = makeRepoMock(rows, { dropCount: 3 })
    const chat = makeChatMock({ inflight: false })
    const d = new ChannelSlashDispatcher(
        repo as never,
        makeRouterMock(rows) as never,
        chat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/stop')!, baseCtx)

    assert.equal(result.sideEffect, 'turn_stopped')
    assert.match(result.replyText, /No response in progress/)
    assert.match(result.replyText, /Discarded 3 queued message\(s\)/)
    assert.equal(chat.calls.length, 0)
})

test('/stop with nothing running or queued is a no-op', async () => {
    const rows: ChannelSessionRow[] = []
    const repo = makeRepoMock(rows, { dropCount: 0 })
    const chat = makeChatMock({ inflight: false })
    const d = new ChannelSlashDispatcher(
        repo as never,
        makeRouterMock(rows) as never,
        chat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/stop')!, baseCtx)

    assert.equal(result.sideEffect, 'noop')
    assert.equal(result.replyText, 'No response in progress.')
    assert.equal(chat.calls.length, 0)
})

test('/model with no arg shows the current model and options', async () => {
    const rows: ChannelSessionRow[] = []
    const modelConfig = {
        getForAgent: async () => ({
            framework: 'claude-code',
            config: { framework: 'claude-code', model: 'claude-sonnet-5' },
            options: [
                { value: 'claude-sonnet-5', label: 'Sonnet', enabled: true },
                { value: 'claude-opus-4-8', label: 'Opus', enabled: true },
                { value: 'disabled-one', label: 'x', enabled: false }
            ]
        }),
        updateForAgent: async () => {
            throw new Error('should not be called')
        }
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        modelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/model')!, baseCtx)
    assert.match(result.replyText, /Current model: claude-sonnet-5/)
    assert.match(result.replyText, /claude-opus-4-8/)
    assert.doesNotMatch(result.replyText, /disabled-one/)
})

test('/model <name> persists the agent default', async () => {
    const rows: ChannelSessionRow[] = []
    const calls: Array<{ model?: string | null }> = []
    const modelConfig = {
        getForAgent: async () => {
            throw new Error('should not be called')
        },
        updateForAgent: async (
            _userId: string,
            _agentId: string,
            body: { model?: string | null }
        ) => {
            calls.push(body)
            return {
                framework: 'claude-code',
                config: { framework: 'claude-code', model: body.model },
                options: []
            }
        }
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        modelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(
        d.tryParse('/model claude-opus-4-8')!,
        baseCtx
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.model, 'claude-opus-4-8')
    assert.match(result.replyText, /✓ Model set to «claude-opus-4-8»/)
    assert.match(result.replyText, /all sessions/)
})

test('/model relays a validation error message', async () => {
    const rows: ChannelSessionRow[] = []
    const modelConfig = {
        getForAgent: async () => {
            throw new Error('nope')
        },
        updateForAgent: async () => {
            throw new Error('model «bogus» is not available')
        }
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        modelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/model bogus')!, baseCtx)
    assert.match(
        result.replyText,
        /Could not set model: model «bogus» is not available/
    )
})

test('/model is denied for a non-operator actor and never touches model config', async () => {
    const rows: ChannelSessionRow[] = []
    let touched = false
    const modelConfig = {
        getForAgent: async () => {
            touched = true
            throw new Error('should not be called')
        },
        updateForAgent: async () => {
            touched = true
            throw new Error('should not be called')
        }
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        modelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/model claude-opus-4-8')!, {
        ...baseCtx,
        operator: false
    })
    assert.equal(result.denied, true)
    assert.equal(result.sideEffect, 'noop')
    assert.match(result.replyText, /operator/i)
    assert.match(result.replyText, /web app/i)
    assert.equal(touched, false)
})

test('/model no-arg is also denied for a non-operator actor', async () => {
    const rows: ChannelSessionRow[] = []
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/model')!, {
        ...baseCtx,
        operator: false
    })
    assert.equal(result.denied, true)
})

test('session-scoped commands are unaffected by operator=false', async () => {
    const rows: ChannelSessionRow[] = []
    const router = makeRouterMock(rows)
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        router as never,
        inertChat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/new nope')!, {
        ...baseCtx,
        operator: false
    })
    assert.equal(result.denied ?? false, false)
    assert.equal(result.sideEffect, 'session_forked')
    assert.equal(router.state.forkCalls, 1)
})

test('/usage reports session and 30-day agent totals', async () => {
    const rows: ChannelSessionRow[] = [session({ id: 'chs_a', isActive: true })]
    const queries: Array<Record<string, unknown>> = []
    const usage = {
        summary: async (q: Record<string, unknown>) => {
            queries.push(q)
            const isSession = q.sessionId !== undefined
            return {
                totalInputTokens: isSession ? 1200 : 5000,
                totalOutputTokens: isSession ? 300 : 2000,
                totalCacheReadTokens: 0,
                totalCacheCreationTokens: 0,
                totalCostUsd: isSession ? 0.042 : 0.5,
                eventCount: isSession ? 2 : 20,
                fallbackEventCount: 0,
                byModel: []
            }
        }
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        inertChat as never,
        inertModelConfig as never,
        usage as never
    )
    const result = await d.dispatch(d.tryParse('/usage')!, baseCtx)
    assert.equal(queries.length, 2)
    assert.equal(queries[0]?.sessionId, 'cts_chs_a')
    assert.equal(queries[1]?.sessionId, undefined)
    assert.ok(typeof queries[1]?.from === 'string')
    assert.match(
        result.replyText,
        /This session: 1.5k tokens · \$0.042 · 2 turn/
    )
    assert.match(
        result.replyText,
        /Agent \(30d\): 7.0k tokens · \$0.500 · 20 turn/
    )
})

test('/history lists recent messages truncated', async () => {
    const rows: ChannelSessionRow[] = [session({ id: 'chs_a', isActive: true })]
    const chat = {
        listMessagePage: async () => ({
            messages: [
                {
                    role: 'user',
                    contentBlocks: [{ type: 'text', text: 'hello there' }]
                },
                {
                    role: 'assistant',
                    contentBlocks: [
                        { type: 'text', text: 'hi, how can I help?' }
                    ]
                }
            ],
            hasMore: false,
            nextBefore: null
        })
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        chat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/history')!, baseCtx)
    assert.match(result.replyText, /You: hello there/)
    assert.match(result.replyText, /Bot: hi, how can I help\?/)
})

test('/history reports an empty session', async () => {
    const rows: ChannelSessionRow[] = [session({ id: 'chs_a', isActive: true })]
    const chat = {
        listMessagePage: async () => ({
            messages: [],
            hasMore: false,
            nextBefore: null
        })
    }
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        chat as never,
        inertModelConfig as never,
        inertUsage as never
    )
    const result = await d.dispatch(d.tryParse('/history')!, baseCtx)
    assert.match(result.replyText, /No messages in the active session yet/)
})
