import type { SlackChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
    getGlobalDispatcher,
    MockAgent,
    setGlobalDispatcher,
    type Dispatcher
} from 'undici'
import type { ChannelRow } from '@manyfold/db'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import {
    SlackChannelProvider,
    buildSlackAppManifest
} from '../src/modules/channels/providers/slack.provider'
import { SLASH_COMMAND_SPECS } from '../src/modules/channels/slash/commands'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'slack',
    label: 'slack test',
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
    overrides: Partial<SlackChannelConfig> = {}
): SlackChannelConfig => ({
    botUserId: 'U_BOT',
    teamId: 'T1',
    allowedUserIds: [],
    operatorUserIds: [],
    mentionOnly: true,
    shareSessionInChannel: false,
    threadIsolation: true,
    progressMode: 'preview',
    ...overrides
})

const makeCredentials = () => ({
    botToken: 'xoxb-test-token-1234567890',
    signingSecret: 'signing-secret-value-1234567890'
})

const signSlackBody = (
    secret: string,
    timestamp: string,
    rawBody: string
): string =>
    `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`

test('slack validateCredentials enforces token + signing secret', () => {
    const provider = new SlackChannelProvider()
    assert.throws(
        () =>
            provider.validateCredentials({
                botToken: 'oops',
                signingSecret: 'short'
            }),
        /xoxb-/
    )
    assert.throws(
        () =>
            provider.validateCredentials({
                botToken: 'xoxb-fine-fine',
                signingSecret: 'short'
            }),
        /signingSecret/
    )
    const ok = provider.validateCredentials(makeCredentials())
    assert.equal(ok?.botToken, 'xoxb-test-token-1234567890')
})

test('slack verifySignature: signed url_verification returns challenge', () => {
    const provider = new SlackChannelProvider()
    const credentials = makeCredentials()
    const ts = String(Math.floor(Date.now() / 1000))
    const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'CHAL'
    })
    const sig = signSlackBody(credentials.signingSecret, ts, rawBody)
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials
    }
    const result = provider.verifySignature(
        {
            headers: {
                'x-slack-request-timestamp': ts,
                'x-slack-signature': sig
            },
            body: JSON.parse(rawBody),
            rawBody
        },
        ctx
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.challengeResponse, {
        status: 200,
        body: { challenge: 'CHAL' }
    })
})

test('slack verifySignature: unsigned url_verification is rejected', () => {
    const provider = new SlackChannelProvider()
    const result = provider.verifySignature(
        {
            headers: {},
            body: { type: 'url_verification', challenge: 'CHAL' }
        },
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        }
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_signature_headers')
})

test('slack verifySignature: accepts valid HMAC and rejects tampered body', () => {
    const provider = new SlackChannelProvider()
    const credentials = makeCredentials()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials
    }
    const ts = String(Math.floor(Date.now() / 1000))
    const rawBody = JSON.stringify({
        type: 'event_callback',
        event: { type: 'message' }
    })
    const sig = signSlackBody(credentials.signingSecret, ts, rawBody)
    const ok = provider.verifySignature(
        {
            headers: {
                'x-slack-request-timestamp': ts,
                'x-slack-signature': sig
            },
            body: JSON.parse(rawBody),
            rawBody
        },
        ctx
    )
    assert.equal(ok.ok, true)

    const tampered = signSlackBody(credentials.signingSecret, ts, rawBody + ' ')
    const bad = provider.verifySignature(
        {
            headers: {
                'x-slack-request-timestamp': ts,
                'x-slack-signature': tampered
            },
            body: JSON.parse(rawBody),
            rawBody
        },
        ctx
    )
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'signature_mismatch')
})

test('slack verifySignature: rejects stale timestamps', () => {
    const provider = new SlackChannelProvider()
    const credentials = makeCredentials()
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600)
    const rawBody = '{}'
    const sig = signSlackBody(credentials.signingSecret, oldTs, rawBody)
    const result = provider.verifySignature(
        {
            headers: {
                'x-slack-request-timestamp': oldTs,
                'x-slack-signature': sig
            },
            body: {},
            rawBody
        },
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials
        }
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timestamp_out_of_range')
})

test('slack parseInbound extracts message and strips bot mention', () => {
    const provider = new SlackChannelProvider()
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                type: 'event_callback',
                event_id: 'Ev1',
                team_id: 'T1',
                event: {
                    type: 'app_mention',
                    user: 'U_USER',
                    channel: 'C1',
                    channel_type: 'channel',
                    text: '<@U_BOT> hello',
                    ts: '1730000000.000100',
                    team: 'T1'
                }
            }
        },
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: null
        }
    )
    assert.equal(event.chatType, 'group')
    assert.equal(event.chatId, 'T1:C1')
    assert.equal(event.text, 'hello')
    assert.equal(event.isMention, true)
    assert.equal(event.messageId, '1730000000.000100')
    assert.equal(event.replyToMessageId, null)
})

test('slack parseInbound maps thread replies to replyToMessageId from raw thread_ts', () => {
    const provider = new SlackChannelProvider()
    const parse = (event: Record<string, unknown>) =>
        provider.parseInbound(
            {
                headers: {},
                body: {
                    type: 'event_callback',
                    event_id: 'Ev2',
                    team_id: 'T1',
                    event: {
                        type: 'app_mention',
                        user: 'U_USER',
                        channel: 'C1',
                        channel_type: 'channel',
                        team: 'T1',
                        ...event
                    }
                }
            },
            {
                channel: makeChannel(),
                config: provider.validateConfig({
                    ...(baseConfig() as unknown as Record<string, unknown>),
                    autoThread: true,
                    threadIsolation: true,
                    mentionOnly: false
                }),
                credentials: null
            }
        )
    const reply = parse({
        text: '<@U_BOT> hello',
        ts: '1730.0002',
        thread_ts: '1730.0001'
    })
    assert.equal(reply.replyToMessageId, '1730.0001')
    // Auto-thread roots threadId at the message's own ts; that is not a reply.
    const topLevel = parse({ text: '<@U_BOT> hello', ts: '1730.0003' })
    assert.equal(topLevel.threadId, '1730.0003')
    assert.equal(topLevel.replyToMessageId, null)
})

test('slack computeScopeKey: thread isolation', () => {
    const provider = new SlackChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e',
            chatId: 'T1:C1',
            chatType: 'group',
            senderId: 'U_USER',
            senderName: null,
            text: 'hi',
            threadId: '1730.0001',
            isMention: true,
            raw: {}
        },
        baseConfig()
    )
    assert.equal(result.scopeKey, 'slack:T1:C1:thread:1730.0001')
})

test('slack computeScopeKey: shareSessionInChannel collapses to channel', () => {
    const provider = new SlackChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e',
            chatId: 'T1:C1',
            chatType: 'group',
            senderId: 'U_USER',
            senderName: null,
            text: 'hi',
            threadId: null,
            isMention: true,
            raw: {}
        },
        baseConfig({ shareSessionInChannel: true, threadIsolation: false })
    )
    assert.equal(result.scopeKey, 'slack:T1:C1')
})

test('slack sendText posts to chat.postMessage with the right channel', async () => {
    const provider = new SlackChannelProvider()
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_token, method, params) => {
        calls.push({ method, body: params })
        return { ok: true, channel: params.channel as string, ts: '17.10' }
    }
    const result = await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        },
        'slack:T1:C9:U_USER',
        '**bold** and `code`'
    )
    assert.equal(result.providerMessageId, '17.10')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'chat.postMessage')
    assert.equal(calls[0]?.body.channel, 'C9')
    assert.equal(calls[0]?.body.text, '*bold* and `code`')
})

test('slack validateConfig sanitizes actor lists (arrays only, trimmed, deduped)', () => {
    const provider = new SlackChannelProvider()
    const config = provider.validateConfig({
        mentionOnly: true,
        allowedUserIds: [' U1 ', 'U1', '', 42, 'U2'],
        operatorUserIds: 'not-an-array'
    })
    assert.deepEqual(config.allowedUserIds, ['U1', 'U2'])
    assert.deepEqual(config.operatorUserIds, [])
})

const actorEvent = (
    overrides: { senderId?: string; chatId?: string } = {}
) => ({
    providerEventId: 'e',
    chatId: overrides.chatId ?? 'T1:C1',
    chatType: 'group' as const,
    senderId: overrides.senderId ?? 'U_USER',
    senderName: null,
    text: 'hi',
    threadId: null,
    isMention: true,
    raw: {}
})

test('slack evaluateInboundActor: empty allowlist permits everyone, no operators', () => {
    const provider = new SlackChannelProvider()
    const policy = provider.evaluateInboundActor(actorEvent(), baseConfig())
    assert.equal(policy.allowed, true)
    assert.equal(policy.operator, false)
})

test('slack evaluateInboundActor: allowlist denies an unlisted sender', () => {
    const provider = new SlackChannelProvider()
    const policy = provider.evaluateInboundActor(
        actorEvent({ senderId: 'U_BAD' }),
        baseConfig({ allowedUserIds: ['U_OK'] })
    )
    assert.equal(policy.allowed, false)
    assert.equal(policy.reason, 'sender_not_allowed')
})

test('slack evaluateInboundActor: operator implies chat permission', () => {
    const provider = new SlackChannelProvider()
    const policy = provider.evaluateInboundActor(
        actorEvent({ senderId: 'U_OP' }),
        baseConfig({ allowedUserIds: ['U_OK'], operatorUserIds: ['U_OP'] })
    )
    assert.equal(policy.allowed, true)
    assert.equal(policy.operator, true)
})

test('slack evaluateInboundActor: team mismatch is rejected, null teamId allows', () => {
    const provider = new SlackChannelProvider()
    const mismatch = provider.evaluateInboundActor(
        actorEvent({ chatId: 'T2:C1' }),
        baseConfig({ teamId: 'T1' })
    )
    assert.equal(mismatch.allowed, false)
    assert.equal(mismatch.reason, 'team_mismatch')
    const noBinding = provider.evaluateInboundActor(
        actorEvent({ chatId: 'T2:C1' }),
        baseConfig({ teamId: null })
    )
    assert.equal(noBinding.allowed, true)
})

test('slack evaluateInboundActor: tolerates legacy config missing actor lists', () => {
    const provider = new SlackChannelProvider()
    const legacy = {
        botUserId: 'U_BOT',
        teamId: null,
        mentionOnly: true,
        shareSessionInChannel: false,
        threadIsolation: true,
        progressMode: 'preview'
    } as unknown as SlackChannelConfig
    const policy = provider.evaluateInboundActor(actorEvent(), legacy)
    assert.equal(policy.allowed, true)
    assert.equal(policy.operator, false)
})

const slashForm = (
    overrides: Record<string, string> = {}
): Record<string, string> => ({
    command: '/new',
    text: 'feat x',
    user_id: 'U_USER',
    user_name: 'alice',
    channel_id: 'C1',
    team_id: 'T1',
    trigger_id: '13345.738.abc',
    response_url: 'https://hooks.slack.com/commands/T1/1/xyz',
    ...overrides
})

const encodeForm = (form: Record<string, string>): string =>
    new URLSearchParams(form).toString()

test('slack verifySignature accepts a signed urlencoded form body', () => {
    const provider = new SlackChannelProvider()
    const credentials = makeCredentials()
    const ts = String(Math.floor(Date.now() / 1000))
    const rawBody = encodeForm(slashForm())
    const sig = signSlackBody(credentials.signingSecret, ts, rawBody)
    const ok = provider.verifySignature(
        {
            headers: {
                'x-slack-request-timestamp': ts,
                'x-slack-signature': sig
            },
            body: Object.fromEntries(new URLSearchParams(rawBody)),
            rawBody
        },
        { channel: makeChannel(), config: baseConfig(), credentials }
    )
    assert.equal(ok.ok, true)
    const bad = provider.verifySignature(
        {
            headers: {
                'x-slack-request-timestamp': ts,
                'x-slack-signature': signSlackBody(
                    credentials.signingSecret,
                    ts,
                    rawBody + '&x=1'
                )
            },
            body: Object.fromEntries(new URLSearchParams(rawBody)),
            rawBody
        },
        { channel: makeChannel(), config: baseConfig(), credentials }
    )
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'signature_mismatch')
})

test('slack parseInbound normalizes a slash payload to a /cmd event', () => {
    const provider = new SlackChannelProvider()
    const event = provider.parseInbound(
        { headers: {}, body: slashForm() },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.equal(event.text, '/new feat x')
    assert.equal(event.providerEventId, 'slack-slash-13345.738.abc')
    assert.equal(event.chatId, 'T1:C1')
    assert.equal(event.chatType, 'group')
    assert.equal(event.senderId, 'U_USER')
    assert.equal(event.senderName, 'alice')
    assert.equal(event.isMention, true)
    assert.equal(event.commandInvocation, true)
    assert.equal(event.ackResponse, '')
    // response_url is a capability URL and must not be persisted in raw.
    assert.equal(JSON.stringify(event.raw).includes('response_url'), false)
    assert.equal(JSON.stringify(event.raw).includes('hooks.slack.com'), false)
})

test('slack parseInbound: DM slash payload is private', () => {
    const provider = new SlackChannelProvider()
    const event = provider.parseInbound(
        { headers: {}, body: slashForm({ channel_id: 'D77' }) },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.equal(event.chatType, 'private')
})

test('slack sendText routes a slash reply to response_url, then falls back', async () => {
    const provider = new SlackChannelProvider()
    const posts: Array<{ url: string; text: string }> = []
    ;(
        provider as unknown as {
            postSlashResponse: (url: string, text: string) => Promise<boolean>
        }
    ).postSlashResponse = async (url, text) => {
        posts.push({ url, text })
        return true
    }
    const calls: Array<{ method: string }> = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_token, method, params) => {
        calls.push({ method })
        return { ok: true, channel: params.channel as string, ts: '1.1' }
    }
    // Populate the pending map by parsing a slash payload.
    const event = provider.parseInbound(
        { headers: {}, body: slashForm() },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: makeCredentials()
    }
    const first = await provider.sendText(ctx, 'slack:T1:C1:U_USER', 'done', {
        interactionRef: event.providerEventId
    })
    assert.equal(first.providerMessageId, undefined)
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.text, 'done')
    assert.equal(calls.length, 0)
    // Second reply for the same (now-consumed) ref falls back to postMessage.
    await provider.sendText(ctx, 'slack:T1:C1:U_USER', 'again', {
        interactionRef: event.providerEventId
    })
    assert.equal(posts.length, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'chat.postMessage')
})

test('slack sendText falls back to postMessage when response_url POST fails', async () => {
    const provider = new SlackChannelProvider()
    ;(
        provider as unknown as {
            postSlashResponse: (url: string, text: string) => Promise<boolean>
        }
    ).postSlashResponse = async () => false
    const calls: string[] = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_token, method) => {
        calls.push(method)
        return { ok: true, ts: '1.1' }
    }
    const event = provider.parseInbound(
        { headers: {}, body: slashForm() },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        },
        'slack:T1:C1:U_USER',
        'done',
        { interactionRef: event.providerEventId }
    )
    assert.deepEqual(calls, ['chat.postMessage'])
})

test('buildSlackAppManifest carries every command + the required bot scopes', () => {
    const manifest = buildSlackAppManifest({
        name: 'My Agent',
        hooksUrl: 'https://api.example.com/api/channels/hooks/slack/chn-1'
    }) as {
        features: {
            slash_commands: Array<{ command: string; url: string }>
        }
        oauth_config: { scopes: { bot: string[] } }
        settings: {
            event_subscriptions: { request_url: string; bot_events: string[] }
            interactivity: { is_enabled: boolean }
        }
    }
    const commands = manifest.features.slash_commands
    assert.equal(commands.length, SLASH_COMMAND_SPECS.length)
    for (const c of commands) {
        assert.match(c.command, /^\/[a-z]+$/)
        assert.equal(
            c.url,
            'https://api.example.com/api/channels/hooks/slack/chn-1'
        )
    }
    assert.equal(
        manifest.settings.event_subscriptions.request_url,
        'https://api.example.com/api/channels/hooks/slack/chn-1'
    )
    const scopes = manifest.oauth_config.scopes.bot
    for (const need of [
        'chat:write',
        'commands',
        'files:read',
        'files:write',
        'mpim:history'
    ])
        assert.ok(scopes.includes(need), `missing scope ${need}`)
    assert.ok(
        manifest.settings.event_subscriptions.bot_events.includes(
            'message.mpim'
        )
    )
    assert.equal(manifest.settings.interactivity.is_enabled, false)
})

test('slack actor policy applies to a slash-normalized event (team mismatch)', () => {
    const provider = new SlackChannelProvider()
    const event = provider.parseInbound(
        { headers: {}, body: slashForm({ team_id: 'T2' }) },
        {
            channel: makeChannel(),
            config: baseConfig({ teamId: 'T1' }),
            credentials: null
        }
    )
    const policy = provider.evaluateInboundActor(
        event,
        baseConfig({ teamId: 'T1' })
    )
    assert.equal(policy.allowed, false)
    assert.equal(policy.reason, 'team_mismatch')
})

const fileShareBody = (
    files: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {}
) => ({
    type: 'event_callback',
    event_id: 'Ev-file',
    team_id: 'T1',
    event: {
        type: 'message',
        subtype: 'file_share',
        user: 'U_USER',
        channel: 'C1',
        channel_type: 'channel',
        text: '',
        ts: '1730000000.0001',
        files,
        ...overrides
    }
})

const slackFile = (overrides: Record<string, unknown> = {}) => ({
    id: 'F1',
    name: 'notes.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    url_private: 'https://files.slack.com/files-pri/T1-F1/notes.pdf',
    url_private_download:
        'https://files.slack.com/files-pri/T1-F1/download/notes.pdf',
    ...overrides
})

const parseFileEvent = (body: unknown) =>
    new SlackChannelProvider().parseInbound(
        { headers: {}, body },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )

test('slack parseInbound keeps a file_share with text and files', () => {
    const event = parseFileEvent(
        fileShareBody([slackFile()], { text: 'see attached' })
    )
    assert.equal(event.text, 'see attached')
    assert.equal(event.attachments?.length, 1)
    assert.equal(
        event.attachments?.[0]?.url,
        'https://files.slack.com/files-pri/T1-F1/download/notes.pdf'
    )
    assert.equal(event.attachments?.[0]?.contentType, 'application/pdf')
})

test('slack parseInbound keeps file-only messages, still rejects empty w/o files', () => {
    const withFile = parseFileEvent(fileShareBody([slackFile()]))
    assert.equal(withFile.text, '')
    assert.equal(withFile.attachments?.length, 1)
    assert.throws(
        () =>
            parseFileEvent({
                type: 'event_callback',
                event: {
                    type: 'message',
                    user: 'U_USER',
                    channel: 'C1',
                    text: ''
                }
            }),
        /empty_text/
    )
})

test('slack parseInbound falls back to url_private and skips tombstones/url-less', () => {
    const event = parseFileEvent(
        fileShareBody([
            slackFile({ url_private_download: undefined }),
            slackFile({ id: 'F2', mode: 'tombstone' }),
            slackFile({
                id: 'F3',
                url_private: undefined,
                url_private_download: undefined
            })
        ])
    )
    assert.equal(event.attachments?.length, 1)
    assert.equal(
        event.attachments?.[0]?.url,
        'https://files.slack.com/files-pri/T1-F1/notes.pdf'
    )
})

test('slack parseInbound drops the bot own file uploads', () => {
    // Via bot_id
    assert.throws(
        () => parseFileEvent(fileShareBody([slackFile()], { bot_id: 'B1' })),
        /bot_message/
    )
    // Via user === botUserId (external-upload file_share may lack bot_id)
    assert.throws(
        () => parseFileEvent(fileShareBody([slackFile()], { user: 'U_BOT' })),
        /self_message/
    )
})

const withSlackFilesMock = async (
    setup: (pool: ReturnType<MockAgent['get']>) => void,
    run: () => Promise<void>
): Promise<void> => {
    const previous: Dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    try {
        setup(agent.get('https://files.slack.com'))
        await run()
    } finally {
        setGlobalDispatcher(previous)
    }
}

const downloadCtx = () => ({
    channel: makeChannel(),
    config: baseConfig(),
    credentials: makeCredentials()
})

const authHeader = (headers: unknown): string | undefined => {
    if (!headers || typeof headers !== 'object') return undefined
    for (const [k, v] of Object.entries(headers as Record<string, unknown>))
        if (k.toLowerCase() === 'authorization')
            return Array.isArray(v) ? String(v[0]) : String(v)
    return undefined
}

test('slack downloadAttachment sends Bearer auth and follows a same-host redirect', async () => {
    const provider = new SlackChannelProvider()
    const seenAuth: Array<string | undefined> = []
    await withSlackFilesMock(
        (pool) => {
            pool.intercept({ path: '/a', method: 'GET' }).reply((opts) => {
                seenAuth.push(authHeader(opts.headers))
                return {
                    statusCode: 302,
                    data: '',
                    responseOptions: {
                        headers: {
                            location: 'https://files.slack.com/b'
                        }
                    }
                }
            })
            pool.intercept({ path: '/b', method: 'GET' }).reply((opts) => {
                seenAuth.push(authHeader(opts.headers))
                return {
                    statusCode: 200,
                    data: Buffer.from('filedata'),
                    responseOptions: {
                        headers: { 'content-type': 'application/pdf' }
                    }
                }
            })
        },
        async () => {
            const result = await provider.downloadAttachment(
                downloadCtx(),
                {
                    url: 'https://files.slack.com/a',
                    name: 'notes.pdf',
                    contentType: 'application/pdf',
                    size: 8
                },
                { maxBytes: 1024 }
            )
            assert.equal(result.bytes.toString(), 'filedata')
            assert.equal(result.contentType, 'application/pdf')
        }
    )
    assert.equal(seenAuth.length, 2)
    assert.ok(seenAuth[0]?.startsWith('Bearer xoxb-'))
    assert.ok(seenAuth[1]?.startsWith('Bearer xoxb-'))
})

test('slack downloadAttachment rejects a redirect to a non-slack host', async () => {
    const provider = new SlackChannelProvider()
    await withSlackFilesMock(
        (pool) =>
            pool.intercept({ path: '/a', method: 'GET' }).reply(() => ({
                statusCode: 302,
                data: '',
                responseOptions: {
                    headers: { location: 'https://evil.example.com/x' }
                }
            })),
        async () => {
            await assert.rejects(
                () =>
                    provider.downloadAttachment(
                        downloadCtx(),
                        {
                            url: 'https://files.slack.com/a',
                            name: 'x',
                            contentType: null,
                            size: null
                        },
                        { maxBytes: 1024 }
                    ),
                /host not allowed/
            )
        }
    )
})

test('slack downloadAttachment rejects non-https and non-slack urls without network', async () => {
    const provider = new SlackChannelProvider()
    for (const url of [
        'http://files.slack.com/a',
        'https://evil.example.com/a'
    ])
        await assert.rejects(
            () =>
                provider.downloadAttachment(
                    downloadCtx(),
                    { url, name: 'x', contentType: null, size: null },
                    { maxBytes: 1024 }
                ),
            /slack file url/
        )
})

test('slack downloadAttachment enforces maxBytes during read', async () => {
    const provider = new SlackChannelProvider()
    await withSlackFilesMock(
        (pool) =>
            pool
                .intercept({ path: '/big', method: 'GET' })
                .reply(200, Buffer.alloc(100), {
                    headers: { 'content-type': 'application/pdf' }
                }),
        async () => {
            await assert.rejects(
                () =>
                    provider.downloadAttachment(
                        downloadCtx(),
                        {
                            url: 'https://files.slack.com/big',
                            name: 'big.pdf',
                            contentType: 'application/pdf',
                            size: null
                        },
                        { maxBytes: 10 }
                    ),
                /exceeds/
            )
        }
    )
})

const UPLOAD_ORIGIN = 'https://files-upload.slack.com'

const withUploadMock = async (
    setup: (pool: ReturnType<MockAgent['get']>) => void,
    run: () => Promise<void>
): Promise<void> => {
    const previous: Dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    try {
        setup(agent.get(UPLOAD_ORIGIN))
        await run()
    } finally {
        setGlobalDispatcher(previous)
    }
}

const stubUploadUrls = (
    provider: SlackChannelProvider
): Array<{ method: string; params: Record<string, unknown> }> => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_token, method, params) => {
        calls.push({ method, params })
        if (method === 'files.getUploadURLExternal')
            return {
                ok: true,
                upload_url: `${UPLOAD_ORIGIN}/u/1`,
                file_id: 'F9'
            }
        return { ok: true }
    }
    return calls
}

test('slack sendAttachments runs the external-upload flow into the channel', async () => {
    const provider = new SlackChannelProvider()
    const calls = stubUploadUrls(provider)
    let uploadHit = false
    await withUploadMock(
        (pool) =>
            pool.intercept({ path: '/u/1', method: 'POST' }).reply(() => {
                uploadHit = true
                return { statusCode: 200, data: 'OK' }
            }),
        async () => {
            await provider.sendAttachments(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: makeCredentials()
                },
                'slack:T1:C9:U1',
                [
                    {
                        name: 'chart.png',
                        contentType: 'image/png',
                        bytes: Buffer.from('PNGDATA')
                    }
                ]
            )
        }
    )
    assert.equal(uploadHit, true)
    const getUrl = calls.find((c) => c.method === 'files.getUploadURLExternal')
    assert.equal(getUrl?.params.filename, 'chart.png')
    assert.equal(getUrl?.params.length, 7)
    const complete = calls.find(
        (c) => c.method === 'files.completeUploadExternal'
    )
    assert.deepEqual(complete?.params.files, [{ id: 'F9', title: 'chart.png' }])
    assert.equal(complete?.params.channel_id, 'C9')
    assert.equal(complete?.params.thread_ts, undefined)
})

test('slack sendAttachments threads uploads for a thread scope key', async () => {
    const provider = new SlackChannelProvider()
    const calls = stubUploadUrls(provider)
    await withUploadMock(
        (pool) =>
            pool.intercept({ path: '/u/1', method: 'POST' }).reply(200, 'OK'),
        async () => {
            await provider.sendAttachments(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: makeCredentials()
                },
                'slack:T1:C9:thread:1730.5',
                [
                    {
                        name: 'a.png',
                        contentType: 'image/png',
                        bytes: Buffer.from('x')
                    }
                ]
            )
        }
    )
    const complete = calls.find(
        (c) => c.method === 'files.completeUploadExternal'
    )
    assert.equal(complete?.params.thread_ts, '1730.5')
    assert.equal(complete?.params.channel_id, 'C9')
})

test('slack sendAttachments fails the batch when a byte upload fails', async () => {
    const provider = new SlackChannelProvider()
    const calls = stubUploadUrls(provider)
    await withUploadMock(
        (pool) =>
            pool.intercept({ path: '/u/1', method: 'POST' }).reply(500, 'no'),
        async () => {
            await assert.rejects(
                () =>
                    provider.sendAttachments(
                        {
                            channel: makeChannel(),
                            config: baseConfig(),
                            credentials: makeCredentials()
                        },
                        'slack:T1:C9:U1',
                        [
                            {
                                name: 'a.png',
                                contentType: 'image/png',
                                bytes: Buffer.from('x')
                            }
                        ]
                    ),
                /upload failed/
            )
        }
    )
    assert.ok(
        calls.find((c) => c.method === 'files.getUploadURLExternal'),
        'reserved an upload url'
    )
    assert.equal(
        calls.find((c) => c.method === 'files.completeUploadExternal'),
        undefined,
        'must not complete when a byte upload failed'
    )
})

test('slack validateConfig parses outboundFiles', () => {
    const provider = new SlackChannelProvider()
    assert.equal(
        provider.validateConfig({ mentionOnly: true, outboundFiles: false })
            .outboundFiles,
        false
    )
    assert.equal(
        provider.validateConfig({ mentionOnly: true }).outboundFiles,
        true
    )
})

test('slack validateConfig parses contextProjection', () => {
    const provider = new SlackChannelProvider()
    assert.equal(
        provider.validateConfig({ mentionOnly: true, contextProjection: false })
            .contextProjection,
        false
    )
    assert.equal(
        provider.validateConfig({ mentionOnly: true }).contextProjection,
        true
    )
})

const messageEvent = (event: Record<string, unknown>, teamId = 'T1') => ({
    type: 'event_callback',
    event_id: 'Ev1',
    team_id: teamId,
    event: { channel: 'C1', channel_type: 'channel', ...event }
})

const parseMsg = (body: unknown, config: SlackChannelConfig = baseConfig()) =>
    new SlackChannelProvider().parseInbound(
        { headers: {}, body },
        { channel: makeChannel(), config, credentials: null }
    )

test('slack autoThread off: a top-level group mention stays top-level', () => {
    const provider = new SlackChannelProvider()
    const event = parseMsg(
        messageEvent({
            type: 'app_mention',
            user: 'U_USER',
            text: '<@U_BOT> hi',
            ts: '1700.1'
        })
    )
    assert.equal(event.threadId, null)
    assert.equal(
        provider.computeScopeKey(event, baseConfig()).scopeKey,
        'slack:T1:C1:U_USER'
    )
})

test('slack autoThread on: a top-level group mention roots a thread at its ts', () => {
    const cfg = baseConfig({ autoThread: true })
    const provider = new SlackChannelProvider()
    const event = parseMsg(
        messageEvent({
            type: 'app_mention',
            user: 'U_USER',
            text: '<@U_BOT> hi',
            ts: '1700.1'
        }),
        cfg
    )
    assert.equal(event.threadId, '1700.1')
    assert.equal(
        provider.computeScopeKey(event, cfg).scopeKey,
        'slack:T1:C1:thread:1700.1'
    )
})

test('slack autoThread: an existing thread message keeps its own thread_ts', () => {
    const event = parseMsg(
        messageEvent({
            type: 'message',
            user: 'U_USER',
            text: '<@U_BOT> hi',
            ts: '1700.9',
            thread_ts: '1700.1'
        }),
        baseConfig({ autoThread: true })
    )
    assert.equal(event.threadId, '1700.1')
})

test('slack autoThread requires threadIsolation and skips slash text', () => {
    assert.equal(
        parseMsg(
            messageEvent({
                type: 'app_mention',
                user: 'U_USER',
                text: '<@U_BOT> hi',
                ts: '1'
            }),
            baseConfig({ autoThread: true, threadIsolation: false })
        ).threadId,
        null
    )
    assert.equal(
        parseMsg(
            messageEvent({
                type: 'message',
                user: 'U_USER',
                text: '/new',
                ts: '1'
            }),
            baseConfig({ autoThread: true, mentionOnly: false })
        ).threadId,
        null
    )
})

test('slack autoThread fires for a non-mention only when mentionOnly is off', () => {
    assert.equal(
        parseMsg(
            messageEvent({
                type: 'message',
                user: 'U_USER',
                text: 'hi',
                ts: '1'
            }),
            baseConfig({ autoThread: true, mentionOnly: true })
        ).threadId,
        null
    )
    assert.equal(
        parseMsg(
            messageEvent({
                type: 'message',
                user: 'U_USER',
                text: 'hi',
                ts: '1'
            }),
            baseConfig({ autoThread: true, mentionOnly: false })
        ).threadId,
        '1'
    )
})

test('slack DM: plain DM stays flat, a DM thread is isolated', () => {
    const provider = new SlackChannelProvider()
    const flat = parseMsg(
        messageEvent({
            type: 'message',
            user: 'U_USER',
            channel: 'D1',
            channel_type: 'im',
            text: 'hi',
            ts: '1'
        })
    )
    assert.equal(flat.threadId, null)
    assert.equal(
        provider.computeScopeKey(flat, baseConfig()).scopeKey,
        'slack:T1:D1:U_USER'
    )
    const threaded = parseMsg(
        messageEvent({
            type: 'message',
            user: 'U_USER',
            channel: 'D1',
            channel_type: 'im',
            text: 'hi',
            ts: '2',
            thread_ts: '1'
        })
    )
    assert.equal(threaded.threadId, '1')
    assert.equal(
        provider.computeScopeKey(threaded, baseConfig()).scopeKey,
        'slack:T1:D1:U_USER:thread:1'
    )
    assert.equal(
        provider.computeScopeKey(
            threaded,
            baseConfig({ threadIsolation: false })
        ).scopeKey,
        'slack:T1:D1:U_USER'
    )
})

test('slackTargetFromScopeKey resolves channel + thread across scope shapes', async () => {
    const check = async (
        scopeKey: string,
        expectChannel: string,
        expectThread: string | undefined
    ): Promise<void> => {
        const provider = new SlackChannelProvider()
        const calls: Array<Record<string, unknown>> = []
        ;(
            provider as unknown as {
                callApi: (
                    t: string,
                    m: string,
                    p: Record<string, unknown>
                ) => Promise<unknown>
            }
        ).callApi = async (_t, _m, params) => {
            calls.push(params)
            return { ok: true, ts: 'x' }
        }
        await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            scopeKey,
            'hi'
        )
        assert.equal(calls[0]?.channel, expectChannel)
        assert.equal(calls[0]?.thread_ts, expectThread)
    }
    await check('slack:T1:C1', 'C1', undefined)
    await check('slack:T1:C1:U1', 'C1', undefined)
    await check('slack:T1:C1:thread:1700.1', 'C1', '1700.1')
    await check('slack:T1:D1:U1:thread:1700.2', 'D1', '1700.2')
})

test('slack assistant_thread_started is a silent unsupported event', () => {
    const provider = new SlackChannelProvider()
    assert.throws(
        () =>
            provider.parseInbound(
                {
                    headers: {},
                    body: {
                        type: 'event_callback',
                        event: { type: 'assistant_thread_started' }
                    }
                },
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: null
                }
            ),
        (err: unknown) =>
            err instanceof Error &&
            (err as { silent?: boolean }).silent === true
    )
})

test('slack finishPreview keeps the thread on fallback and continuation', async () => {
    const provider = new SlackChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            callApi: (
                t: string,
                m: string,
                p: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_t, method, params) => {
        calls.push({ method, params })
        if (method === 'chat.update') throw new Error('update failed')
        return { ok: true, ts: 'p1' }
    }
    await provider.finishPreview(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        },
        { providerMessageId: 'p1', raw: { channel: 'C1', threadTs: '1700.1' } },
        'a'.repeat(4000)
    )
    const posts = calls.filter((c) => c.method === 'chat.postMessage')
    assert.ok(posts.length >= 2, 'expected fallback head + continuation')
    for (const p of posts) assert.equal(p.params.thread_ts, '1700.1')
})

test('slack downloadAttachment treats an unexpected html body as a failure', async () => {
    const provider = new SlackChannelProvider()
    await withSlackFilesMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, '<html>login</html>', {
                    headers: { 'content-type': 'text/html' }
                }),
        async () => {
            await assert.rejects(
                () =>
                    provider.downloadAttachment(
                        downloadCtx(),
                        {
                            url: 'https://files.slack.com/pic.png',
                            name: 'pic.png',
                            contentType: 'image/png',
                            size: null
                        },
                        { maxBytes: 1024 }
                    ),
                /html/
            )
        }
    )
})

test('slack envelope errors classify permanent kinds for the bridge', async () => {
    const provider = new SlackChannelProvider()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({ ok: false, error: 'channel_not_found' }),
            {
                status: 200
            }
        )
    try {
        await assert.rejects(
            provider.sendText(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: makeCredentials()
                },
                'slack:T1:C1',
                'hello'
            ),
            (err: unknown) => {
                assert.ok(err instanceof ChannelSendError)
                assert.equal(err.kind, 'not_found')
                return true
            }
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('slack http 429 classifies rate_limited with the Retry-After hint', async () => {
    const provider = new SlackChannelProvider()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response('too many requests', {
            status: 429,
            headers: { 'retry-after': '31' }
        })
    try {
        await assert.rejects(
            provider.sendText(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: makeCredentials()
                },
                'slack:T1:C1',
                'hello'
            ),
            (err: unknown) => {
                assert.ok(err instanceof ChannelSendError)
                assert.equal(err.kind, 'rate_limited')
                assert.equal(err.retryAfterMs, 31_000)
                return true
            }
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('slack unknown envelope errors stay plain Errors (ladder retry path)', async () => {
    const provider = new SlackChannelProvider()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ ok: false, error: 'fatal_error' }), {
            status: 200
        })
    try {
        await assert.rejects(
            provider.sendText(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: makeCredentials()
                },
                'slack:T1:C1',
                'hello'
            ),
            (err: unknown) => {
                assert.equal(err instanceof ChannelSendError, false)
                assert.match((err as Error).message, /fatal_error/)
                return true
            }
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('slack ack reactions swap eyes for a terminal emoji', async () => {
    const provider = new SlackChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_token, method, params) => {
        calls.push({ method, params })
        return { ok: true }
    }
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: makeCredentials()
    }
    await provider.setInboundReaction(
        ctx,
        'slack:T1:C1',
        '1730.0001',
        'working'
    )
    await provider.setInboundReaction(ctx, 'slack:T1:C1', '1730.0001', 'done')
    await provider.setInboundReaction(ctx, 'slack:T1:C1', '1730.0001', 'failed')

    assert.deepEqual(
        calls.map((c) => `${c.method}:${String(c.params.name)}`),
        [
            'reactions.add:eyes',
            'reactions.remove:eyes',
            'reactions.add:white_check_mark',
            'reactions.remove:eyes',
            'reactions.add:x'
        ]
    )
    assert.equal(calls[0]?.params.channel, 'C1')
    assert.equal(calls[0]?.params.timestamp, '1730.0001')
})
