import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow, ChannelSessionRow } from '@manyfold/db'
import {
    ChannelSlashDispatcher,
    type SlashDispatchContext
} from '../src/modules/channels/slash/slash-dispatcher.service'
import { FakeChannelProvider } from '../src/modules/channels/providers/fake.provider'
import type {
    ChannelCommandView,
    ChannelContext,
    NormalizedInboundAction
} from '../src/modules/channels/channel-provider'
import type { ChannelSessionWithChatTitle } from '../src/modules/channels/channels.repository'

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
    operator: false
}

const makeDispatcher = (rows: ChannelSessionRow[]): ChannelSlashDispatcher =>
    new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        makeRouterMock(rows) as never,
        {} as never,
        {} as never,
        {} as never
    )

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

const makeRepoMock = (rows: ChannelSessionRow[]) => ({
    listScopeSessionsWithChatTitle: async (
        _ch: string,
        _sk: string,
        opts?: { includeArchived?: boolean; archivedSince?: Date }
    ): Promise<ChannelSessionWithChatTitle[]> => {
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
    archiveSession: async (
        id: string,
        opts?: { activateFallback?: boolean }
    ) => {
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

const makeRouterMock = (rows: ChannelSessionRow[]) => ({
    fork: async () => {
        for (const r of rows) r.isActive = false
        const row = session({
            id: `chs_new${rows.length + 1}`,
            isActive: true,
            createdAt: new Date(Date.now() + rows.length)
        })
        rows.push(row)
        return { session: row, chatSessionId: row.chatSessionId, isNew: true }
    },
    switchTo: async (_c: unknown, _sk: string, targetId: string) => {
        for (const r of rows) r.isActive = r.id === targetId
        const row = rows.find((r) => r.id === targetId)!
        return { session: row, chatSessionId: row.chatSessionId, isNew: false }
    }
})

test('/list result includes a session_list view with stable channelSessionId', async () => {
    const a = session({ id: 'chs_a', isActive: true, displayName: 'first' })
    const b = session({
        id: 'chs_b',
        displayName: 'second',
        createdAt: new Date(Date.now() + 1)
    })
    const rows = [a, b]
    const d = makeDispatcher(rows)
    const parsed = d.tryParse('/list')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.view?.kind, 'session_list')
    if (result.view?.kind !== 'session_list')
        throw new Error('expected session_list view')
    assert.equal(result.view.items.length, 2)
    assert.equal(result.view.items[0].channelSessionId, 'chs_a')
    assert.equal(result.view.items[1].channelSessionId, 'chs_b')
    assert.equal(result.view.items[0].isActive, true)
})

test('/current result includes a session_detail view', async () => {
    const a = session({ id: 'chs_a', isActive: true, displayName: 'main' })
    const rows = [a]
    const d = makeDispatcher(rows)
    const parsed = d.tryParse('/current')!
    const result = await d.dispatch(parsed, baseCtx)
    assert.equal(result.view?.kind, 'session_detail')
    if (result.view?.kind !== 'session_detail') return
    assert.equal(result.view.item?.channelSessionId, 'chs_a')
})

test('dispatchAction routes act:/switch-session by stable id', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const b = session({ id: 'chs_b', displayName: 'second' })
    const rows = [a, b]
    const d = makeDispatcher(rows)
    const action: NormalizedInboundAction = {
        providerEventId: 'evt-1',
        chatId: 'chat-1',
        chatType: 'private',
        senderId: 'user-1',
        senderName: null,
        threadId: null,
        action: 'act:/switch-session',
        targetChannelSessionId: 'chs_b',
        targetPage: null,
        scopeKey: 'fake:chat-1',
        raw: {}
    }
    const result = await d.dispatchAction(action, baseCtx)
    assert.equal(result.sideEffect, 'session_switched')
    assert.equal(b.isActive, true)
    assert.equal(a.isActive, false)
})

test('dispatchAction nav:/list-page re-renders without side effect', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const rows = [a]
    const d = makeDispatcher(rows)
    const action: NormalizedInboundAction = {
        providerEventId: 'evt-2',
        chatId: 'chat-1',
        chatType: 'private',
        senderId: 'user-1',
        senderName: null,
        threadId: null,
        action: 'nav:/list-page',
        targetChannelSessionId: null,
        targetPage: 1,
        scopeKey: 'fake:chat-1',
        raw: {}
    }
    const result = await d.dispatchAction(action, baseCtx)
    assert.equal(result.sideEffect, 'noop')
    assert.equal(result.view?.kind, 'session_list')
})

test('dispatchAction act:/new-session forks a session', async () => {
    const a = session({ id: 'chs_a', isActive: true })
    const rows = [a]
    const router = makeRouterMock(rows)
    const d = new ChannelSlashDispatcher(
        makeRepoMock(rows) as never,
        router as never,
        {} as never,
        {} as never,
        {} as never
    )
    const action: NormalizedInboundAction = {
        providerEventId: 'evt-3',
        chatId: 'chat-1',
        chatType: 'private',
        senderId: 'user-1',
        senderName: null,
        threadId: null,
        action: 'act:/new-session',
        targetChannelSessionId: null,
        targetPage: null,
        scopeKey: 'fake:chat-1',
        raw: {}
    }
    const result = await d.dispatchAction(action, baseCtx)
    assert.equal(result.sideEffect, 'session_forked')
    assert.equal(rows.length, 2)
    assert.equal(rows[1].isActive, true)
    assert.equal(a.isActive, false)
})

test('dispatchAction returns helpful text for unknown verb', async () => {
    const rows: ChannelSessionRow[] = []
    const d = makeDispatcher(rows)
    const action: NormalizedInboundAction = {
        providerEventId: 'evt-4',
        chatId: 'chat-1',
        chatType: 'private',
        senderId: 'user-1',
        senderName: null,
        threadId: null,
        action: 'act:/wat',
        targetChannelSessionId: null,
        targetPage: null,
        scopeKey: 'fake:chat-1',
        raw: {}
    }
    const result = await d.dispatchAction(action, baseCtx)
    assert.equal(result.sideEffect, 'noop')
    assert.match(result.replyText, /Unknown action/)
})

test('FakeChannelProvider.parseInboundAction parses a valid body', () => {
    const provider = new FakeChannelProvider()
    const action = provider.parseInboundAction({
        headers: {},
        body: {
            eventId: 'evt-1',
            chatId: 'chat-1',
            chatType: 'private',
            senderId: 'user-1',
            action: 'act:/switch-session',
            targetChannelSessionId: 'chs_xxx',
            scopeKey: 'fake:chat-1'
        }
    })
    assert.equal(action?.action, 'act:/switch-session')
    assert.equal(action?.targetChannelSessionId, 'chs_xxx')
    assert.equal(action?.scopeKey, 'fake:chat-1')
})

test('FakeChannelProvider.parseInboundAction returns null for non-action bodies', () => {
    const provider = new FakeChannelProvider()
    assert.equal(
        provider.parseInboundAction({
            headers: {},
            body: { text: 'plain message', chatId: 'c', senderId: 's' }
        }),
        null
    )
    assert.equal(provider.parseInboundAction({ headers: {}, body: null }), null)
    assert.equal(
        provider.parseInboundAction({
            headers: {},
            body: { action: 'act:/foo', chatId: 'c' }
        }),
        null
    )
})

test('FakeChannelProvider.sendCommandView captures the view', async () => {
    const provider = new FakeChannelProvider()
    const ctx: ChannelContext = {
        channel: baseChannel,
        config: { note: null },
        credentials: null
    }
    const view: ChannelCommandView = {
        kind: 'session_list',
        text: 'sessions list',
        items: [],
        page: { current: 1, total: 1 }
    }
    await provider.sendCommandView(ctx, 'fake:chat-1', view)
    const captures = provider.drainOutbound('chn-1')
    assert.equal(captures.length, 1)
    assert.equal(captures[0].kind, 'command-view')
    if (captures[0].kind !== 'command-view') return
    assert.equal(captures[0].view.kind, 'session_list')
})
