import type { WeixinChannelConfig } from '@manyfold/shared'
import { Logger } from '@nestjs/common'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ChannelProviderStateRow, ChannelRow } from '@manyfold/db'
import type { ChannelsRepository } from '../src/modules/channels/channels.repository'
import type {
    NormalizedInboundEvent,
    ChannelContext
} from '../src/modules/channels/channel-provider'
import { ChannelManagerService } from '../src/modules/channels/channel-manager.service'
import { WeixinChannelProvider } from '../src/modules/channels/providers/weixin.provider'
import {
    weixinGetUpdates,
    weixinSendMessage
} from '../src/modules/channels/providers/weixin-ilink'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-weixin-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'weixin',
    label: 'weixin test',
    status: 'active',
    configJson: {},
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
    updatedAt: new Date(),
    ...overrides
})

const baseConfig = (
    overrides: Partial<WeixinChannelConfig> = {}
): WeixinChannelConfig => ({
    botId: '05f361@im.bot',
    allowedUserIds: [],
    operatorUserIds: [],
    progressMode: 'final',
    outboundFiles: true,
    contextProjection: true,
    resetOnIdleMins: null,
    ...overrides
})

const credentials = {
    botToken: 'weixin-bot-token-123456',
    baseUrl: null
}

const ctxFor = (
    channel = makeChannel(),
    config = baseConfig()
): ChannelContext => ({ channel, config, credentials })

class FakeWeixinRepo {
    stateJson: unknown = null
    upserts = 0

    async getProviderState(
        channelId: string
    ): Promise<ChannelProviderStateRow | null> {
        if (!this.stateJson) return null
        return {
            channelId,
            stateJson: this.stateJson,
            createdAt: new Date(),
            updatedAt: new Date()
        } as ChannelProviderStateRow
    }

    async upsertProviderState(row: {
        channelId: string
        stateJson: unknown
    }): Promise<ChannelProviderStateRow> {
        this.upserts += 1
        this.stateJson = row.stateJson
        return {
            channelId: row.channelId,
            stateJson: row.stateJson,
            createdAt: new Date(),
            updatedAt: new Date()
        } as ChannelProviderStateRow
    }
}

const providerFor = (repo = new FakeWeixinRepo()): WeixinChannelProvider =>
    new WeixinChannelProvider(repo as unknown as ChannelsRepository)

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })

const abortingResponse = (
    signal: AbortSignal | null | undefined
): Promise<Response> =>
    new Promise((_resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
        }
        signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
        )
    })

const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 1000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('timed out waiting for condition')
}

const textMessage = (
    from: string,
    text: string,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
    seq: 1,
    message_id: 100,
    from_user_id: from,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: 'ctx-token-1',
    ...overrides
})

test('weixin validateConfig normalizes and validateCredentials requires token', () => {
    const provider = providerFor()
    const config = provider.validateConfig({
        botId: '  bot@im.bot ',
        allowedUserIds: [' wxid_a@im.wechat ', '', 'wxid_a@im.wechat'],
        operatorUserIds: ['wxid_op@im.wechat'],
        outboundFiles: false,
        progressMode: 'final'
    })
    assert.equal(config.botId, 'bot@im.bot')
    assert.deepEqual(config.allowedUserIds, ['wxid_a@im.wechat'])
    assert.deepEqual(config.operatorUserIds, ['wxid_op@im.wechat'])
    assert.equal(config.outboundFiles, false)

    assert.throws(() => provider.validateCredentials({ botToken: 'short' }))
    assert.throws(() =>
        provider.validateCredentials({ botToken: 'has space token' })
    )
    const creds = provider.validateCredentials({
        botToken: '  weixin-bot-token-abcdef  ',
        baseUrl: 'https://idc.ilinkai.weixin.qq.com/'
    })
    assert.equal(creds?.botToken, 'weixin-bot-token-abcdef')
    assert.equal(creds?.baseUrl, 'https://idc.ilinkai.weixin.qq.com')
})

test('weixin a replacement token keeps the stored gateway unless one is named', () => {
    const provider = providerFor()
    const international = 'https://ilinkai.wechat.com'
    const previous = { botToken: 'weixin-bot-token-old', baseUrl: international }
    // The settings form sends baseUrl: null; the CLI may leave it out.
    for (const update of [
        { botToken: 'weixin-bot-token-new' },
        { botToken: 'weixin-bot-token-new', baseUrl: null }
    ])
        assert.deepEqual(provider.validateCredentials(update, { previous }), {
            botToken: 'weixin-bot-token-new',
            baseUrl: international
        })
    assert.equal(
        provider.validateCredentials(
            {
                botToken: 'weixin-bot-token-new',
                baseUrl: 'https://ilinkai.weixin.qq.com/'
            },
            { previous }
        )?.baseUrl,
        'https://ilinkai.weixin.qq.com',
        'a named gateway still wins'
    )
    // Without stored credentials (create), an unnamed gateway is the default.
    for (const opts of [undefined, { previous: null }])
        assert.equal(
            provider.validateCredentials(
                { botToken: 'weixin-bot-token-new', baseUrl: null },
                opts
            )?.baseUrl,
            null
        )
})

test('weixin computeScopeKey and evaluateInboundActor', () => {
    const provider = providerFor()
    const event = {
        senderId: 'wxid_a@im.wechat',
        senderName: null
    } as NormalizedInboundEvent
    assert.equal(
        provider.computeScopeKey(event).scopeKey,
        'weixin:dm:wxid_a%40im.wechat'
    )

    // Empty allowlist = everyone allowed, not operator.
    assert.deepEqual(provider.evaluateInboundActor(event, baseConfig()), {
        allowed: true,
        operator: false
    })
    // Non-empty allowlist without the sender = rejected.
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['wxid_other@im.wechat'] })
        ),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    // Operator is implicitly allowed even when not in allowedUserIds.
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({
                allowedUserIds: ['wxid_other@im.wechat'],
                operatorUserIds: ['wxid_a@im.wechat']
            })
        ),
        { allowed: true, operator: true }
    )
})

test('weixin register verifies token via notifystart and returns activate', async (t) => {
    const provider = providerFor()
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return jsonResponse({ ret: 0 })
    }) as typeof fetch

    const result = await provider.register(ctxFor())
    assert.equal(result.ok, true)
    assert.equal(result.activate, true)
    assert.equal(calls.length, 1)
    assert.match(calls[0], /ilink\/bot\/msg\/notifystart$/)
})

test('weixin register fails closed on -14 stale session', async (t) => {
    const provider = providerFor()
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        jsonResponse({
            errcode: -14,
            errmsg: 'session timeout'
        })) as typeof fetch

    const result = await provider.register(ctxFor())
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /session expired/)
    assert.equal(result.activate, undefined)
})

test('weixin start baseline sync drops backlog then dispatches new messages', async (t) => {
    const repo = new FakeWeixinRepo()
    const provider = providerFor(repo)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    let poll = 0
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => {
        const url = String(input)
        if (url.endsWith('/ilink/bot/msg/notifystart'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/msg/notifystop'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/getupdates')) {
            poll += 1
            if (poll === 1)
                // Baseline: empty cursor replays a backlog message; must be dropped.
                return jsonResponse({
                    ret: 0,
                    get_updates_buf: 'cursor-1',
                    msgs: [textMessage('wxid_a@im.wechat', 'old backlog')]
                })
            if (poll === 2)
                return jsonResponse({
                    ret: 0,
                    get_updates_buf: 'cursor-2',
                    msgs: [
                        textMessage('wxid_a@im.wechat', 'new hello', {
                            message_id: 200
                        })
                    ]
                })
            return abortingResponse(init?.signal)
        }
        return jsonResponse({ error: 'unexpected' }, 500)
    }) as typeof fetch

    const events: NormalizedInboundEvent[] = []
    const statuses: string[] = []
    const handle = await provider.start(
        ctxFor(),
        async (event) => {
            events.push(event)
        },
        (status) => {
            statuses.push(status)
        }
    )

    await waitFor(() => events.length >= 1)
    await handle.stop()

    assert.equal(events.length, 1)
    assert.equal(events[0].text, 'new hello')
    assert.equal(events[0].senderId, 'wxid_a@im.wechat')
    assert.ok(statuses.includes('connected'))
    // Cursor persisted at baseline before any dispatch.
    assert.equal((repo.stateJson as { syncBuf?: string }).syncBuf, 'cursor-2')
})

test('weixin persists context tokens (incl. dropped senders) before dispatch', async (t) => {
    const repo = new FakeWeixinRepo()
    // Pretend a cursor already exists so we skip baseline and dispatch directly.
    repo.stateJson = { syncBuf: 'cursor-0', contextTokens: {} }
    const provider = providerFor(repo)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    let poll = 0
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => {
        const url = String(input)
        if (url.endsWith('/ilink/bot/msg/notifystart'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/msg/notifystop'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/getupdates')) {
            poll += 1
            if (poll === 1)
                return jsonResponse({
                    ret: 0,
                    get_updates_buf: 'cursor-1',
                    msgs: [
                        textMessage('wxid_a@im.wechat', 'hi', {
                            context_token: 'fresh-token-a'
                        })
                    ]
                })
            return abortingResponse(init?.signal)
        }
        return jsonResponse({ error: 'unexpected' }, 500)
    }) as typeof fetch

    const events: NormalizedInboundEvent[] = []
    const handle = await provider.start(ctxFor(), async (event) => {
        // State must already carry the fresh token when the bridge is invoked.
        const tokens = (
            repo.stateJson as { contextTokens?: Record<string, string> }
        ).contextTokens
        assert.equal(tokens?.['wxid_a@im.wechat'], 'fresh-token-a')
        events.push(event)
    })

    await waitFor(() => events.length >= 1)
    await handle.stop()
    assert.equal(events.length, 1)
})

test('weixin start pauses on -14 and reports error status', async (t) => {
    const repo = new FakeWeixinRepo()
    repo.stateJson = { syncBuf: 'cursor-0', contextTokens: {} }
    const provider = providerFor(repo)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/ilink/bot/msg/notifystart'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/msg/notifystop'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/getupdates'))
            return jsonResponse({ errcode: -14, errmsg: 'session timeout' })
        return jsonResponse({ error: 'unexpected' }, 500)
    }) as typeof fetch

    const statuses: Array<{ status: string; message?: string }> = []
    const handle = await provider.start(
        ctxFor(),
        async () => undefined,
        (status, detail) => {
            statuses.push({ status, message: detail?.message })
        }
    )

    await waitFor(() => statuses.some((s) => s.status === 'error'))
    await handle.stop()
    const err = statuses.find((s) => s.status === 'error')
    assert.match(err?.message ?? '', /session expired/)
})

const flushPoll = async (): Promise<void> => {
    for (let i = 0; i < 6; i++)
        await new Promise<void>((resolve) => setImmediate(resolve))
}

for (const [boundaryStatus, initialCursor] of [
    [524, ''],
    [524, 'saved-cursor'],
    [554, ''],
    [554, 'saved-cursor']
] as const) {
    test(`weixin ${boundaryStatus} boundaries preserve ${initialCursor || 'empty'} cursor until a real response`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
        t.mock.method(Math, 'random', () => 0.5)
        const repo = new FakeWeixinRepo()
        repo.stateJson = { syncBuf: initialCursor, contextTokens: {} }
        const provider = providerFor(repo)
        const warnings = t.mock.method(Logger.prototype, 'warn', () => {})
        const cursors: string[] = []
        const statuses: string[] = []
        const events: NormalizedInboundEvent[] = []
        let stops = 0
        t.mock.method(
            globalThis,
            'fetch',
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = new URL(String(input))
                assert.equal(url.origin, 'https://ilinkai.wechat.com')
                if (url.pathname.endsWith('/notifystop')) {
                    stops++
                    return jsonResponse({ ret: 0 })
                }
                assert.ok(url.pathname.endsWith('/getupdates'))
                cursors.push(JSON.parse(String(init?.body)).get_updates_buf)
                if (cursors.length <= 2)
                    return new Response('edge timeout', {
                        status: boundaryStatus
                    })
                if (cursors.length === 3)
                    return jsonResponse({
                        ret: 0,
                        get_updates_buf: 'real-cursor',
                        msgs: [textMessage('peer', 'first real batch')]
                    })
                if (cursors.length === 4)
                    return jsonResponse({
                        ret: 0,
                        get_updates_buf: 'next-cursor',
                        msgs: [
                            textMessage('peer', 'new message', {
                                message_id: 201
                            })
                        ]
                    })
                return abortingResponse(init?.signal)
            }
        )
        const handle = await provider.start(
            {
                ...ctxFor(),
                credentials: {
                    ...credentials,
                    baseUrl: 'https://ilinkai.wechat.com'
                }
            },
            async (event) => {
                events.push(event)
            },
            (status) => {
                statuses.push(status)
            }
        )
        t.after(() => handle.stop())
        await flushPoll()
        // A held long poll proves the session is alive, but only a real
        // response can serve as the baseline of a channel without a cursor.
        const afterBoundary = initialCursor ? ['connected'] : []
        assert.deepEqual(
            statuses,
            afterBoundary,
            'a boundary is never an error, and never a successful initial sync'
        )
        assert.equal(repo.upserts, 0)
        t.mock.timers.tick(1499)
        await flushPoll()
        assert.equal(cursors.length, 1, 'fast boundaries must not form a tight loop')
        t.mock.timers.tick(1)
        await flushPoll()
        assert.deepEqual(cursors, [initialCursor, initialCursor])
        assert.equal(repo.upserts, 0)
        assert.deepEqual(statuses, afterBoundary)
        t.mock.timers.tick(1500)
        await flushPoll()
        assert.deepEqual(cursors, [
            initialCursor,
            initialCursor,
            initialCursor,
            'real-cursor',
            'next-cursor'
        ])
        assert.deepEqual(
            events.map((event) => event.text),
            initialCursor
                ? ['first real batch', 'new message']
                : ['new message']
        )
        assert.deepEqual(statuses, ['connected'], 'liveness is announced once')
        assert.equal(repo.upserts, 2, 'only real responses persist state')
        assert.equal(
            (repo.stateJson as { syncBuf: string }).syncBuf,
            'next-cursor'
        )
        assert.equal(warnings.mock.callCount(), 0)
        assert.equal(stops, 0, 'boundaries must not stop/reconnect the provider')
    })
}

test('weixin a normal 15-second 524 repolls without an extra delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let polls = 0
    t.mock.method(
        globalThis,
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith('/notifystop'))
                return jsonResponse({ ret: 0 })
            if (++polls === 1) {
                await new Promise<void>((resolve) =>
                    setTimeout(resolve, 15_000)
                )
                return new Response(null, { status: 524 })
            }
            return abortingResponse(init?.signal)
        }
    )
    const statuses: string[] = []
    const handle = await providerFor().start(
        ctxFor(),
        async () => {},
        (status) => {
            statuses.push(status)
        }
    )
    t.after(() => handle.stop())
    await flushPoll()
    t.mock.timers.tick(15_000)
    await flushPoll()
    assert.equal(polls, 2)
    assert.deepEqual(statuses, [])
})

test('weixin stopping during the 524 floor cancels the next poll', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let polls = 0
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/notifystop'))
            return jsonResponse({ ret: 0 })
        polls++
        return new Response(null, { status: 524 })
    })
    const statuses: string[] = []
    const handle = await providerFor().start(
        ctxFor(),
        async () => {},
        (status) => {
            statuses.push(status)
        }
    )
    await flushPoll()
    await handle.stop()
    t.mock.timers.tick(60_000)
    await flushPoll()
    assert.equal(polls, 1)
    assert.deepEqual(statuses, [])
})

for (const status of [401, 500, 520]) {
    test(`weixin HTTP ${status} still ends polling with an error`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
        let polls = 0
        t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/notifystop'))
                return jsonResponse({ ret: 0 })
            polls++
            return new Response('HTTP 524 in body is not a status', { status })
        })
        const statuses: string[] = []
        const handle = await providerFor().start(
            ctxFor(),
            async () => {},
            (value) => {
                statuses.push(value)
            }
        )
        t.after(() => handle.stop())
        await flushPoll()
        t.mock.timers.tick(600_000)
        await flushPoll()
        assert.equal(polls, 1)
        assert.deepEqual(statuses, ['error'])
    })
}

test('weixin an isolated edge connect failure repolls with the same cursor', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.method(Math, 'random', () => 0.5)
    const repo = new FakeWeixinRepo()
    repo.stateJson = { syncBuf: 'saved-cursor', contextTokens: {} }
    const warnings = t.mock.method(Logger.prototype, 'warn', () => {})
    const cursors: string[] = []
    const statuses: string[] = []
    const events: NormalizedInboundEvent[] = []
    t.mock.method(
        globalThis,
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith('/notifystop'))
                return jsonResponse({ ret: 0 })
            cursors.push(JSON.parse(String(init?.body)).get_updates_buf)
            if (cursors.length === 1)
                return new Response('origin connect timeout', { status: 522 })
            if (cursors.length === 2)
                return jsonResponse({
                    ret: 0,
                    get_updates_buf: 'next-cursor',
                    msgs: [textMessage('peer', 'after the blip')]
                })
            return abortingResponse(init?.signal)
        }
    )
    const handle = await providerFor(repo).start(
        ctxFor(),
        async (event) => {
            events.push(event)
        },
        (status) => {
            statuses.push(status)
        }
    )
    t.after(() => handle.stop())
    await flushPoll()
    assert.deepEqual(
        statuses,
        [],
        'an unreachable gateway says nothing about the session'
    )
    t.mock.timers.tick(1499)
    await flushPoll()
    assert.equal(cursors.length, 1, 'a fast edge failure must not spin')
    t.mock.timers.tick(1)
    await flushPoll()
    assert.deepEqual(cursors, ['saved-cursor', 'saved-cursor', 'next-cursor'])
    assert.deepEqual(
        events.map((event) => event.text),
        ['after the blip']
    )
    assert.deepEqual(statuses, ['connected'])
    assert.equal(warnings.mock.callCount(), 0)
})

for (const status of [522, 552]) {
    test(`weixin HTTP ${status} ends polling after three consecutive edge connect failures`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
        t.mock.method(Math, 'random', () => 0.5)
        const repo = new FakeWeixinRepo()
        repo.stateJson = { syncBuf: 'saved-cursor', contextTokens: {} }
        const warnings = t.mock.method(Logger.prototype, 'warn', () => {})
        // A boundary in between proves the gateway answered, so only the
        // three failures after it count.
        const sequence = [status, status, 524, status, status, status]
        let polls = 0
        t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/notifystop'))
                return jsonResponse({ ret: 0 })
            const next = sequence[polls++]
            assert.ok(next, 'polling must stop after the error')
            return new Response('edge failure', { status: next })
        })
        const statuses: Array<{ status: string; message?: string }> = []
        const handle = await providerFor(repo).start(
            ctxFor(),
            async () => {},
            (value, detail) => {
                statuses.push({ status: value, message: detail?.message })
            }
        )
        t.after(() => handle.stop())
        await flushPoll()
        for (let i = 0; i < sequence.length; i++) {
            t.mock.timers.tick(1500)
            await flushPoll()
        }
        t.mock.timers.tick(600_000)
        await flushPoll()
        assert.equal(polls, sequence.length)
        assert.deepEqual(
            statuses.map((entry) => entry.status),
            ['connected', 'error']
        )
        assert.match(
            statuses[1].message ?? '',
            new RegExp(`getUpdates HTTP ${status}: edge failure`)
        )
        assert.equal(warnings.mock.callCount(), 1)
        assert.equal(repo.upserts, 0)
    })
}

test('weixin boundaries clear a restarted channel error, so the manager stops bouncing it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    t.mock.method(Math, 'random', () => 0.5)
    t.mock.method(Logger.prototype, 'log', () => {})
    t.mock.method(Logger.prototype, 'warn', () => {})
    const weixinRepo = new FakeWeixinRepo()
    weixinRepo.stateJson = { syncBuf: 'saved-cursor', contextTokens: {} }
    let polls = 0
    let stops = 0
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/notifystop')) {
            stops++
            return jsonResponse({ ret: 0 })
        }
        polls++
        return new Response('edge timeout', { status: 524 })
    })
    // Seen on staging [2026-10-06]: one 554 left an international channel in
    // error; from then on only boundaries arrived, and the manager restarted
    // it every 600s.
    let row = makeChannel({
        status: 'error',
        lastErrorAt: new Date(),
        lastErrorMessage: 'weixin getUpdates HTTP 554: ',
        reconnectAttempts: 818,
        nextReconnectAt: new Date()
    })
    const backoff = (): Date => new Date(Date.now() + 600_000)
    const channelRepo = {
        listSchedulable: async () => [row],
        renewChannelLeases: async (_holder: string, ids: string[]) => ids,
        tryAcquireChannelLease: async () => true,
        releaseChannelLeasesByHolder: async () => {},
        pruneDeliveries: async () => 0,
        markChannelConnected: async () => {
            row = {
                ...row,
                status: 'active',
                lastErrorAt: null,
                lastErrorMessage: null,
                reconnectAttempts: 0,
                nextReconnectAt: null
            }
        },
        markChannelError: async (_id: string, message: string) => {
            row = {
                ...row,
                status: 'error',
                lastErrorMessage: message,
                reconnectAttempts: row.reconnectAttempts + 1,
                nextReconnectAt: backoff()
            }
            return row.reconnectAttempts
        },
        armChannelReconnect: async () => {
            if (row.status !== 'error') return null
            row = {
                ...row,
                reconnectAttempts: row.reconnectAttempts + 1,
                nextReconnectAt: backoff()
            }
            return row.reconnectAttempts
        }
    }
    const bridge = {
        buildContext: (channel: ChannelRow): ChannelContext => ({
            ...ctxFor(channel),
            credentials: { ...credentials, baseUrl: 'https://ilinkai.wechat.com' }
        }),
        handleInbound: async () => {},
        replayRecoverableInboundEvents: async () => 0,
        reconcilePendingReplies: async () => 0,
        sweepOutboundDeliveries: async () => 0
    }
    const provider = providerFor(weixinRepo)
    const manager = new ChannelManagerService(
        channelRepo as never,
        { get: () => provider } as never,
        bridge as never,
        { event: () => {} } as never,
        { get: () => undefined } as never
    )
    manager.onModuleInit()
    t.after(() => manager.onModuleDestroy())
    await flushPoll()
    // Lease ticks well past the 600s backoff the restart armed.
    for (let i = 0; i < 50; i++) {
        t.mock.timers.tick(15_000)
        await flushPoll()
    }
    assert.equal(stops, 0, 'the manager no longer restarts the channel')
    assert.equal(row.status, 'active')
    assert.equal(row.reconnectAttempts, 0)
    assert.equal(row.nextReconnectAt, null)
    assert.ok(polls > 1, 'the first poll loop keeps polling')
})

test('weixin network errors retain the existing retry budget then report error', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let polls = 0
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/notifystop'))
            return jsonResponse({ ret: 0 })
        polls++
        throw new Error('HTTP 524 is only network error text')
    })
    const statuses: string[] = []
    const handle = await providerFor().start(
        ctxFor(),
        async () => {},
        (status) => {
            statuses.push(status)
        }
    )
    t.after(() => handle.stop())
    await flushPoll()
    t.mock.timers.tick(500)
    await flushPoll()
    t.mock.timers.tick(2000)
    await flushPoll()
    assert.equal(polls, 3)
    assert.deepEqual(statuses, ['error'])
})

test('weixin -14 keeps the full one-hour pause across reconnects', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let polls = 0
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/notifystop'))
            return jsonResponse({ ret: 0 })
        polls++
        return jsonResponse({ errcode: -14 })
    })
    const provider = providerFor()
    const statuses: string[] = []
    const onStatus = (status: string): void => {
        statuses.push(status)
    }
    const first = await provider.start(ctxFor(), async () => {}, onStatus)
    await flushPoll()
    await first.stop()
    const second = await provider.start(ctxFor(), async () => {}, onStatus)
    t.after(() => second.stop())
    await flushPoll()
    t.mock.timers.tick(60 * 60_000 - 1)
    await flushPoll()
    assert.equal(polls, 1)
    t.mock.timers.tick(1)
    await flushPoll()
    assert.equal(polls, 2)
    assert.deepEqual(statuses, ['error', 'error', 'error'])
})

// A gateway whose session dies until `revive()`: getupdates and notifystart
// answer -14 before it and succeed after it.
const sessionGateway = (t: TestContext) => {
    const calls = { polls: 0, starts: 0, stops: 0, pollTokens: [] as string[] }
    let alive = false
    t.mock.method(
        globalThis,
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url.endsWith('/notifystop')) {
                calls.stops++
                return jsonResponse({ ret: 0 })
            }
            if (url.endsWith('/notifystart')) {
                calls.starts++
                return jsonResponse(alive ? { ret: 0 } : { errcode: -14 })
            }
            calls.polls++
            calls.pollTokens.push(
                String(new Headers(init?.headers).get('authorization'))
            )
            if (!alive) return jsonResponse({ errcode: -14 })
            return abortingResponse(init?.signal)
        }
    )
    return {
        calls,
        revive: () => {
            alive = true
        }
    }
}

const rescannedCtx = (): ChannelContext => ({
    ...ctxFor(),
    credentials: { ...credentials, botToken: 'weixin-bot-token-rescanned' }
})

test('weixin a successful register ends the -14 pause, so the next start polls at once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const gateway = sessionGateway(t)
    const provider = providerFor()
    const first = await provider.start(ctxFor(), async () => {}, () => {})
    await flushPoll()
    await first.stop()
    gateway.revive()
    assert.equal((await provider.register(ctxFor())).ok, true)
    const second = await provider.start(ctxFor(), async () => {}, () => {})
    t.after(() => second.stop())
    await flushPoll()
    assert.equal(gateway.calls.polls, 2)
})

test('weixin a failed register keeps the -14 pause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const gateway = sessionGateway(t)
    const provider = providerFor()
    const first = await provider.start(ctxFor(), async () => {}, () => {})
    await flushPoll()
    await first.stop()
    const registered = await provider.register(ctxFor())
    assert.equal(registered.ok, false)
    assert.match(registered.message ?? '', /session expired/)
    const second = await provider.start(ctxFor(), async () => {}, () => {})
    t.after(() => second.stop())
    await flushPoll()
    assert.equal(gateway.calls.polls, 1)
    t.mock.timers.tick(60 * 60_000)
    await flushPoll()
    assert.equal(gateway.calls.polls, 2)
})

test('weixin a successful register wakes a poll loop parked in the pause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const gateway = sessionGateway(t)
    const provider = providerFor()
    const first = await provider.start(ctxFor(), async () => {}, () => {})
    await flushPoll()
    await first.stop()
    const parked = await provider.start(ctxFor(), async () => {}, () => {})
    t.after(() => parked.stop())
    await flushPoll()
    assert.equal(gateway.calls.polls, 1)
    // The Register action re-checks the same token and restarts nothing.
    gateway.revive()
    assert.equal((await provider.register(ctxFor())).ok, true)
    await flushPoll()
    assert.equal(gateway.calls.polls, 2)
})

test('weixin a re-scanned token is not held by the old token pause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const gateway = sessionGateway(t)
    const provider = providerFor()
    const first = await provider.start(ctxFor(), async () => {}, () => {})
    await flushPoll()
    await first.stop()
    // The restart carrying the new token may come from the lease holder's
    // config fingerprint check, with register() run on another instance.
    gateway.revive()
    const second = await provider.start(rescannedCtx(), async () => {}, () => {})
    await flushPoll()
    assert.equal(gateway.calls.polls, 2)
    assert.equal(gateway.calls.pollTokens[1], 'Bearer weixin-bot-token-rescanned')
    await second.stop()
    assert.equal(gateway.calls.stops, 1, 'the new token is not paused')
})

test('weixin stop inside the -14 pause sends no notifystop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const gateway = sessionGateway(t)
    const provider = providerFor()
    const first = await provider.start(ctxFor(), async () => {}, () => {})
    await flushPoll()
    await first.stop()
    // Each manager bounce during the pause is another stop.
    const parked = await provider.start(ctxFor(), async () => {}, () => {})
    await flushPoll()
    await parked.stop()
    assert.equal(gateway.calls.polls, 1)
    assert.equal(gateway.calls.stops, 0)
})

test('weixin stop outside the pause still sends notifystop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const gateway = sessionGateway(t)
    gateway.revive()
    const handle = await providerFor().start(
        ctxFor(),
        async () => {},
        () => {}
    )
    await flushPoll()
    await handle.stop()
    assert.equal(gateway.calls.polls, 1)
    assert.equal(gateway.calls.stops, 1)
})

test('weixin HTTP 524 on sendMessage remains a hard failure', async (t) => {
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('edge timeout', { status: 524 })
    )
    await assert.rejects(
        weixinSendMessage(
            {
                baseUrl: 'https://ilinkai.wechat.com',
                token: credentials.botToken
            },
            { to: 'peer', text: 'hello' }
        ),
        /sendMessage HTTP 524/
    )
})

test('weixin a stop abort is not an empty getupdates result', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        weixinGetUpdates(
            {
                baseUrl: 'https://ilinkai.wechat.com',
                token: credentials.botToken,
                signal: controller.signal
            },
            'saved-cursor'
        ),
        /request aborted/
    )
})

test('weixin getupdates preserves the cursor in its local boundary result', async (t) => {
    let status = 0
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('edge timeout', { status })
    )
    for (status of [524, 554])
        for (const cursor of ['', 'saved-cursor'])
            assert.deepEqual(
                await weixinGetUpdates(
                    {
                        baseUrl: 'https://ilinkai.wechat.com',
                        token: credentials.botToken
                    },
                    cursor
                ),
                { kind: 'poll-boundary', msgs: [], get_updates_buf: cursor }
            )
})

test('weixin getupdates reports an edge connect failure as an unreachable gateway', async (t) => {
    let status = 0
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('origin connect timeout', { status })
    )
    for (status of [522, 552]) {
        const result = await weixinGetUpdates(
            {
                baseUrl: 'https://ilinkai.wechat.com',
                token: credentials.botToken
            },
            'saved-cursor'
        )
        assert.equal(result.kind, 'gateway-unreachable')
        assert.match(
            result.kind === 'gateway-unreachable' ? result.error.message : '',
            new RegExp(`getUpdates HTTP ${status}: origin connect timeout`)
        )
    }
})

test('weixin client timeout retains the existing empty successful envelope', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.mock.method(
        globalThis,
        'fetch',
        async (_input: RequestInfo | URL, init?: RequestInit) =>
            abortingResponse(init?.signal)
    )
    const pending = weixinGetUpdates(
        {
            baseUrl: 'https://ilinkai.wechat.com',
            token: credentials.botToken,
            timeoutMs: 100
        },
        'saved-cursor'
    )
    t.mock.timers.tick(100)
    assert.deepEqual(await pending, {
        kind: 'updates',
        response: { ret: 0, msgs: [], get_updates_buf: 'saved-cursor' }
    })
})

test('weixin sendText chunk 1 failure throws (safe for full retry)', async (t) => {
    const provider = providerFor()
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    let sends = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/ilink/bot/sendmessage')) {
            sends += 1
            return jsonResponse({ ret: 1, errmsg: 'boom' })
        }
        return jsonResponse({ error: 'unexpected' }, 500)
    }) as typeof fetch

    await assert.rejects(
        provider.sendText(ctxFor(), 'weixin:dm:wxid_a%40im.wechat', 'hello'),
        /sendmessage/
    )
    // Retried in-chunk up to the retry budget, then rethrown.
    assert.ok(sends >= 1)
})

test('weixin sendText later-chunk failure degrades to a truncation notice', async (t) => {
    process.env.MF_WEIXIN_CHUNK_SIZE = '10'
    process.env.MF_WEIXIN_CHUNK_DELAY_MS = '1'
    const provider = providerFor()
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
        delete process.env.MF_WEIXIN_CHUNK_SIZE
        delete process.env.MF_WEIXIN_CHUNK_DELAY_MS
    })
    const sentTexts: string[] = []
    let chunk = 0
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => {
        const url = String(input)
        if (url.endsWith('/ilink/bot/sendmessage')) {
            const body = JSON.parse(String(init?.body)) as {
                msg?: { item_list?: Array<{ text_item?: { text?: string } }> }
            }
            const text = body.msg?.item_list?.[0]?.text_item?.text ?? ''
            chunk += 1
            // First chunk succeeds; the second always fails so the provider
            // must emit the truncation notice instead of throwing.
            if (chunk === 1) {
                sentTexts.push(text)
                return jsonResponse({ ret: 0 })
            }
            if (text.includes('不完整')) {
                sentTexts.push(text)
                return jsonResponse({ ret: 0 })
            }
            return jsonResponse({ ret: 1, errmsg: 'boom' })
        }
        return jsonResponse({ error: 'unexpected' }, 500)
    }) as typeof fetch

    // Long text (>10 chars) forces at least two chunks.
    const result = await provider.sendText(
        ctxFor(),
        'weixin:dm:wxid_a%40im.wechat',
        'chunk one here and chunk two here as well'
    )
    assert.ok(result)
    assert.ok(sentTexts.some((t) => t.includes('不完整')))
})

// --- Media, reply context, direct send ---

const imageMessage = (from: string): Record<string, unknown> => ({
    seq: 2,
    message_id: 300,
    from_user_id: from,
    message_type: 1,
    item_list: [
        {
            type: 2,
            image_item: {
                aeskey: '00112233445566778899aabbccddeeff',
                media: {
                    encrypt_query_param: 'enc-q',
                    full_url:
                        'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1'
                }
            }
        }
    ],
    context_token: 'ctx-img'
})

test('weixin dispatches an inbound image as a CDN attachment', async (t) => {
    const repo = new FakeWeixinRepo()
    repo.stateJson = { syncBuf: 'cursor-0', contextTokens: {} }
    const provider = providerFor(repo)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    let poll = 0
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => {
        const url = String(input)
        if (url.endsWith('/ilink/bot/msg/notifystart'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/msg/notifystop'))
            return jsonResponse({ ret: 0 })
        if (url.endsWith('/ilink/bot/getupdates')) {
            poll += 1
            if (poll === 1)
                return jsonResponse({
                    ret: 0,
                    get_updates_buf: 'cursor-1',
                    msgs: [imageMessage('wxid_a@im.wechat')]
                })
            return abortingResponse(init?.signal)
        }
        return jsonResponse({ error: 'unexpected' }, 500)
    }) as typeof fetch

    const events: NormalizedInboundEvent[] = []
    const handle = await provider.start(ctxFor(), async (event) => {
        events.push(event)
    })
    await waitFor(() => events.length >= 1)
    await handle.stop()

    assert.equal(events.length, 1)
    const attachments = events[0].attachments ?? []
    assert.equal(attachments.length, 1)
    assert.ok(attachments[0].url.startsWith('weixin-cdn:'))
    assert.equal(attachments[0].contentType, 'image/jpeg')
})

test('weixin fetchReplyContext renders ref_msg as a short quote', async () => {
    const provider = providerFor()
    const event = {
        senderId: 'wxid_a@im.wechat',
        raw: {
            item_list: [
                {
                    type: 1,
                    text_item: { text: 'thanks' },
                    ref_msg: { title: 'What is the ETA?' }
                }
            ]
        }
    } as unknown as NormalizedInboundEvent
    const ctx = await provider.fetchReplyContext!(ctxFor(), event)
    assert.equal(ctx, '[Replying to: What is the ETA?]')
})

test('weixin sendDirect requires a user target with a reply credential', async () => {
    const repo = new FakeWeixinRepo()
    repo.stateJson = { syncBuf: 'c', contextTokens: {} }
    const provider = providerFor(repo)
    // No cached context token → clear error.
    await assert.rejects(
        provider.sendDirect!(
            ctxFor(makeChannel(), baseConfig()),
            {
                kind: 'user',
                userId: 'wxid_stranger@im.wechat'
            },
            'hi'
        ),
        /must message the bot first/
    )
    // Non-user targets are rejected outright.
    await assert.rejects(
        provider.sendDirect!(ctxFor(), { kind: 'chat', chatId: 'x' }, 'hi'),
        /can only send to a user/
    )
})

test('weixin downloadAttachment decrypts a CDN descriptor', async (t) => {
    const provider = providerFor()
    const { prepareWeixinUpload } =
        await import('../src/modules/channels/providers/weixin-cdn')
    const { encodeCdnDescriptor } =
        await import('../src/modules/channels/providers/weixin-cdn')
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5])
    const plan = prepareWeixinUpload(plaintext)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        new Response(new Uint8Array(plan.ciphertext).buffer, {
            status: 200
        })) as typeof fetch

    const url = encodeCdnDescriptor({
        u: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1',
        ak: plan.aesKeyHex,
        name: 'image.jpg',
        contentType: 'image/jpeg'
    })
    const file = await provider.downloadAttachment!(
        ctxFor(),
        { url, name: 'image.jpg', contentType: 'image/jpeg' },
        { maxBytes: 1024 }
    )
    assert.deepEqual(file.bytes, plaintext)
    assert.equal(file.contentType, 'image/jpeg')
})
