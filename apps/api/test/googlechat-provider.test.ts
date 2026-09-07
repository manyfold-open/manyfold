import type { GoogleChatChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { UnsupportedEventError } from '../src/modules/channels/channel-provider'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import { markdownToGoogleChat } from '../src/modules/channels/providers/googlechat-format'
import {
    resetGoogleChatJwksCache,
    resetGoogleChatTokenCache
} from '../src/modules/channels/providers/googlechat-auth'
import {
    GoogleChatChannelProvider,
    classifyGoogleChatError,
    googleChatTargetFromScopeKey
} from '../src/modules/channels/providers/googlechat.provider'

const CHAT_ISSUER = 'chat@system.gserviceaccount.com'
const OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const CHAT_JWKS_URL = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`
const APP_URL = 'https://api.example.com/api/channels/hooks/googlechat/chn-gc-1'
const PROJECT_NUMBER = '1234567890'
const SPACE = 'AAAASpace'

// One keypair for the whole file: signing is the slow part and every test wants
// the same "Google" identity behind the stubbed key set.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
})
const KID = 'test-kid-1'

const signingJwk = (): Record<string, unknown> => ({
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: KID,
    alg: 'RS256',
    use: 'sig'
})

const b64url = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64url')

const signJwt = (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {}
): string => {
    const head = b64url(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header })
    )
    const now = Math.floor(Date.now() / 1000)
    const payload = b64url(
        JSON.stringify({ iat: now - 10, exp: now + 600, ...claims })
    )
    const data = `${head}.${payload}`
    const sig = createSign('RSA-SHA256')
        .update(data)
        .sign(privateKey)
        .toString('base64url')
    return `${data}.${sig}`
}

// A syntactically valid service-account key. The private key is the same test
// keypair, which is all the token-mint path needs to produce a signature.
const SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'agent@test-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token'
})

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-gc-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'googlechat',
    label: 'googlechat test',
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
    overrides: Partial<GoogleChatChannelConfig> = {}
): GoogleChatChannelConfig => ({
    audienceType: 'app-url',
    audience: APP_URL,
    botUserId: null,
    botDisplayName: null,
    allowedSpaceIds: [],
    allowedUserIds: [],
    operatorUserIds: [],
    mentionOnly: true,
    shareSessionInChannel: false,
    threadIsolation: true,
    autoThread: true,
    progressMode: 'final',
    ...overrides
})

const makeCtx = (
    config: GoogleChatChannelConfig = baseConfig(),
    credentials: unknown = { serviceAccountJson: SERVICE_ACCOUNT_JSON },
    channel: ChannelRow = makeChannel()
) => ({ channel, config, credentials }) as never

const messageEvent = (
    overrides: {
        space?: Record<string, unknown>
        message?: Record<string, unknown>
        type?: string
    } = {}
): Record<string, unknown> => ({
    type: overrides.type ?? 'MESSAGE',
    eventTime: '2026-09-07T10:00:00Z',
    space: overrides.space ?? {
        name: `spaces/${SPACE}`,
        spaceType: 'DIRECT_MESSAGE',
        singleUserBotDm: true
    },
    message: {
        name: `spaces/${SPACE}/messages/msg-1`,
        sender: {
            name: 'users/111',
            displayName: 'Ada',
            email: 'ada@example.com',
            type: 'HUMAN'
        },
        text: 'hello',
        argumentText: 'hello',
        thread: { name: `spaces/${SPACE}/threads/thr-1` },
        threadReply: false,
        ...overrides.message
    }
})

const bearer = (token: string) => ({
    headers: { Authorization: `Bearer ${token}` },
    body: {},
    rawBody: '{}'
})

type FetchHandler = (
    url: string,
    init?: RequestInit
) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>

const withFetch = async (
    handler: FetchHandler,
    fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>
): Promise<void> => {
    const original = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        const { status = 200, body = {} } = await handler(url, init)
        const text = typeof body === 'string' ? body : JSON.stringify(body)
        return new Response(text, { status })
    }) as typeof globalThis.fetch
    try {
        await fn(calls)
    } finally {
        globalThis.fetch = original
    }
}

// Serves the key set plus a token mint, so a test only has to describe the
// Chat API call it actually cares about.
const googleBackend =
    (
        chatApi: (url: string, init?: RequestInit) => {
            status?: number
            body?: unknown
        } = () => ({ body: {} })
    ): FetchHandler =>
    (url, init) => {
        if (url === OIDC_JWKS_URL || url === CHAT_JWKS_URL)
            return { body: { keys: [signingJwk()] } }
        if (url === 'https://oauth2.googleapis.com/token')
            return { body: { access_token: 'ya29.test', expires_in: 3600 } }
        return chatApi(url, init)
    }

const resetCaches = (): void => {
    resetGoogleChatJwksCache()
    resetGoogleChatTokenCache()
}

test('googlechat validateConfig defaults to final progress and normalizes lists', () => {
    const provider = new GoogleChatChannelProvider()
    const config = provider.validateConfig({
        audience: `  ${APP_URL}  `,
        allowedUserIds: [' ada@example.com ', 'ada@example.com', '', 'bo@x.io'],
        allowedSpaceIds: ['  AAA  ']
    })
    // A streaming preview spends the space's single write per second, so this
    // provider is the one that must not default to it.
    assert.equal(config.progressMode, 'final')
    assert.equal(config.audienceType, 'app-url')
    assert.equal(config.audience, APP_URL)
    assert.deepEqual(config.allowedUserIds, ['ada@example.com', 'bo@x.io'])
    assert.deepEqual(config.allowedSpaceIds, ['AAA'])
    assert.equal(config.mentionOnly, true)
    assert.equal(config.threadIsolation, true)
    assert.equal(config.autoThread, true)
    assert.equal(config.contextProjection, true)
    assert.throws(() => provider.validateConfig(null))
})

test('googlechat validateConfig keeps an explicitly chosen preview mode', () => {
    const provider = new GoogleChatChannelProvider()
    // Guards the parseProgressMode fallback: 'preview' must be matched
    // explicitly, or an operator opting in would be silently reset to 'final'.
    assert.equal(
        provider.validateConfig({ progressMode: 'preview' }).progressMode,
        'preview'
    )
    assert.equal(
        provider.validateConfig({ progressMode: 'activity' }).progressMode,
        'activity'
    )
})

test('googlechat validateCredentials rejects an unusable service account key', () => {
    const provider = new GoogleChatChannelProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.deepEqual(
        provider.validateCredentials({
            serviceAccountJson: SERVICE_ACCOUNT_JSON
        }),
        { serviceAccountJson: SERVICE_ACCOUNT_JSON }
    )
    assert.throws(() => provider.validateCredentials({}), /required/)
    assert.throws(
        () => provider.validateCredentials({ serviceAccountJson: 'not json' }),
        /not valid JSON/
    )
    assert.throws(
        () =>
            provider.validateCredentials({
                serviceAccountJson: JSON.stringify({
                    type: 'authorized_user',
                    client_email: 'a@b.c',
                    private_key: 'PRIVATE KEY'
                })
            }),
        /service_account/
    )
    // A doctored token_uri would send a signed assertion for this account to an
    // attacker-controlled host.
    assert.throws(
        () =>
            provider.validateCredentials({
                serviceAccountJson: JSON.stringify({
                    type: 'service_account',
                    client_email: 'a@b.c',
                    private_key: '-----BEGIN PRIVATE KEY-----x',
                    token_uri: 'https://evil.example.com/token'
                })
            }),
        /token_uri/
    )
})

test('googlechat verifySignature accepts a Google OIDC id token for the app url', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(googleBackend(), async () => {
        const token = signJwt({
            iss: 'https://accounts.google.com',
            aud: APP_URL,
            email: CHAT_ISSUER,
            email_verified: true
        })
        assert.deepEqual(await provider.verifySignature(bearer(token), makeCtx()), {
            ok: true
        })
    })
})

test('googlechat verifySignature rejects a token that is not from Chat', async () => {
    const provider = new GoogleChatChannelProvider()
    const ctx = makeCtx()

    const check = async (claims: Record<string, unknown>): Promise<string> => {
        resetCaches()
        let reason = ''
        await withFetch(googleBackend(), async () => {
            const res = await provider.verifySignature(
                bearer(signJwt(claims)),
                ctx
            )
            assert.equal(res.ok, false)
            reason = res.reason ?? ''
        })
        return reason
    }

    const base = {
        iss: 'https://accounts.google.com',
        aud: APP_URL,
        email: CHAT_ISSUER,
        email_verified: true
    }
    // Any Google-issued token for this URL would otherwise be accepted, so the
    // Chat identity has to be pinned by the verified email claim.
    assert.equal(
        await check({ ...base, email: 'someone@else.example.com' }),
        'unexpected_token_identity'
    )
    assert.equal(
        await check({ ...base, email_verified: false }),
        'email_not_verified'
    )
    assert.match(
        await check({ ...base, aud: 'https://attacker.example.com/hook' }),
        /^token_verification_failed:/
    )
    assert.match(
        await check({ ...base, exp: Math.floor(Date.now() / 1000) - 60 }),
        /^token_verification_failed:/
    )
})

test('googlechat verifySignature accepts a self-signed Chat JWT in project-number mode', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    const ctx = makeCtx(
        baseConfig({ audienceType: 'project-number', audience: PROJECT_NUMBER })
    )
    await withFetch(googleBackend(), async (calls) => {
        const token = signJwt({ iss: CHAT_ISSUER, aud: PROJECT_NUMBER })
        assert.deepEqual(await provider.verifySignature(bearer(token), ctx), {
            ok: true
        })
        // The two modes are signed by different identities and must not share
        // a key set.
        assert.ok(calls.some((c) => c.url === CHAT_JWKS_URL))
    })

    resetCaches()
    await withFetch(googleBackend(), async () => {
        const wrongIssuer = signJwt({
            iss: 'https://accounts.google.com',
            aud: PROJECT_NUMBER
        })
        const res = await provider.verifySignature(bearer(wrongIssuer), ctx)
        assert.equal(res.ok, false)
    })
})

test('googlechat verifySignature fails closed when the key set cannot be fetched', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(
        (url) =>
            url === OIDC_JWKS_URL
                ? { status: 500, body: 'upstream down' }
                : { body: {} },
        async () => {
            const token = signJwt({
                iss: 'https://accounts.google.com',
                aud: APP_URL,
                email: CHAT_ISSUER,
                email_verified: true
            })
            const res = await provider.verifySignature(
                bearer(token),
                makeCtx()
            )
            assert.equal(res.ok, false)
            assert.match(res.reason ?? '', /token_verification_failed/)
        }
    )
})

test('googlechat verifySignature rejects a missing bearer or unset audience', async () => {
    const provider = new GoogleChatChannelProvider()
    assert.deepEqual(
        await provider.verifySignature(
            { headers: {}, body: {}, rawBody: '{}' },
            makeCtx()
        ),
        { ok: false, reason: 'missing_bearer_token' }
    )
    assert.deepEqual(
        await provider.verifySignature(
            bearer('x.y.z'),
            makeCtx(baseConfig({ audience: null }))
        ),
        { ok: false, reason: 'audience_missing' }
    )
})

test('googlechat parseInbound normalizes a direct message', () => {
    const provider = new GoogleChatChannelProvider()
    const event = provider.parseInbound(
        { headers: {}, body: messageEvent(), rawBody: '' },
        makeCtx()
    )
    assert.equal(event.chatType, 'private')
    assert.equal(event.chatId, SPACE)
    assert.equal(event.senderId, '111')
    assert.equal(event.senderName, 'Ada')
    assert.equal(event.text, 'hello')
    assert.equal(event.isMention, true)
    assert.equal(event.messageId, `spaces/${SPACE}/messages/msg-1`)
    assert.equal(event.providerEventId, `spaces/${SPACE}/messages/msg-1`)
    // Chat opens a thread for every top-level message; a DM must not adopt it,
    // or every message would render as an expandable side thread.
    assert.equal(event.threadId, null)
    assert.equal(event.threadFresh, undefined)
})

test('googlechat parseInbound adopts the auto-created thread only in a space', () => {
    const provider = new GoogleChatChannelProvider()
    const spacePayload = {
        name: `spaces/${SPACE}`,
        spaceType: 'SPACE',
        displayName: 'eng'
    }
    const mentioned = {
        annotations: [
            {
                type: 'USER_MENTION',
                userMention: { user: { name: 'users/bot', type: 'BOT' } }
            }
        ]
    }

    const top = provider.parseInbound(
        {
            headers: {},
            body: messageEvent({ space: spacePayload, message: mentioned }),
            rawBody: ''
        },
        makeCtx()
    )
    assert.equal(top.chatType, 'group')
    assert.equal(top.isMention, true)
    assert.equal(top.threadId, 'thr-1')
    // threadFresh tells history backfill there is nothing above this message.
    assert.equal(top.threadFresh, true)

    const inThread = provider.parseInbound(
        {
            headers: {},
            body: messageEvent({
                space: spacePayload,
                message: { ...mentioned, threadReply: true }
            }),
            rawBody: ''
        },
        makeCtx()
    )
    assert.equal(inThread.threadId, 'thr-1')
    assert.equal(inThread.threadFresh, undefined)

    const noAutoThread = provider.parseInbound(
        {
            headers: {},
            body: messageEvent({ space: spacePayload, message: mentioned }),
            rawBody: ''
        },
        makeCtx(baseConfig({ autoThread: false }))
    )
    assert.equal(noAutoThread.threadId, null)
})

test('googlechat parseInbound gates a space message on a real bot mention', () => {
    const provider = new GoogleChatChannelProvider()
    const body = messageEvent({
        space: { name: `spaces/${SPACE}`, spaceType: 'SPACE' },
        message: {
            annotations: [
                {
                    type: 'USER_MENTION',
                    userMention: { user: { name: 'users/999', type: 'HUMAN' } }
                }
            ]
        }
    })
    // Mentioning a colleague is not mentioning the app.
    assert.equal(
        provider.parseInbound({ headers: {}, body, rawBody: '' }, makeCtx())
            .isMention,
        false
    )
})

test('googlechat parseInbound drops events that must not reach the agent', () => {
    const provider = new GoogleChatChannelProvider()
    const reject = (body: unknown): string => {
        try {
            provider.parseInbound({ headers: {}, body, rawBody: '' }, makeCtx())
        } catch (err) {
            assert.ok(err instanceof UnsupportedEventError)
            return err.eventType
        }
        throw new Error('expected UnsupportedEventError')
    }
    assert.equal(reject(messageEvent({ type: 'ADDED_TO_SPACE' })), 'ADDED_TO_SPACE')
    assert.equal(reject(messageEvent({ type: 'CARD_CLICKED' })), 'CARD_CLICKED')
    assert.equal(
        reject(
            messageEvent({
                message: { sender: { name: 'users/bot', type: 'BOT' } }
            })
        ),
        'bot_message'
    )
    assert.equal(
        reject(messageEvent({ message: { text: '', argumentText: '' } })),
        'empty_text'
    )
})

test('googlechat parseInbound keeps a downloadable attachment and skips a Drive one', () => {
    const provider = new GoogleChatChannelProvider()
    const event = provider.parseInbound(
        {
            headers: {},
            body: messageEvent({
                message: {
                    text: '',
                    argumentText: '',
                    attachment: [
                        {
                            contentName: 'notes.pdf',
                            contentType: 'application/pdf',
                            attachmentDataRef: { resourceName: 'res-123' }
                        },
                        {
                            contentName: 'sheet.gsheet',
                            source: 'DRIVE_FILE',
                            driveDataRef: { driveFileId: 'drive-1' }
                        }
                    ]
                }
            }),
            rawBody: ''
        },
        makeCtx()
    )
    // A file-only message is still a turn; a Drive reference is not readable
    // with the app's own credentials, so it is not offered as an attachment.
    assert.equal(event.attachments?.length, 1)
    assert.equal(event.attachments?.[0].url, 'googlechat-media:res-123')
    assert.equal(event.attachments?.[0].name, 'notes.pdf')
})

test('googlechat parseInbound keeps the command text on a native slash invocation', () => {
    const provider = new GoogleChatChannelProvider()
    const event = provider.parseInbound(
        {
            headers: {},
            body: messageEvent({
                message: {
                    text: '/new billing questions',
                    // Chat strips the command from argumentText, which would
                    // leave the dispatcher with no command to match.
                    argumentText: ' billing questions',
                    slashCommand: { commandId: '1' }
                }
            }),
            rawBody: ''
        },
        makeCtx()
    )
    assert.equal(event.text, '/new billing questions')
    assert.equal(event.commandInvocation, true)
})

test('googlechat computeScopeKey separates dms, spaces, threads and senders', () => {
    const provider = new GoogleChatChannelProvider()
    const event = {
        chatId: SPACE,
        senderId: '111',
        threadId: null as string | null,
        chatType: 'private' as 'private' | 'group'
    }

    const key = (
        overrides: Record<string, unknown>,
        config = baseConfig()
    ): string =>
        provider.computeScopeKey({ ...event, ...overrides } as never, config)
            .scopeKey

    assert.equal(key({}), `googlechat:dm:${SPACE}:111`)
    assert.equal(
        key({ threadId: 'thr-1' }),
        `googlechat:dm:${SPACE}:111:thread:thr-1`
    )
    assert.equal(key({ chatType: 'group' }), `googlechat:space:${SPACE}:111`)
    assert.equal(
        key({ chatType: 'group' }, baseConfig({ shareSessionInChannel: true })),
        `googlechat:space:${SPACE}`
    )
    assert.equal(
        key({ chatType: 'group', threadId: 'thr-1' }),
        `googlechat:space:${SPACE}:thread:thr-1`
    )
    assert.equal(
        key(
            { chatType: 'group', threadId: 'thr-1' },
            baseConfig({ threadIsolation: false, shareSessionInChannel: true })
        ),
        `googlechat:space:${SPACE}`
    )
})

test('googlechat scope keys round-trip to a send target', () => {
    assert.deepEqual(googleChatTargetFromScopeKey(`googlechat:dm:${SPACE}:111`), {
        space: `spaces/${SPACE}`,
        thread: null
    })
    assert.deepEqual(
        googleChatTargetFromScopeKey(`googlechat:space:${SPACE}:thread:thr-1`),
        { space: `spaces/${SPACE}`, thread: `spaces/${SPACE}/threads/thr-1` }
    )
    // The thread marker sits at a different index in a per-user scope.
    assert.deepEqual(
        googleChatTargetFromScopeKey(`googlechat:dm:${SPACE}:111:thread:thr-9`),
        { space: `spaces/${SPACE}`, thread: `spaces/${SPACE}/threads/thr-9` }
    )
    assert.throws(() => googleChatTargetFromScopeKey('googlechat:dm'))
})

test('googlechat evaluateInboundActor matches a sender by id or email', () => {
    const provider = new GoogleChatChannelProvider()
    const event = {
        chatId: SPACE,
        senderId: '111',
        raw: { message: { sender: { email: 'ada@example.com' } } }
    } as never

    assert.deepEqual(provider.evaluateInboundActor(event, baseConfig()), {
        allowed: true,
        operator: false
    })
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['ADA@example.com'] })
        ),
        { allowed: true, operator: false }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['users/111'] })
        ),
        { allowed: true, operator: false }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['bo@x.io'] })
        ),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    // An operator on a channel with a non-empty allowlist would otherwise have
    // /model dropped by the chat gate before operator rights were checked.
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({
                allowedUserIds: ['bo@x.io'],
                operatorUserIds: ['ada@example.com']
            })
        ),
        { allowed: true, operator: true }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedSpaceIds: ['OtherSpace'] })
        ),
        { allowed: false, reason: 'space_not_allowed', operator: false }
    )
})

test('googlechat sendText threads the reply and asks Chat to honor it', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(
        googleBackend(() => ({
            body: {
                name: `spaces/${SPACE}/messages/out-1`,
                thread: { name: `spaces/${SPACE}/threads/thr-1` }
            }
        })),
        async (calls) => {
            const res = await provider.sendText(
                makeCtx(),
                `googlechat:space:${SPACE}:thread:thr-1`,
                'hi there'
            )
            assert.equal(res.providerMessageId, `spaces/${SPACE}/messages/out-1`)
            const send = calls.find((c) => c.url.includes('/messages'))
            assert.ok(send)
            // Without messageReplyOption, Chat silently ignores thread.name and
            // drops the reply at the top level of the space.
            assert.match(
                send.url,
                /messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD/
            )
            assert.deepEqual(JSON.parse(String(send.init?.body)), {
                text: 'hi there',
                thread: { name: `spaces/${SPACE}/threads/thr-1` }
            })
        }
    )
})

test('googlechat sendText omits an unthreaded scope and drops a foreign thread', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(
        googleBackend(() => ({ body: { name: 'spaces/X/messages/1' } })),
        async (calls) => {
            await provider.sendText(
                makeCtx(),
                `googlechat:dm:${SPACE}:111`,
                'flat reply'
            )
            const send = calls.find((c) => c.url.includes('/messages'))
            assert.ok(send)
            assert.doesNotMatch(send.url, /messageReplyOption/)
            assert.deepEqual(JSON.parse(String(send.init?.body)), {
                text: 'flat reply'
            })
        }
    )

    resetCaches()
    await withFetch(
        googleBackend(() => ({
            body: {
                name: 'spaces/X/messages/1',
                // A thread that does not belong to the space being written to
                // is a 400 INVALID_ARGUMENT, which is permanent and would
                // dead-letter the rest of the reply.
                thread: { name: 'spaces/SomewhereElse/threads/thr-9' }
            }
        })),
        async (calls) => {
            await provider.sendText(
                makeCtx(),
                `googlechat:dm:${SPACE}:111`,
                'y'.repeat(9000)
            )
            const sends = calls.filter((c) => c.url.includes('/messages'))
            assert.ok(sends.length > 1)
            assert.equal(
                JSON.parse(String(sends[1].init?.body)).thread,
                undefined
            )
            assert.doesNotMatch(sends[1].url, /messageReplyOption/)
        }
    )
})

test('googlechat sendText keeps a long reply in one thread', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(
        googleBackend(() => ({
            body: {
                name: `spaces/${SPACE}/messages/out`,
                thread: { name: `spaces/${SPACE}/threads/opened` }
            }
        })),
        async (calls) => {
            await provider.sendText(
                makeCtx(),
                `googlechat:dm:${SPACE}:111`,
                'x'.repeat(9000)
            )
            const sends = calls.filter((c) => c.url.includes('/messages'))
            assert.ok(sends.length > 1)
            // Chunk 1 opened a thread; the rest must follow it or a long reply
            // scatters across the space.
            const later = JSON.parse(String(sends[1].init?.body))
            assert.deepEqual(later.thread, {
                name: `spaces/${SPACE}/threads/opened`
            })
        }
    )
})

test('googlechat preview edits in place and falls back to a fresh post', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(
        googleBackend((_url, init) =>
            init?.method === 'PATCH'
                ? { body: { name: 'patched' } }
                : { body: { name: `spaces/${SPACE}/messages/prev-1` } }
        ),
        async (calls) => {
            const ctx = makeCtx()
            const handle = await provider.sendPreviewStart(
                ctx,
                `googlechat:dm:${SPACE}:111`
            )
            assert.equal(
                handle.providerMessageId,
                `spaces/${SPACE}/messages/prev-1`
            )
            await provider.updatePreview(ctx, handle, 'partial answer')
            await provider.finishPreview(ctx, handle, 'final answer')
            const patches = calls.filter((c) => c.init?.method === 'PATCH')
            assert.equal(patches.length, 2)
            assert.match(patches[0].url, /updateMask=text/)
            assert.equal(
                JSON.parse(String(patches[1].init?.body)).text,
                'final answer'
            )
        }
    )

    resetCaches()
    await withFetch(
        googleBackend((_url, init) =>
            init?.method === 'PATCH'
                ? { status: 404, body: { error: { status: 'NOT_FOUND' } } }
                : { body: { name: `spaces/${SPACE}/messages/prev-1` } }
        ),
        async (calls) => {
            const ctx = makeCtx()
            const handle = await provider.sendPreviewStart(
                ctx,
                `googlechat:dm:${SPACE}:111`
            )
            // A failed edit must not lose the reply — the turn's whole output
            // is in that final patch.
            await provider.finishPreview(ctx, handle, 'final answer')
            const posts = calls.filter(
                (c) => c.init?.method === 'POST' && c.url.includes('/messages')
            )
            assert.equal(posts.length, 2)
            assert.equal(
                JSON.parse(String(posts[1].init?.body)).text,
                'final answer'
            )
        }
    )
})

test('googlechat surfaces a rate limit as a retryable send error', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(
        googleBackend(() => ({
            status: 429,
            body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'slow down' } }
        })),
        async () => {
            await assert.rejects(
                provider.sendText(makeCtx(), `googlechat:dm:${SPACE}:111`, 'hi'),
                (err: unknown) => {
                    assert.ok(err instanceof ChannelSendError)
                    assert.equal(err.kind, 'rate_limited')
                    return true
                }
            )
        }
    )
})

test('googlechat classifies errors by rpc status, then by http code', () => {
    assert.equal(classifyGoogleChatError(429, 'RESOURCE_EXHAUSTED'), 'rate_limited')
    assert.equal(classifyGoogleChatError(403, 'PERMISSION_DENIED'), 'forbidden')
    assert.equal(classifyGoogleChatError(404, 'NOT_FOUND'), 'not_found')
    assert.equal(classifyGoogleChatError(400, 'INVALID_ARGUMENT'), 'bad_format')
    assert.equal(classifyGoogleChatError(400, 'FAILED_PRECONDITION'), 'bad_format')
    assert.equal(classifyGoogleChatError(503, 'UNAVAILABLE'), 'transient')
    // No rpc status: fall back to the HTTP code.
    assert.equal(classifyGoogleChatError(404, null), 'not_found')
    // A 401 is usually a token minted before a credential rotation. Classifying
    // it as 'forbidden' would dead-letter a reply a re-mint would deliver.
    assert.equal(classifyGoogleChatError(401, null), null)
    assert.equal(classifyGoogleChatError(500, null), null)
    assert.equal(classifyGoogleChatError(418, 'SOMETHING_NEW'), null)
})

test('googlechat downloadAttachment resolves the media ref and caps the read', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    const original = globalThis.fetch
    try {
        globalThis.fetch = (async (input: string, init?: RequestInit) => {
            const url = String(input)
            if (url === 'https://oauth2.googleapis.com/token')
                return new Response(
                    JSON.stringify({
                        access_token: 'ya29.test',
                        expires_in: 3600
                    }),
                    { status: 200 }
                )
            assert.equal(
                url,
                'https://chat.googleapis.com/v1/media/res-123?alt=media'
            )
            assert.equal(
                (init?.headers as Record<string, string>).Authorization,
                'Bearer ya29.test'
            )
            return new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { 'content-type': 'application/pdf' }
            })
        }) as typeof globalThis.fetch

        const attachment = {
            url: 'googlechat-media:res-123',
            name: 'notes.pdf',
            contentType: 'application/pdf',
            size: null
        }
        const file = await provider.downloadAttachment(makeCtx(), attachment, {
            maxBytes: 1024
        })
        assert.equal(file.name, 'notes.pdf')
        assert.equal(file.contentType, 'application/pdf')
        assert.equal(file.bytes.length, 3)

        await assert.rejects(
            provider.downloadAttachment(makeCtx(), attachment, { maxBytes: 2 }),
            /exceeds 2 bytes/
        )
        await assert.rejects(
            provider.downloadAttachment(
                makeCtx(),
                { ...attachment, url: 'https://evil.example.com/x' },
                { maxBytes: 1024 }
            ),
            /not a media url/
        )
    } finally {
        globalThis.fetch = original
    }
})

test('googlechat register proves the key and captures the app-url audience', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(googleBackend(() => ({ body: { spaces: [] } })), async () => {
        const result = await provider.register(
            makeCtx(baseConfig({ audience: null })),
            APP_URL
        )
        assert.equal(result.ok, true)
        // Chat has no verification handshake, so register() is the only thing
        // that can take the channel out of draft.
        assert.equal(result.activate, true)
        assert.equal(
            (result.configPatch as GoogleChatChannelConfig).audience,
            APP_URL
        )
    })

    resetCaches()
    await withFetch(
        googleBackend(() => ({ body: { spaces: [] } })),
        async () => {
            // Project-number mode has no URL to infer the audience from, and
            // activating without one would take the channel live in a state
            // where every inbound request fails verification.
            const result = await provider.register(
                makeCtx(
                    baseConfig({
                        audienceType: 'project-number',
                        audience: null
                    })
                ),
                APP_URL
            )
            assert.equal(result.ok, false)
            assert.equal(result.activate, undefined)
        }
    )

    resetCaches()
    await withFetch(
        googleBackend(() => ({
            status: 403,
            body: { error: { status: 'PERMISSION_DENIED', message: 'no scope' } }
        })),
        async () => {
            const result = await provider.register(makeCtx(), APP_URL)
            assert.equal(result.ok, false)
            assert.equal(result.activate, undefined)
        }
    )
})

test('googlechat test() reports draft and a missing audience as not ready', async () => {
    resetCaches()
    const provider = new GoogleChatChannelProvider()
    await withFetch(googleBackend(() => ({ body: { spaces: [] } })), async () => {
        const draft = await provider.test(
            makeCtx(
                baseConfig({ audience: null }),
                { serviceAccountJson: SERVICE_ACCOUNT_JSON },
                makeChannel({ status: 'draft' })
            )
        )
        assert.equal(draft.ok, false)
        assert.match(draft.message, /audience not set/)
        assert.match(draft.message, /still draft/)

        const ready = await provider.test(makeCtx())
        assert.equal(ready.ok, true)
    })

    const noCreds = await provider.test(makeCtx(baseConfig(), null))
    assert.equal(noCreds.ok, false)
})

test('googlechat markdown maps onto the Chat dialect', () => {
    assert.equal(markdownToGoogleChat('**bold**'), '*bold*')
    assert.equal(markdownToGoogleChat('__bold__'), '*bold*')
    // Converting bold first and italic second would re-match the *bold* just
    // produced and demote it to _bold_.
    assert.equal(markdownToGoogleChat('**b** and *i*'), '*b* and _i_')
    assert.equal(markdownToGoogleChat('~~gone~~'), '~gone~')
    assert.equal(
        markdownToGoogleChat('[Manyfold](https://manyfold.ai)'),
        '<https://manyfold.ai|Manyfold>'
    )
    assert.equal(markdownToGoogleChat('### Heading'), '*Heading*')
    assert.equal(markdownToGoogleChat('1. first\n2. second'), '• first\n• second')
    assert.equal(markdownToGoogleChat('a\n\n---\n\nb'), 'a\n\nb')
})

test('googlechat markdown leaves code spans and fences untouched', () => {
    // Rewriting inside a snippet corrupts it: [x](y) is not a link there, and
    // **p is not bold.
    assert.equal(
        markdownToGoogleChat('use `arr[0](x)` here'),
        'use `arr[0](x)` here'
    )
    assert.equal(
        markdownToGoogleChat('```\nint **pp = &p;\n```'),
        '```\nint **pp = &p;\n```'
    )
    assert.equal(
        markdownToGoogleChat('**real** and `**not**`'),
        '*real* and `**not**`'
    )
})
