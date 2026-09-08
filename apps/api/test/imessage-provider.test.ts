import type { IMessageChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import {
    UnsupportedEventError,
    type ChannelContext,
    type InboundRequest
} from '../src/modules/channels/channel-provider'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import {
    compileWakeWords,
    markdownToIMessagePlainText,
    splitIMessageBubbles,
    stripLeadingWakeWord
} from '../src/modules/channels/providers/imessage-format'
import { IMessageChannelProvider } from '../src/modules/channels/providers/imessage.provider'

// A literal public address: the SSRF guard short-circuits on an IP, so the
// suite never needs DNS (the sealed test env has no network).
const SERVER_URL = 'https://93.184.216.34'
const PASSWORD = 'server-password'
const SECRET = 'webhook-secret-value'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-imsg-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'imessage',
    label: 'imessage test',
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
    overrides: Partial<IMessageChannelConfig> = {}
): IMessageChannelConfig => ({
    serverUrl: SERVER_URL,
    webhookId: null,
    serverVersion: '1.9.9',
    privateApi: true,
    helperConnected: true,
    allowedUserIds: [],
    operatorUserIds: [],
    allowedChatIds: [],
    wakeWords: ['hey manyfold'],
    mentionOnly: true,
    shareSessionInChannel: false,
    progressMode: 'final',
    ...overrides
})

const makeCtx = (
    config: IMessageChannelConfig = baseConfig(),
    credentials: Record<string, unknown> | null = {
        serverPassword: PASSWORD,
        webhookSecret: SECRET
    }
): ChannelContext =>
    ({
        channel: makeChannel(),
        config,
        credentials
    }) as unknown as ChannelContext

const inbound = (
    body: unknown,
    query: Record<string, string | string[] | undefined> = {}
): InboundRequest => ({ headers: {}, body, query })

const newMessage = (
    data: Record<string, unknown> = {}
): Record<string, unknown> => ({
    type: 'new-message',
    data: {
        guid: 'A1B2-C3D4',
        text: 'hello',
        isFromMe: false,
        handle: { address: '+15555550123' },
        chats: [
            {
                guid: 'iMessage;-;+15555550123',
                chatIdentifier: '+15555550123',
                participants: [{ address: '+15555550123' }]
            }
        ],
        ...data
    }
})

interface CapturedRequest {
    url: string
    body: unknown
    method: string
    isForm: boolean
}

const withStubbedFetch = async (
    respond: (req: CapturedRequest) => { status: number; json: unknown },
    run: (calls: CapturedRequest[]) => Promise<void>
): Promise<void> => {
    const calls: CapturedRequest[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        const isForm =
            typeof FormData !== 'undefined' && init.body instanceof FormData
        const req: CapturedRequest = {
            url: String(url),
            method: init.method ?? 'GET',
            isForm,
            body:
                init.body && !isForm ? JSON.parse(String(init.body)) : init.body
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

const envelope = (data: unknown) => ({ status: 200, message: 'success', data })

test('imessage validateConfig normalizes the server url and forces final progress', () => {
    const provider = new IMessageChannelProvider()
    const config = provider.validateConfig({
        serverUrl: '  https://mac.example.com/bb/  ',
        allowedUserIds: [' +1 (555) 555-0123 ', '+15555550123', 'A@B.COM'],
        wakeWords: [' hey manyfold ', ''],
        shareSessionInChannel: true,
        // iMessage cannot edit a sent bubble, so a requested preview must not stick.
        progressMode: 'preview'
    })
    assert.equal(config.serverUrl, 'https://mac.example.com/bb')
    // '+1 (555) 555-0123' and '+15555550123' are the same handle.
    assert.deepEqual(config.allowedUserIds, ['+15555550123', 'a@b.com'])
    assert.deepEqual(config.wakeWords, ['hey manyfold'])
    assert.equal(config.progressMode, 'final')
    assert.equal(config.contextProjection, true)
})

test('imessage validateConfig defaults a bare host to http and rejects junk', () => {
    const provider = new IMessageChannelProvider()
    assert.equal(
        provider.validateConfig({ serverUrl: 'mac.example.com:1234' })
            .serverUrl,
        'http://mac.example.com:1234'
    )
    assert.throws(() => provider.validateConfig({ serverUrl: '' }))
    assert.throws(() => provider.validateConfig({ serverUrl: 'ftp://mac/' }))
    assert.throws(() =>
        provider.validateConfig({ serverUrl: 'https://u:p@mac.example.com' })
    )
})

test('imessage strict validateConfig rejects mention gating with no wake word', () => {
    const provider = new IMessageChannelProvider()
    // Without a wake word the channel would answer nothing in every group and
    // give the operator no signal about why.
    assert.throws(
        () =>
            provider.validateConfig(
                { serverUrl: SERVER_URL, mentionOnly: true, wakeWords: [] },
                { strict: true }
            ),
        /wakeWords/
    )
    // Lenient parsing must still load an existing row.
    assert.deepEqual(
        provider.validateConfig({
            serverUrl: SERVER_URL,
            mentionOnly: true,
            wakeWords: []
        }).wakeWords,
        []
    )
})

test('imessage validateCredentials requires a server password', () => {
    const provider = new IMessageChannelProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.throws(() => provider.validateCredentials({}))
    assert.deepEqual(
        provider.validateCredentials({
            serverPassword: ' pw ',
            webhookSecret: ' s '
        }),
        { serverPassword: 'pw', webhookSecret: 's' }
    )
})

test('imessage verifySignature accepts the query secret and the header alias', () => {
    const provider = new IMessageChannelProvider()
    const ctx = makeCtx()
    assert.deepEqual(
        provider.verifySignature(inbound({}, { secret: SECRET }), ctx),
        { ok: true }
    )
    assert.deepEqual(
        provider.verifySignature(
            {
                headers: { 'X-Manyfold-Webhook-Secret': SECRET },
                body: {},
                query: {}
            },
            ctx
        ),
        { ok: true }
    )
})

test('imessage verifySignature rejects a wrong secret without throwing on length', () => {
    const provider = new IMessageChannelProvider()
    const ctx = makeCtx()
    assert.deepEqual(provider.verifySignature(inbound({}, {}), ctx), {
        ok: false,
        reason: 'missing_secret'
    })
    // A raw timingSafeEqual throws on unequal-length buffers, which would both
    // 500 the request and leak the expected secret's length.
    assert.deepEqual(
        provider.verifySignature(inbound({}, { secret: 'short' }), ctx),
        { ok: false, reason: 'secret_mismatch' }
    )
    assert.deepEqual(
        provider.verifySignature(
            inbound({}, { secret: `${SECRET}-and-then-some-more` }),
            ctx
        ),
        { ok: false, reason: 'secret_mismatch' }
    )
    assert.deepEqual(
        provider.verifySignature(inbound({}, { secret: SECRET }), {
            ...ctx,
            credentials: { serverPassword: PASSWORD }
        } as ChannelContext),
        { ok: false, reason: 'webhook_secret_missing' }
    )
})

test('imessage parseInbound maps a DM', () => {
    const provider = new IMessageChannelProvider()
    const event = provider.parseInbound(inbound(newMessage()), makeCtx())
    assert.equal(event.providerEventId, 'imessage-A1B2-C3D4')
    assert.equal(event.chatId, 'iMessage;-;+15555550123')
    assert.equal(event.chatType, 'private')
    assert.equal(event.senderId, '+15555550123')
    assert.equal(event.text, 'hello')
    assert.equal(event.isMention, true)
    assert.equal(event.messageId, 'A1B2-C3D4')
})

test('imessage parseInbound reads the nested chat guid and gates groups on the wake word', () => {
    const provider = new IMessageChannelProvider()
    const group = (text: string) =>
        newMessage({
            text,
            chats: [
                {
                    guid: 'iMessage;+;chat9990',
                    displayName: 'Team',
                    participants: [{ address: 'a' }, { address: 'b' }]
                }
            ]
        })
    const plain = provider.parseInbound(
        inbound(group('what time is it')),
        makeCtx()
    )
    assert.equal(plain.chatType, 'group')
    assert.equal(plain.chatId, 'iMessage;+;chat9990')
    assert.equal(plain.isMention, false)

    const hailed = provider.parseInbound(
        inbound(group('Hey Manyfold, what time is it')),
        makeCtx()
    )
    assert.equal(hailed.isMention, true)
    // The wake word is stripped so the agent does not see it as content.
    assert.equal(hailed.text, 'what time is it')
})

test('imessage wake words are word-bounded and never treated as regex', () => {
    const re = compileWakeWords(['hey manyfold', 'manyfold'])
    assert.ok(re)
    assert.equal(re.test('Hey Manyfold there'), true)
    // 'manyfoldish' is a different word.
    assert.equal(re.test('manyfoldish thing'), false)
    // A metacharacter in a wake word is a literal, not a pattern.
    const literal = compileWakeWords(['hey (bot)'])
    assert.ok(literal)
    assert.equal(literal.test('hey (bot) hello'), true)
    assert.equal(literal.test('hey bot hello'), false)
    assert.equal(compileWakeWords([]), null)
    assert.equal(stripLeadingWakeWord('Hey Manyfold: run it', re), 'run it')
    // Only the head is stripped; a later occurrence is an ordinary word.
    assert.equal(
        stripLeadingWakeWord('tell manyfold about it', re),
        'tell manyfold about it'
    )
})

test('imessage parseInbound drops echoes, tapbacks and non-message events', () => {
    const provider = new IMessageChannelProvider()
    const ctx = makeCtx()
    try {
        provider.parseInbound(inbound(newMessage({ isFromMe: true })), ctx)
        assert.fail('expected UnsupportedEventError')
    } catch (err) {
        assert.ok(err instanceof UnsupportedEventError)
        // An echo arrives on every send; a dropped row each time would double
        // the delivery table.
        assert.equal(err.silent, true)
    }
    for (const associatedMessageType of [2000, 2005, 3001, 3005])
        assert.throws(
            () =>
                provider.parseInbound(
                    inbound(newMessage({ associatedMessageType })),
                    ctx
                ),
            UnsupportedEventError
        )
    // updated-message repeats the same guid, so it is not subscribed to and
    // must be refused if it arrives anyway.
    assert.throws(
        () =>
            provider.parseInbound(
                inbound({ ...newMessage(), type: 'updated-message' }),
                ctx
            ),
        UnsupportedEventError
    )
    assert.throws(
        () => provider.parseInbound(inbound({ type: 'hello-world' }), ctx),
        UnsupportedEventError
    )
})

test('imessage parseInbound requires a guid, a sender and some content', () => {
    const provider = new IMessageChannelProvider()
    const ctx = makeCtx()
    // No guid means no durable dedup key; a synthetic one would turn a
    // redelivery into a second billed turn.
    assert.throws(
        () =>
            provider.parseInbound(
                inbound(newMessage({ guid: undefined })),
                ctx
            ),
        UnsupportedEventError
    )
    assert.throws(
        () =>
            provider.parseInbound(
                inbound(newMessage({ handle: undefined })),
                ctx
            ),
        UnsupportedEventError
    )
    assert.throws(
        () =>
            provider.parseInbound(
                inbound(newMessage({ text: '￼', attachments: [] })),
                ctx
            ),
        UnsupportedEventError
    )
})

test('imessage parseInbound maps attachments to a credentialed pseudo-url', () => {
    const provider = new IMessageChannelProvider()
    const event = provider.parseInbound(
        inbound(
            newMessage({
                text: '￼',
                attachments: [
                    {
                        guid: 'att-1',
                        transferName: 'photo.jpg',
                        mimeType: 'image/jpeg',
                        totalBytes: 1234
                    }
                ]
            })
        ),
        makeCtx()
    )
    // The bytes need the server password, which must never ride on the event.
    assert.deepEqual(event.attachments, [
        {
            url: 'imessage-attachment:att-1',
            name: 'photo.jpg',
            contentType: 'image/jpeg',
            size: 1234
        }
    ])
    assert.equal(event.text, '')
})

test('imessage parseInbound decodes a form-encoded payload identically', () => {
    const provider = new IMessageChannelProvider()
    const direct = provider.parseInbound(inbound(newMessage()), makeCtx())
    const wrapped = provider.parseInbound(
        inbound({ payload: JSON.stringify(newMessage()) }),
        makeCtx()
    )
    assert.equal(wrapped.providerEventId, direct.providerEventId)
    assert.equal(wrapped.chatId, direct.chatId)
    assert.equal(wrapped.senderId, direct.senderId)
})

test('imessage computeScopeKey encodes the guid and round-trips', () => {
    const provider = new IMessageChannelProvider()
    const dm = provider.parseInbound(inbound(newMessage()), makeCtx())
    const dmScope = provider.computeScopeKey(dm, baseConfig())
    assert.equal(
        dmScope.scopeKey,
        `imessage:dm:${encodeURIComponent('iMessage;-;+15555550123')}`
    )
    const group = provider.parseInbound(
        inbound(
            newMessage({
                text: 'hey manyfold hi',
                chats: [
                    {
                        guid: 'iMessage;+;chat9990',
                        participants: [{ address: 'a' }, { address: 'b' }]
                    }
                ]
            })
        ),
        makeCtx()
    )
    assert.equal(
        provider.computeScopeKey(group, baseConfig()).scopeKey,
        `imessage:group:${encodeURIComponent('iMessage;+;chat9990')}:${encodeURIComponent('+15555550123')}`
    )
    assert.equal(
        provider.computeScopeKey(
            group,
            baseConfig({ shareSessionInChannel: true })
        ).scopeKey,
        `imessage:group:${encodeURIComponent('iMessage;+;chat9990')}`
    )
})

test('imessage evaluateInboundActor gates by handle and chat', () => {
    const provider = new IMessageChannelProvider()
    const event = provider.parseInbound(inbound(newMessage()), makeCtx())
    assert.deepEqual(provider.evaluateInboundActor(event, baseConfig()), {
        allowed: true,
        operator: false
    })
    // The stored allowlist is normalized, so a differently-formatted handle
    // still matches.
    assert.equal(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['+15555550123'] })
        ).allowed,
        true
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['+15555559999'] })
        ),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ operatorUserIds: ['+15555550123'] })
        ),
        { allowed: true, operator: true }
    )
    const group = provider.parseInbound(
        inbound(
            newMessage({
                text: 'hey manyfold hi',
                chats: [
                    {
                        guid: 'iMessage;+;chat9990',
                        participants: [{ address: 'a' }, { address: 'b' }]
                    }
                ]
            })
        ),
        makeCtx()
    )
    // A chat block is about where the agent may speak, so operator status does
    // not override it.
    assert.deepEqual(
        provider.evaluateInboundActor(
            group,
            baseConfig({
                allowedChatIds: ['iMessage;+;other'],
                operatorUserIds: ['+15555550123']
            })
        ),
        { allowed: false, reason: 'chat_not_allowed', operator: true }
    )
})

test('imessage sendText flattens markdown into one bubble per paragraph', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        () => ({ status: 200, json: envelope({ guid: 'sent-1' }) }),
        async (calls) => {
            await provider.sendText(
                makeCtx(),
                `imessage:dm:${encodeURIComponent('iMessage;-;+15555550123')}`,
                '**bold** first\n\nsecond `code`'
            )
            assert.equal(calls.length, 2)
            const bodies = calls.map(
                (c) => (c.body as { message: string }).message
            )
            assert.deepEqual(bodies, ['bold first', 'second code'])
            const tempGuids = calls.map(
                (c) => (c.body as { tempGuid: string }).tempGuid
            )
            assert.notEqual(tempGuids[0], tempGuids[1])
            for (const call of calls) {
                assert.equal(
                    (call.body as { chatGuid: string }).chatGuid,
                    'iMessage;-;+15555550123'
                )
                // BlueBubbles has no header auth: the password rides on the
                // query string and must never appear in the body.
                assert.ok(call.url.includes(`password=${PASSWORD}`))
                assert.ok(!JSON.stringify(call.body).includes(PASSWORD))
            }
        }
    )
})

test('imessage sendDirect never resolves a handle to a group it merely participates in', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        (req) =>
            req.url.includes('/chat/query')
                ? {
                      status: 200,
                      json: envelope([
                          {
                              guid: 'iMessage;+;chat9990',
                              chatIdentifier: 'chat9990',
                              participants: [
                                  { address: '+15555550123' },
                                  { address: '+15555559999' }
                              ]
                          }
                      ])
                  }
                : { status: 200, json: envelope({ guid: 'sent-1' }) },
        async (calls) => {
            await provider.sendDirect(
                makeCtx(),
                { kind: 'user', userId: '+15555550123' },
                'hi'
            )
            const sends = calls.filter((c) => c.url.includes('/message/text'))
            const created = calls.filter((c) => c.url.includes('/chat/new'))
            // The handle only appears in that group's participants, so it must
            // not resolve there — a DM reply leaking into a group thread.
            assert.equal(sends.length, 0)
            assert.equal(created.length, 1)
            assert.deepEqual(
                (created[0].body as { addresses: string[] }).addresses,
                ['+15555550123']
            )
        }
    )
})

test('imessage sendDirect uses an exact chatIdentifier match and caches it', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        (req) =>
            req.url.includes('/chat/query')
                ? {
                      status: 200,
                      json: envelope([
                          {
                              guid: 'iMessage;-;+15555550123',
                              chatIdentifier: '+1 (555) 555-0123',
                              participants: [{ address: '+15555550123' }]
                          }
                      ])
                  }
                : { status: 200, json: envelope({ guid: 'sent-1' }) },
        async (calls) => {
            const ctx = makeCtx()
            const target = { kind: 'user' as const, userId: '+15555550123' }
            await provider.sendDirect(ctx, target, 'one')
            await provider.sendDirect(ctx, target, 'two')
            const queries = calls.filter((c) => c.url.includes('/chat/query'))
            // Second send is served from the cache.
            assert.equal(queries.length, 1)
            const sends = calls.filter((c) => c.url.includes('/message/text'))
            assert.equal(sends.length, 2)
            assert.equal(
                (sends[0].body as { chatGuid: string }).chatGuid,
                'iMessage;-;+15555550123'
            )
        }
    )
})

test('imessage sendDirect refuses a bare handle when the Private API is off', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        () => ({ status: 200, json: envelope([]) }),
        async () => {
            await assert.rejects(
                provider.sendDirect(
                    makeCtx(baseConfig({ helperConnected: false })),
                    { kind: 'user', userId: '+15555559999' },
                    'hi'
                ),
                (err: unknown) =>
                    err instanceof ChannelSendError &&
                    err.kind === 'not_found' &&
                    // The handle must not survive into the error text.
                    !err.message.includes('5555559999')
            )
        }
    )
})

test('imessage sendDirect rejects a reply target', async () => {
    const provider = new IMessageChannelProvider()
    await assert.rejects(
        provider.sendDirect(makeCtx(), { kind: 'reply', messageId: 'm' }, 'hi')
    )
})

test('imessage classifies send failures and leaves route-404s retryable', async () => {
    const provider = new IMessageChannelProvider()
    const scope = `imessage:dm:${encodeURIComponent('iMessage;-;+1')}`
    const expectKind = async (
        status: number,
        message: string,
        kind: string | null
    ): Promise<void> => {
        await withStubbedFetch(
            () => ({
                status,
                json: { status, message: 'error', error: { message } }
            }),
            async () => {
                await assert.rejects(
                    provider.sendText(makeCtx(), scope, 'hi'),
                    (err: unknown) =>
                        kind === null
                            ? !(err instanceof ChannelSendError)
                            : err instanceof ChannelSendError &&
                              err.kind === kind
                )
            }
        )
    }
    await expectKind(401, 'bad password', 'forbidden')
    await expectKind(403, 'nope', 'forbidden')
    await expectKind(429, 'slow down', 'rate_limited')
    await expectKind(400, 'malformed', 'bad_format')
    await expectKind(404, 'chat not found', 'not_found')
    // not_found is permanent, so an old server missing the route must NOT be
    // classified as one — it has to keep the ladder-retry path.
    await expectKind(404, 'Cannot POST /api/v1/message/text', null)
    await expectKind(500, 'boom', null)
})

test('imessage register reuses the stored secret and restates the password', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        (req) => {
            if (req.url.includes('/server/info'))
                return {
                    status: 200,
                    json: envelope({
                        server_version: '1.9.9',
                        private_api: true,
                        helper_connected: true
                    })
                }
            if (req.url.includes('/webhook') && req.method === 'GET')
                return {
                    status: 200,
                    json: envelope([
                        {
                            id: 7,
                            url: `https://api.example.com/api/channels/hooks/imessage/chn-imsg-1?secret=stale`
                        }
                    ])
                }
            if (req.url.includes('/webhook') && req.method === 'POST')
                return { status: 200, json: envelope({ id: 9 }) }
            return { status: 200, json: envelope('pong') }
        },
        async (calls) => {
            const result = await provider.register(
                makeCtx(),
                'https://api.example.com/api/channels/hooks/imessage/chn-imsg-1'
            )
            assert.equal(result.ok, true)
            assert.equal(result.activate, true)
            // An existing secret is reused: re-registering must not orphan the
            // URL BlueBubbles already holds.
            assert.deepEqual(result.credentialsPatch, {
                serverPassword: PASSWORD,
                webhookSecret: SECRET
            })
            assert.equal(
                (result.configPatch as IMessageChannelConfig).webhookId,
                '9'
            )
            const stale = calls.filter((c) => c.method === 'DELETE')
            assert.equal(stale.length, 1)
            assert.ok(stale[0].url.includes('/webhook/7'))
            const created = calls.find(
                (c) => c.url.includes('/webhook') && c.method === 'POST'
            )
            const body = created?.body as { url: string; events: string[] }
            assert.ok(body.url.includes(`secret=${SECRET}`))
            // updated-message repeats the guid the dedup index already drops.
            assert.deepEqual(body.events, ['new-message'])
        }
    )
})

test('imessage register mints a secret when there is none, and warns without the helper', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        (req) => {
            if (req.url.includes('/server/info'))
                return {
                    status: 200,
                    json: envelope({
                        server_version: '1.9.9',
                        private_api: false,
                        helper_connected: false
                    })
                }
            if (req.url.includes('/webhook') && req.method === 'GET')
                return { status: 200, json: envelope([]) }
            if (req.url.includes('/webhook') && req.method === 'POST')
                return { status: 200, json: envelope({ id: 3 }) }
            return { status: 200, json: envelope('pong') }
        },
        async () => {
            const result = await provider.register(
                makeCtx(baseConfig(), { serverPassword: PASSWORD }),
                'https://api.example.com/api/channels/hooks/imessage/chn-imsg-1'
            )
            assert.equal(result.ok, true)
            const patch = result.credentialsPatch as {
                serverPassword: string
                webhookSecret: string
            }
            assert.equal(patch.serverPassword, PASSWORD)
            assert.ok(patch.webhookSecret.length >= 32)
            assert.match(result.message ?? '', /Private API helper/)
        }
    )
})

test('imessage register fails closed when the Mac is unreachable', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        () => ({ status: 502, json: { message: 'bad gateway' } }),
        async (calls) => {
            const result = await provider.register(
                makeCtx(),
                'https://api.example.com/api/channels/hooks/imessage/chn-imsg-1'
            )
            assert.equal(result.ok, false)
            // Nothing is persisted and no webhook is created when the ping
            // fails, so a retry starts from a clean slate.
            assert.equal(result.credentialsPatch, undefined)
            assert.equal(
                calls.filter((c) => c.url.includes('/webhook')).length,
                0
            )
            assert.match(result.message ?? '', /Tunnel|ngrok|Funnel/)
        }
    )
})

test('imessage test reports a stale webhook secret', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        (req) => {
            if (req.url.includes('/server/info'))
                return {
                    status: 200,
                    json: envelope({
                        server_version: '1.9.9',
                        private_api: true,
                        helper_connected: true
                    })
                }
            if (req.url.includes('/webhook'))
                return {
                    status: 200,
                    json: envelope([
                        {
                            id: 1,
                            url: 'https://api.example.com/api/channels/hooks/imessage/chn-imsg-1?secret=stale'
                        }
                    ])
                }
            return { status: 200, json: envelope('pong') }
        },
        async () => {
            const result = await provider.test(makeCtx())
            assert.equal(result.ok, false)
            assert.match(result.message, /stale secret/)
        }
    )
})

test('imessage test warns about a cleartext http server url', async () => {
    const provider = new IMessageChannelProvider()
    await withStubbedFetch(
        (req) => {
            if (req.url.includes('/server/info'))
                return {
                    status: 200,
                    json: envelope({
                        server_version: '1.9.9',
                        private_api: true,
                        helper_connected: true
                    })
                }
            if (req.url.includes('/webhook'))
                return {
                    status: 200,
                    json: envelope([
                        {
                            id: 1,
                            url: `https://api.example.com/api/channels/hooks/imessage/chn-imsg-1?secret=${SECRET}`
                        }
                    ])
                }
            return { status: 200, json: envelope('pong') }
        },
        async () => {
            const result = await provider.test(
                makeCtx(baseConfig({ serverUrl: 'http://93.184.216.34' }))
            )
            assert.match(result.message, /cleartext/)
        }
    )
})

test('imessage downloadAttachment rejects a foreign url scheme', async () => {
    const provider = new IMessageChannelProvider()
    await assert.rejects(
        provider.downloadAttachment(
            makeCtx(),
            {
                url: 'https://evil.example.com/steal',
                name: 'x',
                contentType: 'text/plain'
            },
            { maxBytes: 10 }
        ),
        /imessage-attachment/
    )
})

test('imessage format flattens markdown but keeps snake_case intact', () => {
    assert.equal(
        markdownToIMessagePlainText('**bold** and `code` and [x](http://y)'),
        'bold and code and x (http://y)'
    )
    // Stripping the underscore forms would corrupt these identifiers.
    assert.equal(
        markdownToIMessagePlainText('call my_func_name and __init__'),
        'call my_func_name and __init__'
    )
})

test('imessage bubbles split on blank lines and stay under the cap', () => {
    assert.deepEqual(splitIMessageBubbles('a\n\nb\n\n\nc', 4000), [
        'a',
        'b',
        'c'
    ])
    const long = `${'x '.repeat(3000)}end`
    const chunks = splitIMessageBubbles(long, 100)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) assert.ok(chunk.length <= 100)
    assert.deepEqual(splitIMessageBubbles('   \n\n  ', 4000), [])
})
