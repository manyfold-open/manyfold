import type { LineChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { UnsupportedEventError } from '../src/modules/channels/channel-provider'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import { markdownToLinePlainText } from '../src/modules/channels/providers/line-format'
import { LineChannelProvider } from '../src/modules/channels/providers/line.provider'

const CHANNEL_SECRET = 'test-channel-secret'
const ACCESS_TOKEN = 'test-access-token'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-line-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'line',
    label: 'line test',
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
    overrides: Partial<LineChannelConfig> = {}
): LineChannelConfig => ({
    allowedUserIds: [],
    operatorUserIds: [],
    allowedChatIds: [],
    mentionOnly: true,
    shareSessionInChannel: false,
    progressMode: 'final',
    ...overrides
})

const makeCtx = (config: LineChannelConfig = baseConfig()) => ({
    channel: makeChannel(),
    config,
    credentials: {
        channelSecret: CHANNEL_SECRET,
        channelAccessToken: ACCESS_TOKEN
    }
})

const signedRequest = (
    body: unknown,
    secret = CHANNEL_SECRET
): { headers: Record<string, string>; body: unknown; rawBody: string } => {
    const rawBody = JSON.stringify(body)
    return {
        headers: {
            'x-line-signature': createHmac('sha256', secret)
                .update(rawBody)
                .digest('base64')
        },
        body,
        rawBody
    }
}

const textEvent = (
    overrides: {
        source?: Record<string, unknown>
        message?: Record<string, unknown>
        webhookEventId?: string
    } = {}
): Record<string, unknown> => ({
    type: 'message',
    webhookEventId: overrides.webhookEventId ?? '01H8V0000000000000000',
    timestamp: 1_700_000_000_000,
    source: overrides.source ?? { type: 'user', userId: 'Uuser1' },
    message: overrides.message ?? {
        id: 'msg-1',
        type: 'text',
        text: 'hello'
    }
})

test('line validateConfig defaults and normalizes progressMode to final', () => {
    const provider = new LineChannelProvider()
    const config = provider.validateConfig({
        botUserId: '  Ubot ',
        allowedUserIds: [' Uone ', 'Uone', '', 'Utwo'],
        mentionOnly: false,
        shareSessionInChannel: true,
        // LINE has no message-edit API, so a requested preview must not stick.
        progressMode: 'preview'
    })
    assert.equal(config.botUserId, 'Ubot')
    assert.deepEqual(config.allowedUserIds, ['Uone', 'Utwo'])
    assert.equal(config.mentionOnly, false)
    assert.equal(config.shareSessionInChannel, true)
    assert.equal(config.progressMode, 'final')
    assert.equal(config.contextProjection, true)
    assert.equal(
        provider.validateConfig({ contextProjection: false }).contextProjection,
        false
    )
    assert.equal(provider.validateConfig({}).mentionOnly, true)
    assert.throws(() => provider.validateConfig(null))
})

test('line validateCredentials requires both secret and access token', () => {
    const provider = new LineChannelProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.deepEqual(
        provider.validateCredentials({
            channelSecret: ' s ',
            channelAccessToken: ' t '
        }),
        { channelSecret: 's', channelAccessToken: 't' }
    )
    assert.throws(() =>
        provider.validateCredentials({ channelAccessToken: 't' })
    )
    assert.throws(() => provider.validateCredentials({ channelSecret: 's' }))
})

test('line verifySignature accepts a valid HMAC and rejects tampering', () => {
    const provider = new LineChannelProvider()
    const ctx = makeCtx()
    const body = { destination: 'Ubot', events: [textEvent()] }
    assert.deepEqual(provider.verifySignature(signedRequest(body), ctx), {
        ok: true
    })
    assert.equal(
        provider.verifySignature(signedRequest(body, 'wrong-secret'), ctx).ok,
        false
    )
    // A body edited after signing must fail even though the header parses.
    const tampered = signedRequest(body)
    tampered.rawBody = JSON.stringify({
        destination: 'Ubot',
        events: [textEvent({ message: { id: 'msg-1', type: 'text', text: 'evil' } })]
    })
    assert.equal(provider.verifySignature(tampered, ctx).reason, 'signature_mismatch')
    assert.equal(
        provider.verifySignature({ headers: {}, body, rawBody: '{}' }, ctx)
            .reason,
        'missing_signature_header'
    )
    assert.equal(
        provider.verifySignature(signedRequest(body), {
            ...ctx,
            credentials: null
        }).reason,
        'channel_secret_missing'
    )
})

test('line verifySignature answers the console verify ping with a 200', () => {
    const provider = new LineChannelProvider()
    const req = signedRequest({ destination: 'Ubot', events: [] })
    const check = provider.verifySignature(req, makeCtx())
    assert.equal(check.ok, true)
    assert.deepEqual(check.challengeResponse, { status: 200, body: {} })
})

test('line parseInbound maps a direct message', () => {
    const provider = new LineChannelProvider()
    const event = provider.parseInbound(
        signedRequest({ destination: 'Ubot', events: [textEvent()] }),
        makeCtx()
    )
    assert.equal(event.providerEventId, 'line-01H8V0000000000000000')
    assert.equal(event.chatId, 'Uuser1')
    assert.equal(event.chatType, 'private')
    assert.equal(event.senderId, 'Uuser1')
    assert.equal(event.text, 'hello')
    assert.equal(event.messageId, 'msg-1')
    // A DM is always addressed to the bot, and quoting the only other
    // participant would be noise.
    assert.equal(event.isMention, true)
    assert.equal(event.replyTargetId, null)
    assert.equal(event.threadId, null)
})

test('line parseInbound gates group mentions on the native isSelf flag', () => {
    const provider = new LineChannelProvider()
    const groupSource = { type: 'group', groupId: 'Cgroup1', userId: 'Uuser1' }
    const mentioned = provider.parseInbound(
        signedRequest({
            events: [
                textEvent({
                    source: groupSource,
                    message: {
                        id: 'msg-2',
                        type: 'text',
                        text: '@bot hi',
                        quoteToken: 'quote-abc',
                        mention: {
                            mentionees: [
                                { type: 'user', userId: 'Ubot', isSelf: true }
                            ]
                        }
                    }
                })
            ]
        }),
        makeCtx()
    )
    assert.equal(mentioned.chatId, 'Cgroup1')
    assert.equal(mentioned.chatType, 'group')
    assert.equal(mentioned.senderId, 'Uuser1')
    assert.equal(mentioned.isMention, true)
    // The answer quotes the trigger, and a quote is addressed by quoteToken.
    assert.equal(mentioned.replyTargetId, 'quote-abc')

    // Mentioning someone else — or @all — is not a mention of this bot.
    const others = provider.parseInbound(
        signedRequest({
            events: [
                textEvent({
                    source: groupSource,
                    message: {
                        id: 'msg-3',
                        type: 'text',
                        text: '@someone @all hi',
                        mention: {
                            mentionees: [
                                { type: 'user', userId: 'Uother', isSelf: false },
                                { type: 'all' }
                            ]
                        }
                    }
                })
            ]
        }),
        makeCtx()
    )
    assert.equal(others.isMention, false)
})

test('line parseInbound turns media into a content-addressed attachment', () => {
    const provider = new LineChannelProvider()
    const image = provider.parseInbound(
        signedRequest({
            events: [
                textEvent({
                    message: { id: 'img-1', type: 'image' }
                })
            ]
        }),
        makeCtx()
    )
    assert.equal(image.text, '')
    assert.deepEqual(image.attachments, [
        {
            url: 'line-content:img-1',
            name: 'image-img-1.jpg',
            contentType: 'image/jpeg',
            size: null
        }
    ])

    const file = provider.parseInbound(
        signedRequest({
            events: [
                textEvent({
                    message: {
                        id: 'file-1',
                        type: 'file',
                        fileName: 'report.pdf',
                        fileSize: 4242
                    }
                })
            ]
        }),
        makeCtx()
    )
    assert.deepEqual(file.attachments, [
        {
            url: 'line-content:file-1',
            name: 'report.pdf',
            contentType: 'application/octet-stream',
            size: 4242
        }
    ])
})

test('line parseInbound rejects events that cannot start a turn', () => {
    const provider = new LineChannelProvider()
    const parse = (events: unknown[]): void => {
        provider.parseInbound(signedRequest({ events }), makeCtx())
    }
    assert.throws(
        () => parse([{ type: 'follow', source: { type: 'user', userId: 'U1' } }]),
        (err: unknown) =>
            err instanceof UnsupportedEventError && err.eventType === 'line_follow'
    )
    assert.throws(
        () => parse([]),
        (err: unknown) =>
            err instanceof UnsupportedEventError &&
            err.eventType === 'no_message_event'
    )
    // A sticker carries neither text nor downloadable content.
    assert.throws(
        () =>
            parse([
                textEvent({
                    message: { id: 'stk-1', type: 'sticker', packageId: '1' }
                })
            ]),
        (err: unknown) =>
            err instanceof UnsupportedEventError &&
            err.eventType === 'line_sticker_message'
    )
})

test('line parseInbound picks the first message out of a batched delivery', () => {
    const provider = new LineChannelProvider()
    const event = provider.parseInbound(
        signedRequest({
            events: [
                { type: 'join', source: { type: 'group', groupId: 'C1' } },
                textEvent({ webhookEventId: 'second' })
            ]
        }),
        makeCtx()
    )
    assert.equal(event.providerEventId, 'line-second')
})

test('line computeScopeKey separates DMs, per-user and shared group scopes', () => {
    const provider = new LineChannelProvider()
    const dm = provider.parseInbound(
        signedRequest({ events: [textEvent()] }),
        makeCtx()
    )
    assert.deepEqual(provider.computeScopeKey(dm, baseConfig()), {
        scopeKey: 'line:Uuser1:Uuser1',
        scopeName: null
    })

    const group = provider.parseInbound(
        signedRequest({
            events: [
                textEvent({
                    source: {
                        type: 'group',
                        groupId: 'Cgroup1',
                        userId: 'Uuser1'
                    }
                })
            ]
        }),
        makeCtx()
    )
    assert.equal(
        provider.computeScopeKey(group, baseConfig()).scopeKey,
        'line:Cgroup1:Uuser1'
    )
    assert.equal(
        provider.computeScopeKey(
            group,
            baseConfig({ shareSessionInChannel: true })
        ).scopeKey,
        'line:Cgroup1'
    )
})

test('line evaluateInboundActor enforces the allow lists', () => {
    const provider = new LineChannelProvider()
    const dm = provider.parseInbound(
        signedRequest({ events: [textEvent()] }),
        makeCtx()
    )
    const group = provider.parseInbound(
        signedRequest({
            events: [
                textEvent({
                    source: {
                        type: 'group',
                        groupId: 'Cgroup1',
                        userId: 'Uuser1'
                    }
                })
            ]
        }),
        makeCtx()
    )

    // Empty lists let anyone in but grant nobody operator rights, so
    // agent-wide commands stay fail-closed.
    assert.deepEqual(provider.evaluateInboundActor(dm, baseConfig()), {
        allowed: true,
        operator: false
    })
    assert.deepEqual(
        provider.evaluateInboundActor(
            dm,
            baseConfig({ allowedUserIds: ['Usomeone-else'] })
        ),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    // An operator is allowed even when missing from allowedUserIds.
    assert.deepEqual(
        provider.evaluateInboundActor(
            dm,
            baseConfig({
                allowedUserIds: ['Usomeone-else'],
                operatorUserIds: ['Uuser1']
            })
        ),
        { allowed: true, operator: true }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            group,
            baseConfig({ allowedChatIds: ['Cother'] })
        ),
        { allowed: false, reason: 'chat_not_allowed', operator: false }
    )
    assert.equal(
        provider.evaluateInboundActor(
            group,
            baseConfig({ allowedChatIds: ['Cgroup1'] })
        ).allowed,
        true
    )
    // A chat-level block is not overridden by operator status.
    assert.equal(
        provider.evaluateInboundActor(
            group,
            baseConfig({
                allowedChatIds: ['Cother'],
                operatorUserIds: ['Uuser1']
            })
        ).allowed,
        false
    )
})

interface CapturedRequest {
    url: string
    body: Record<string, unknown>
    headers: Record<string, string>
}

const withStubbedFetch = async (
    respond: (req: CapturedRequest) => { status: number; json: unknown },
    run: (calls: CapturedRequest[]) => Promise<void>
): Promise<void> => {
    const calls: CapturedRequest[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        const req: CapturedRequest = {
            url: String(url),
            body: init.body ? JSON.parse(String(init.body)) : {},
            headers: (init.headers ?? {}) as Record<string, string>
        }
        calls.push(req)
        const { status, json } = respond(req)
        return new Response(JSON.stringify(json), {
            status,
            headers: { 'content-type': 'application/json' }
        })
    }) as typeof globalThis.fetch
    try {
        await run(calls)
    } finally {
        globalThis.fetch = original
    }
}

test('line sendText flattens markdown and quotes only the first message', async () => {
    const provider = new LineChannelProvider()
    await withStubbedFetch(
        () => ({ status: 200, json: { sentMessages: [{ id: 'sent-1' }] } }),
        async (calls) => {
            const res = await provider.sendText(
                makeCtx(),
                'line:Cgroup1:Uuser1',
                '**bold** and `code` and [docs](https://example.com)',
                { replyToProviderMessageId: 'quote-abc' }
            )
            assert.equal(res.providerMessageId, 'sent-1')
            assert.equal(calls.length, 1)
            assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push')
            assert.equal(calls[0].headers.Authorization, `Bearer ${ACCESS_TOKEN}`)
            assert.equal(calls[0].body.to, 'Cgroup1')
            assert.deepEqual(calls[0].body.messages, [
                {
                    type: 'text',
                    text: 'bold and code and docs (https://example.com)',
                    quoteToken: 'quote-abc'
                }
            ])
        }
    )
})

test('line sendText chunks past the 5000-character message cap', async () => {
    const provider = new LineChannelProvider()
    await withStubbedFetch(
        () => ({ status: 200, json: { sentMessages: [{ id: 'sent-n' }] } }),
        async (calls) => {
            const line = `${'x'.repeat(199)}\n`
            await provider.sendText(
                makeCtx(),
                'line:Uuser1:Uuser1',
                line.repeat(60),
                { replyToProviderMessageId: 'quote-abc' }
            )
            const messages = calls.flatMap(
                (c) => c.body.messages as Array<Record<string, unknown>>
            )
            assert.ok(messages.length > 1, 'expected the reply to be chunked')
            for (const m of messages)
                assert.ok(
                    String(m.text).length <= 5000,
                    'every chunk must fit the LINE text cap'
                )
            // Repeating the quote on every chunk would read as spam.
            assert.equal(
                messages.filter((m) => m.quoteToken !== undefined).length,
                1
            )
            // A push request carries at most 5 message objects.
            for (const call of calls)
                assert.ok(
                    (call.body.messages as unknown[]).length <= 5,
                    'a push must not exceed 5 message objects'
                )
        }
    )
})

test('line sendDirect addresses a user or chat and refuses a reply target', async () => {
    const provider = new LineChannelProvider()
    await withStubbedFetch(
        () => ({ status: 200, json: { sentMessages: [{ id: 'sent-1' }] } }),
        async (calls) => {
            await provider.sendDirect(
                makeCtx(),
                { kind: 'user', userId: 'Uuser9' },
                'ping'
            )
            assert.equal(calls[0].body.to, 'Uuser9')
            await provider.sendDirect(
                makeCtx(),
                { kind: 'chat', chatId: 'Cgroup9' },
                'ping'
            )
            assert.equal(calls[1].body.to, 'Cgroup9')
            await assert.rejects(
                provider.sendDirect(
                    makeCtx(),
                    { kind: 'reply', messageId: 'msg-1' },
                    'ping'
                )
            )
        }
    )
})

test('line classifies platform rejections into the send-error taxonomy', async () => {
    const provider = new LineChannelProvider()
    const expectKind = async (
        status: number,
        json: unknown,
        kind: string
    ): Promise<void> => {
        await withStubbedFetch(
            () => ({ status, json }),
            async () => {
                await assert.rejects(
                    provider.sendText(makeCtx(), 'line:Uuser1:Uuser1', 'hi'),
                    (err: unknown) =>
                        err instanceof ChannelSendError && err.kind === kind
                )
            }
        )
    }
    await expectKind(429, { message: 'Too many requests' }, 'rate_limited')
    await expectKind(403, { message: 'Forbidden' }, 'forbidden')
    await expectKind(404, { message: 'Not found' }, 'not_found')
    await expectKind(
        400,
        {
            message: 'The property, to, may not be used',
            details: [{ property: 'to', message: 'may not be used' }]
        },
        'not_found'
    )
    await expectKind(400, { message: 'Invalid reply token' }, 'bad_format')
    // 5xx stays a plain Error so it keeps the ladder-retry path.
    await withStubbedFetch(
        () => ({ status: 500, json: { message: 'Internal' } }),
        async () => {
            await assert.rejects(
                provider.sendText(makeCtx(), 'line:Uuser1:Uuser1', 'hi'),
                (err: unknown) => !(err instanceof ChannelSendError)
            )
        }
    )
})

test('line register captures the bot identity and warns when webhooks are off', async () => {
    const provider = new LineChannelProvider()
    const inboundUrl = 'https://api.example.com/api/channels/hooks/line/chn-line-1'
    await withStubbedFetch(
        (req) =>
            req.url.endsWith('/v2/bot/info')
                ? {
                      status: 200,
                      json: {
                          userId: 'Ubot',
                          basicId: '@bot',
                          displayName: 'Support Bot'
                      }
                  }
                : { status: 200, json: { endpoint: inboundUrl, active: false } },
        async (calls) => {
            const result = await provider.register(makeCtx(), inboundUrl)
            assert.equal(result.ok, true)
            assert.equal(result.activate, true)
            const config = result.configPatch as LineChannelConfig
            assert.equal(config.botUserId, 'Ubot')
            assert.equal(config.basicId, '@bot')
            assert.equal(config.botDisplayName, 'Support Bot')
            // "Use webhook" is console-only, so a registered channel can still
            // receive nothing — that must reach the operator.
            assert.match(result.message ?? '', /Use webhook/)
            const put = calls.find((c) =>
                c.url.endsWith('/v2/bot/channel/webhook/endpoint')
            )
            assert.equal(put?.body.endpoint, inboundUrl)
        }
    )
})

test('line test reports a mismatched webhook URL as a failure', async () => {
    const provider = new LineChannelProvider()
    await withStubbedFetch(
        (req) =>
            req.url.endsWith('/v2/bot/info')
                ? { status: 200, json: { displayName: 'Support Bot' } }
                : {
                      status: 200,
                      json: {
                          endpoint: 'https://elsewhere.example.com/hook',
                          active: true
                      }
                  },
        async () => {
            const result = await provider.test(makeCtx())
            assert.equal(result.ok, false)
            assert.match(result.message, /webhook URL does not match/)
        }
    )
    await withStubbedFetch(
        (req) =>
            req.url.endsWith('/v2/bot/info')
                ? { status: 200, json: { displayName: 'Support Bot' } }
                : {
                      status: 200,
                      json: {
                          endpoint:
                              'https://api.example.com/api/channels/hooks/line/chn-line-1',
                          active: true
                      }
                  },
        async () => {
            const result = await provider.test(makeCtx())
            assert.equal(result.ok, true)
        }
    )
})

test('line markdown flattening keeps content and identifiers intact', () => {
    assert.equal(markdownToLinePlainText('# Heading'), 'Heading')
    assert.equal(
        markdownToLinePlainText('```js\nconst a = 1\n```'),
        'const a = 1'
    )
    assert.equal(markdownToLinePlainText('~~gone~~ and *it*'), 'gone and it')
    assert.equal(
        markdownToLinePlainText('see [docs](https://example.com)'),
        'see docs (https://example.com)'
    )
    assert.equal(markdownToLinePlainText('> quoted\n\n---'), 'quoted')
    assert.equal(markdownToLinePlainText('a\n\n\n\n\nb'), 'a\n\nb')
    // Underscore forms are left alone: stripping them corrupts snake_case and
    // dunder identifiers into unusable text.
    assert.equal(
        markdownToLinePlainText('call my_func_name and __init__'),
        'call my_func_name and __init__'
    )
})
