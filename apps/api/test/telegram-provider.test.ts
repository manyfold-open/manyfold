import type { TelegramChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import { markdownToTelegramHtml } from '../src/modules/channels/providers/telegram-format'
import { TelegramChannelProvider } from '../src/modules/channels/providers/telegram.provider'
import { SLASH_COMMAND_SPECS } from '../src/modules/channels/slash/commands'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'telegram',
    label: 'tg test',
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

const baseConfig = (): TelegramChannelConfig => ({
    botUsername: 'NcaBot',
    mentionOnly: true,
    shareSessionInChannel: false,
    threadIsolation: true,
    progressMode: 'preview'
})

test('telegram validateConfig coerces booleans and defaults', () => {
    const provider = new TelegramChannelProvider()
    const config = provider.validateConfig({
        botUsername: '  NcaBot ',
        mentionOnly: false,
        shareSessionInChannel: true,
        progressMode: 'final'
    })
    assert.equal(config.botUsername, 'NcaBot')
    assert.equal(config.mentionOnly, false)
    assert.equal(config.shareSessionInChannel, true)
    assert.equal(config.threadIsolation, true)
    assert.equal(config.progressMode, 'final')
    assert.equal(config.outboundFiles, true)
    assert.equal(config.contextProjection, true)
    assert.equal(
        provider.validateConfig({ contextProjection: false }).contextProjection,
        false
    )
    assert.equal(
        provider.validateConfig({ outboundFiles: false }).outboundFiles,
        false
    )
})

test('telegram validateConfig trims and dedupes actor policy lists', () => {
    const provider = new TelegramChannelProvider()
    const config = provider.validateConfig({
        allowedUserIds: [' 10 ', '10', '', 20, '11'],
        operatorUserIds: [' 12 '],
        allowedChatIds: [' -1001 ', '-1001', '-1002']
    })
    assert.deepEqual(config.allowedUserIds, ['10', '11'])
    assert.deepEqual(config.operatorUserIds, ['12'])
    assert.deepEqual(config.allowedChatIds, ['-1001', '-1002'])
    assert.deepEqual(provider.validateConfig(config).allowedUserIds, [
        '10',
        '11'
    ])
})

test('telegram validateCredentials rejects malformed bot tokens', () => {
    const provider = new TelegramChannelProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.throws(
        () => provider.validateCredentials({ botToken: 'bogus' }),
        /must look like/
    )
    const ok = provider.validateCredentials({
        botToken: '12345678:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP'
    })
    assert.equal(ok?.botToken, '12345678:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP')
})

test('telegram verifySignature accepts matching X-Telegram-Bot-Api-Secret-Token', () => {
    const provider = new TelegramChannelProvider()
    const channel = makeChannel()
    const ctx = {
        channel,
        config: baseConfig(),
        credentials: {
            botToken: '12345678:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP',
            webhookSecret: 'secret-abc'
        }
    }
    const ok = provider.verifySignature(
        {
            headers: { 'x-telegram-bot-api-secret-token': 'secret-abc' },
            body: {}
        },
        ctx
    )
    assert.equal(ok.ok, true)
    const bad = provider.verifySignature(
        {
            headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
            body: {}
        },
        ctx
    )
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'signature_mismatch')
})

test('telegram parseInbound extracts text and detects bot mention', () => {
    const provider = new TelegramChannelProvider()
    const channel = makeChannel()
    const config = baseConfig()
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 42,
                message: {
                    message_id: 7,
                    from: { id: 99, username: 'alice' },
                    chat: { id: -1001, type: 'supergroup' },
                    text: '@NcaBot hello there',
                    entities: [{ type: 'mention', offset: 0, length: 7 }]
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.chatType, 'group')
    assert.equal(event.chatId, '-1001')
    assert.equal(event.senderId, '99')
    assert.equal(event.text, '@NcaBot hello there')
    assert.equal(event.isMention, true)
    assert.equal(event.messageId, '7')
    assert.equal(event.replyToMessageId, null)
})

test('telegram parseInbound records reply_to_message as replyToMessageId', () => {
    const provider = new TelegramChannelProvider()
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 43,
                message: {
                    message_id: 8,
                    from: { id: 99, username: 'alice' },
                    chat: { id: -1001, type: 'supergroup' },
                    text: 'answering you',
                    reply_to_message: { message_id: 5 }
                }
            }
        },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.equal(event.messageId, '8')
    assert.equal(event.replyToMessageId, '5')
})

const parseText = (
    provider: TelegramChannelProvider,
    text: string,
    chatType: 'private' | 'supergroup'
) =>
    provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 1,
                message: {
                    message_id: 1,
                    from: { id: 99, username: 'alice' },
                    chat: {
                        id: chatType === 'private' ? 1 : -1001,
                        type: chatType
                    },
                    text,
                    entities: [
                        { type: 'bot_command', offset: 0, length: text.length }
                    ]
                }
            }
        },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )

test('telegram parseInbound strips /cmd@bot suffix targeting this bot', () => {
    const provider = new TelegramChannelProvider()
    const event = parseText(provider, '/help@NcaBot', 'supergroup')
    assert.equal(event.text, '/help')
    assert.equal(event.isMention, true)
})

test('telegram parseInbound strips /cmd@bot suffix case-insensitively with args', () => {
    const provider = new TelegramChannelProvider()
    const event = parseText(provider, '/new@ncabot feat x', 'supergroup')
    assert.equal(event.text, '/new feat x')
})

test('telegram parseInbound leaves /cmd@otherbot untouched and unmentioned', () => {
    const provider = new TelegramChannelProvider()
    const event = parseText(provider, '/help@OtherBot', 'supergroup')
    assert.equal(event.text, '/help@OtherBot')
    assert.equal(event.isMention, false)
})

test('telegram parseInbound strips the suffix in DMs too', () => {
    const provider = new TelegramChannelProvider()
    const event = parseText(provider, '/help@NcaBot', 'private')
    assert.equal(event.text, '/help')
    assert.equal(event.isMention, true)
})

test('telegram parseInbound: private chats are always treated as mention', () => {
    const provider = new TelegramChannelProvider()
    const channel = makeChannel()
    const config = baseConfig()
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 1,
                message: {
                    message_id: 1,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    text: 'hi'
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.chatType, 'private')
    assert.equal(event.isMention, true)
})

test('telegram parseInbound keeps only the largest photo descriptor', () => {
    const provider = new TelegramChannelProvider()
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 2,
                message: {
                    message_id: 2,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    caption: 'photo',
                    photo: [
                        {
                            file_id: 'small',
                            width: 90,
                            height: 90,
                            file_size: 100
                        },
                        {
                            file_id: 'large',
                            width: 1280,
                            height: 720,
                            file_size: 2000
                        }
                    ]
                }
            }
        },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.deepEqual(event.attachments, [
        {
            url: 'telegram-file:large',
            name: 'photo-large.jpg',
            contentType: 'image/jpeg',
            size: 2000
        }
    ])
})

test('telegram parseInbound accepts attachment-only document and voice messages', () => {
    const provider = new TelegramChannelProvider()
    const document = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 3,
                message: {
                    message_id: 3,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    document: {
                        file_id: 'doc-id',
                        file_name: 'report.pdf',
                        mime_type: 'application/pdf',
                        file_size: 1234
                    }
                }
            }
        },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.equal(document.text, '')
    assert.deepEqual(document.attachments, [
        {
            url: 'telegram-file:doc-id',
            name: 'report.pdf',
            contentType: 'application/pdf',
            size: 1234
        }
    ])

    const voice = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 4,
                message: {
                    message_id: 4,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    voice: {
                        file_id: 'voice-id',
                        mime_type: 'audio/ogg',
                        file_size: 4321
                    }
                }
            }
        },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.equal(voice.attachments?.[0]?.name, 'voice-voice-id.ogg')
})

test('telegram parseInbound keeps oversized files so the bridge can report the skip', () => {
    const provider = new TelegramChannelProvider()
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 5,
                message: {
                    message_id: 5,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    text: 'too large',
                    document: {
                        file_id: 'large-doc',
                        file_name: 'large.bin',
                        file_size: 20 * 1024 * 1024 + 1
                    }
                }
            }
        },
        { channel: makeChannel(), config: baseConfig(), credentials: null }
    )
    assert.deepEqual(event.attachments, [
        {
            url: 'telegram-file:large-doc',
            name: 'large.bin',
            contentType: 'application/octet-stream',
            size: 20 * 1024 * 1024 + 1
        }
    ])
})

test('telegram attachment descriptors never persist the bot token', () => {
    const provider = new TelegramChannelProvider()
    const token = '12345678:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP'
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                message: {
                    message_id: 6,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    document: { file_id: 'safe-id', file_name: 'safe.txt' }
                }
            }
        },
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: token, webhookSecret: null }
        }
    )
    assert.equal(JSON.stringify(event).includes(token), false)
    assert.equal(event.attachments?.[0]?.url, 'telegram-file:safe-id')
})

test('telegram computeScopeKey: private DM is per-user', () => {
    const provider = new TelegramChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e',
            chatId: '1',
            chatType: 'private',
            senderId: '99',
            senderName: 'a',
            text: 'hi',
            threadId: null,
            isMention: true,
            raw: {}
        },
        baseConfig()
    )
    assert.equal(result.scopeKey, 'telegram:1:99')
})

test('telegram computeScopeKey: thread isolation collapses to thread id', () => {
    const provider = new TelegramChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e',
            chatId: '-100',
            chatType: 'group',
            senderId: '99',
            senderName: null,
            text: 'hi',
            threadId: '7',
            isMention: true,
            raw: {}
        },
        baseConfig()
    )
    assert.equal(result.scopeKey, 'telegram:-100:thread:7')
})

test('telegram computeScopeKey: shareSessionInChannel collapses to chatId', () => {
    const provider = new TelegramChannelProvider()
    const config: TelegramChannelConfig = {
        ...baseConfig(),
        shareSessionInChannel: true,
        threadIsolation: false
    }
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e',
            chatId: '-100',
            chatType: 'group',
            senderId: '99',
            senderName: null,
            text: 'hi',
            threadId: null,
            isMention: true,
            raw: {}
        },
        config
    )
    assert.equal(result.scopeKey, 'telegram:-100')
})

const actorEvent = (
    overrides: {
        senderId?: string
        chatId?: string
        chatType?: 'private' | 'group'
    } = {}
) => ({
    providerEventId: 'actor-event',
    chatId: overrides.chatId ?? '-1001',
    chatType: overrides.chatType ?? ('group' as const),
    senderId: overrides.senderId ?? '10',
    senderName: null,
    text: 'hi',
    threadId: null,
    isMention: true,
    raw: {}
})

test('telegram evaluateInboundActor allows everyone when lists are empty', () => {
    const provider = new TelegramChannelProvider()
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent(), baseConfig()),
        { allowed: true, operator: false }
    )
})

test('telegram evaluateInboundActor enforces sender allowlist', () => {
    const provider = new TelegramChannelProvider()
    const config = { ...baseConfig(), allowedUserIds: ['11'] }
    assert.deepEqual(provider.evaluateInboundActor(actorEvent(), config), {
        allowed: false,
        reason: 'sender_not_allowed',
        operator: false
    })
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent({ senderId: '11' }), config),
        { allowed: true, operator: false }
    )
})

test('telegram evaluateInboundActor gives operators chat permission', () => {
    const provider = new TelegramChannelProvider()
    const config = {
        ...baseConfig(),
        allowedUserIds: ['11'],
        operatorUserIds: ['12']
    }
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent({ senderId: '12' }), config),
        { allowed: true, operator: true }
    )
})

test('telegram evaluateInboundActor restricts group chats but not private chats', () => {
    const provider = new TelegramChannelProvider()
    const config = {
        ...baseConfig(),
        operatorUserIds: ['10'],
        allowedChatIds: ['-1002']
    }
    assert.deepEqual(provider.evaluateInboundActor(actorEvent(), config), {
        allowed: false,
        reason: 'chat_not_allowed',
        operator: true
    })
    assert.deepEqual(
        provider.evaluateInboundActor(
            actorEvent({ chatId: '10', chatType: 'private' }),
            config
        ),
        { allowed: true, operator: true }
    )
})

test('telegram sendText posts to Telegram API and returns message id', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (token, method, params) => {
        calls.push({ url: `${token}/${method}`, body: params })
        return { message_id: 555 }
    }
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: {
            botToken: '12345678:AAA',
            webhookSecret: null
        }
    }
    const result = await provider.sendText(ctx, 'telegram:42:99', 'hello world')
    assert.equal(result.providerMessageId, '555')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.body.chat_id, '42')
    assert.equal(calls[0]?.body.text, 'hello world')
    assert.equal(calls[0]?.body.parse_mode, 'HTML')
})

test('telegram markdown renderer escapes text and preserves unmatched markers', () => {
    assert.equal(
        markdownToTelegramHtml(
            '<tag> & **bold** *italic* ~~gone~~ *unfinished'
        ),
        '&lt;tag&gt; &amp; <b>bold</b> <i>italic</i> <s>gone</s> *unfinished'
    )
})

test('telegram markdown renderer supports code, links, headings, and quotes', () => {
    assert.equal(
        markdownToTelegramHtml(
            '# Title\n> **quoted**\n```ts\nconst x = "<&"\n```\nUse `x` and [docs](https://example.com?a=1&b=2).'
        ),
        '<b>Title</b>\n<blockquote><b>quoted</b></blockquote>\n<pre><code class="language-ts">const x = &quot;&lt;&amp;&quot;</code></pre>\nUse <code>x</code> and <a href="https://example.com?a=1&amp;b=2">docs</a>.'
    )
})

test('telegram sendText renders wrapped tables as preformatted HTML', async () => {
    const provider = new TelegramChannelProvider()
    const texts: string[] = []
    stubCallApi(provider, async (_token, _method, params) => {
        texts.push(String(params.text))
        return { message_id: 1 }
    })
    await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        '| Name | Value |\n| --- | --- |\n| a | <b> |'
    )
    assert.equal(
        texts[0],
        '<pre><code class="language-text">| Name | Value |\n| --- | --- |\n| a | &lt;b&gt; |</code></pre>'
    )
})

test('telegram sendText keeps rendered code blocks balanced across chunks', async () => {
    const provider = new TelegramChannelProvider()
    const texts: string[] = []
    ;(
        provider as unknown as {
            callApi: (
                token: string,
                method: string,
                params: Record<string, unknown>
            ) => Promise<unknown>
        }
    ).callApi = async (_token, _method, params) => {
        texts.push(String(params.text))
        return { message_id: texts.length }
    }
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    const code = Array.from(
        { length: 900 },
        (_, i) => `const value${i} = ${i}`
    ).join('\n')
    await provider.sendText(
        ctx,
        'telegram:42:99',
        `here is the code:\n\`\`\`ts\n${code}\n\`\`\``
    )
    assert.ok(texts.length > 1)
    assert.equal(texts[0], 'here is the code:')
    for (const text of texts.slice(1)) {
        assert.match(text, /<pre><code class="language-ts">/)
        assert.match(text, /<\/code><\/pre>/)
    }
})

test('telegram sendText retries entity parse failures as plain text', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        if (calls.length === 1)
            throw new Error(
                "telegram sendMessage failed: 400 Bad Request: can't parse entities"
            )
        return { message_id: 7 }
    })
    const result = await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        '**hello**'
    )
    assert.equal(result.providerMessageId, '7')
    assert.equal(calls[0]?.text, '<b>hello</b>')
    assert.equal(calls[0]?.parse_mode, 'HTML')
    assert.equal(calls[1]?.text, '**hello**')
    assert.equal(calls[1]?.parse_mode, undefined)
})

test('telegram sendText falls back to plain text on other markup rejections', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        if (calls.length === 1)
            throw new Error(
                'telegram sendMessage failed: 400 Bad Request: wrong HTTP URL'
            )
        return { message_id: 7 }
    })
    const result = await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        '[link](not a url)'
    )
    assert.equal(result.providerMessageId, '7')
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.parse_mode, undefined)
})

test('telegram sendText does not retry non-markup API errors', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        throw new Error(
            'telegram sendMessage failed: 400 Bad Request: chat not found'
        )
    })
    await assert.rejects(
        provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: { botToken: '12345678:AAA', webhookSecret: null }
            },
            'telegram:42:99',
            'hello'
        ),
        /chat not found/
    )
    assert.equal(calls.length, 1)
})

test('telegram updatePreview renders escaped HTML and streaming suffix', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        return true
    })
    await provider.updatePreview(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        { providerMessageId: '8', raw: { chatId: '42' } },
        '**working** <unsafe>'
    )
    assert.equal(
        calls[0]?.text,
        '<b>working</b> &lt;unsafe&gt;\n\n<i>⏳ streaming…</i>'
    )
    assert.equal(calls[0]?.parse_mode, 'HTML')
})

test('telegram sendAttachments routes images and files through multipart', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; form: FormData }> = []
    ;(
        provider as unknown as {
            callApiMultipart: (
                token: string,
                method: string,
                form: FormData
            ) => Promise<{ message_id: number }>
        }
    ).callApiMultipart = async (_token, method, form) => {
        calls.push({ method, form })
        return { message_id: calls.length }
    }
    const result = await provider.sendAttachments(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:-100:thread:77',
        [
            {
                name: 'chart.png',
                contentType: 'image/png',
                bytes: Buffer.from('image')
            },
            {
                name: 'report.pdf',
                contentType: 'application/pdf',
                bytes: Buffer.from('pdf')
            }
        ]
    )
    assert.equal(result.providerMessageId, '2')
    assert.deepEqual(
        calls.map((call) => call.method),
        ['sendPhoto', 'sendDocument']
    )
    assert.equal(calls[0]?.form.get('chat_id'), '-100')
    assert.equal(calls[0]?.form.get('message_thread_id'), '77')
    const photo = calls[0]?.form.get('photo')
    assert.ok(photo instanceof File)
    assert.equal(photo.name, 'chart.png')
    assert.equal(photo.type, 'image/png')
    const document = calls[1]?.form.get('document')
    assert.ok(document instanceof File)
    assert.equal(document.name, 'report.pdf')
})

test('telegram sendAttachments retries a rejected photo as a document', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; form: FormData }> = []
    ;(
        provider as unknown as {
            callApiMultipart: (
                token: string,
                method: string,
                form: FormData
            ) => Promise<{ message_id: number }>
        }
    ).callApiMultipart = async (_token, method, form) => {
        calls.push({ method, form })
        if (method === 'sendPhoto')
            throw new Error(
                'telegram sendPhoto failed: 400 Bad Request: PHOTO_INVALID_DIMENSIONS'
            )
        return { message_id: calls.length }
    }
    const result = await provider.sendAttachments(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        [
            {
                name: 'huge.png',
                contentType: 'image/png',
                bytes: Buffer.from('image')
            }
        ]
    )
    assert.equal(result.providerMessageId, '2')
    assert.deepEqual(
        calls.map((call) => call.method),
        ['sendPhoto', 'sendDocument']
    )
    const document = calls[1]?.form.get('document')
    assert.ok(document instanceof File)
    assert.equal(document.name, 'huge.png')
})

type CallApiStub = (
    token: string,
    method: string,
    params: Record<string, unknown>
) => Promise<unknown>

const stubCallApi = (provider: TelegramChannelProvider, fn: CallApiStub) => {
    ;(provider as unknown as { callApi: CallApiStub }).callApi = fn
}

test('telegram downloadAttachment resolves the sentinel and enforces maxBytes', async (t) => {
    const provider = new TelegramChannelProvider()
    stubCallApi(provider, async (_token, method, params) => {
        assert.equal(method, 'getFile')
        assert.equal(params.file_id, 'doc-id')
        return { file_id: 'doc-id', file_path: 'documents/file_1.txt' }
    })
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new Response('hello', {
            headers: { 'content-type': 'text/plain; charset=utf-8' }
        })
    }) as typeof fetch
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:SECRET', webhookSecret: null }
    }
    const attachment = {
        url: 'telegram-file:doc-id',
        name: 'hello.txt',
        contentType: 'application/octet-stream',
        size: 5
    }
    const file = await provider.downloadAttachment(ctx, attachment, {
        maxBytes: 5
    })
    assert.equal(file.bytes.toString(), 'hello')
    assert.equal(file.contentType, 'text/plain')
    assert.equal(urls[0]?.includes('/file/bot12345678:SECRET/'), true)
    await assert.rejects(
        provider.downloadAttachment(ctx, attachment, { maxBytes: 4 }),
        /exceeds 4 bytes/
    )
})

test('telegram register sets the webhook then the command menu', async () => {
    const provider = new TelegramChannelProvider()
    const methods: string[] = []
    let commandCount = 0
    stubCallApi(provider, async (_token, method, params) => {
        methods.push(method)
        if (method === 'getMe') return { id: 1, username: 'NcaBot' }
        if (method === 'setMyCommands') {
            commandCount = (params.commands as unknown[]).length
            return true
        }
        return {}
    })
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    const result = await provider.register(
        ctx,
        'https://api.example.com/api/channels/hooks/telegram/chn-1'
    )
    assert.equal(result.ok, true)
    assert.deepEqual(methods, ['getMe', 'setWebhook', 'setMyCommands'])
    assert.equal(commandCount, SLASH_COMMAND_SPECS.length)
})

test('telegram register survives a setMyCommands failure', async () => {
    const provider = new TelegramChannelProvider()
    stubCallApi(provider, async (_token, method) => {
        if (method === 'getMe') return { id: 1, username: 'NcaBot' }
        if (method === 'setMyCommands') throw new Error('rate limited')
        return {}
    })
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    const result = await provider.register(ctx, 'https://api.example.com/hook')
    assert.equal(result.ok, true)
    assert.match(result.message ?? '', /setMyCommands failed/)
})

test('telegram unregister clears webhook and command menu', async () => {
    const provider = new TelegramChannelProvider()
    const methods: string[] = []
    stubCallApi(provider, async (_token, method) => {
        methods.push(method)
        return {}
    })
    await provider.unregister({
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: 'x' }
    })
    assert.ok(methods.includes('deleteWebhook'))
    assert.ok(methods.includes('deleteMyCommands'))
})

test('telegram startTyping fires the chat action and stops idempotently', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    stubCallApi(provider, async (_token, method, params) => {
        calls.push({ method, params })
        return true
    })
    const stop = await provider.startTyping(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99'
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'sendChatAction')
    assert.equal(calls[0]?.params.chat_id, '42')
    assert.equal(calls[0]?.params.action, 'typing')
    assert.equal(calls[0]?.params.message_thread_id, undefined)
    stop()
    stop()
    assert.equal(calls.length, 1)
})

test('telegram startTyping downgrades to chat-level typing when the thread id is rejected', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        if (params.message_thread_id !== undefined)
            throw new Error(
                'telegram sendChatAction failed: 400 Bad Request: message thread not found'
            )
        return true
    })
    const stop = await provider.startTyping(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:-100:thread:77'
    )
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    stop()
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.message_thread_id, 77)
    assert.equal(calls[1]?.message_thread_id, undefined)
})

test('telegram startTyping anchors and clears the ack reaction when enabled', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    stubCallApi(provider, async (_token, method, params) => {
        calls.push({ method, params })
        return true
    })
    const stop = await provider.startTyping(
        {
            channel: makeChannel(),
            config: { ...baseConfig(), ackReaction: true },
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        { triggerProviderMessageId: '31' }
    )
    await new Promise((resolve) => setImmediate(resolve))
    const reactions = calls.filter((c) => c.method === 'setMessageReaction')
    assert.equal(reactions.length, 1)
    assert.deepEqual(reactions[0]?.params.reaction, [
        { type: 'emoji', emoji: '👀' }
    ])
    assert.equal(reactions[0]?.params.message_id, 31)
    stop()
    await new Promise((resolve) => setImmediate(resolve))
    const cleared = calls.filter((c) => c.method === 'setMessageReaction')
    assert.equal(cleared.length, 2)
    assert.deepEqual(cleared[1]?.params.reaction, [])
})

test('telegram parseInbound sets replyTargetId only for group messages', () => {
    const provider = new TelegramChannelProvider()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: null
    }
    const group = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 20,
                message: {
                    message_id: 555,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: -100, type: 'supergroup' },
                    text: '@NcaBot hi'
                }
            }
        },
        ctx
    )
    assert.equal(group.replyTargetId, '555')
    const dm = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 21,
                message: {
                    message_id: 556,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    text: 'hi'
                }
            }
        },
        ctx
    )
    assert.equal(dm.replyTargetId, null)
})

test('telegram sendText answers as a native reply when a target is provided', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        return { message_id: 9 }
    })
    await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:-100:thread:77',
        'hello',
        { replyToProviderMessageId: '555' }
    )
    assert.deepEqual(calls[0]?.reply_parameters, {
        message_id: 555,
        allow_sending_without_reply: true
    })
    assert.equal(calls[0]?.reply_to_message_id, undefined)
})

test('telegram sendText keeps the thread anchor without a reply target', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        return { message_id: 9 }
    })
    await provider.sendText(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:-100:thread:77',
        'hello'
    )
    assert.equal(calls[0]?.reply_to_message_id, 77)
    assert.equal(calls[0]?.reply_parameters, undefined)
})

test('telegram fetchReplyContext prefers the partial quote and labels the author', async () => {
    const provider = new TelegramChannelProvider()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: null
    }
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 22,
                message: {
                    message_id: 600,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: -100, type: 'supergroup' },
                    text: '@NcaBot what about this?',
                    quote: { text: 'the second paragraph' },
                    reply_to_message: {
                        message_id: 590,
                        from: { id: 2, username: 'colleague' },
                        chat: { id: -100, type: 'supergroup' },
                        text: 'first paragraph\nthe second paragraph'
                    }
                }
            }
        },
        ctx
    )
    const context = await provider.fetchReplyContext(ctx, event)
    assert.equal(context, '[Replying to "colleague"]: "the second paragraph"')
})

test('telegram fetchReplyContext skips replies to the bot and describes media', async () => {
    const provider = new TelegramChannelProvider()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: null
    }
    const toBot = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 23,
                message: {
                    message_id: 601,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    text: 'continue',
                    reply_to_message: {
                        message_id: 591,
                        from: { id: 99, is_bot: true, username: 'NcaBot' },
                        chat: { id: 1, type: 'private' },
                        text: 'previous answer'
                    }
                }
            }
        },
        ctx
    )
    assert.equal(await provider.fetchReplyContext(ctx, toBot), null)
    const toPhoto = provider.parseInbound(
        {
            headers: {},
            body: {
                update_id: 24,
                message: {
                    message_id: 602,
                    from: { id: 1, first_name: 'A' },
                    chat: { id: 1, type: 'private' },
                    text: 'what is this?',
                    reply_to_message: {
                        message_id: 592,
                        from: { id: 2, first_name: 'B' },
                        chat: { id: 1, type: 'private' },
                        photo: [{ file_id: 'p1', width: 10, height: 10 }]
                    }
                }
            }
        },
        ctx
    )
    assert.equal(
        await provider.fetchReplyContext(ctx, toPhoto),
        '[Replying to "B"]: "[photo]"'
    )
})

test('telegram parseInboundAction maps callback data and acks the query', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    stubCallApi(provider, async (_token, method, params) => {
        calls.push({ method, params })
        return true
    })
    const action = provider.parseInboundAction?.(
        {
            headers: {},
            body: {
                update_id: 30,
                callback_query: {
                    id: 'cbq-1',
                    from: { id: 7, username: 'presser' },
                    message: {
                        message_id: 700,
                        message_thread_id: 55,
                        chat: { id: -100, type: 'supergroup' }
                    },
                    data: 'mf|sw|chs_0123456789abcdefghijklmnop'
                }
            }
        },
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        }
    )
    assert.equal(action?.action, 'act:/switch-session')
    assert.equal(
        action?.targetChannelSessionId,
        'chs_0123456789abcdefghijklmnop'
    )
    assert.equal(action?.chatId, '-100')
    assert.equal(action?.senderId, '7')
    assert.equal(action?.threadId, '55')
    assert.equal(action?.scopeKey, null)
    assert.equal(action?.providerEventId, 'telegram-cb-cbq-1')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls[0]?.method, 'answerCallbackQuery')
    assert.equal(calls[0]?.params.callback_query_id, 'cbq-1')
})

test('telegram parseInboundAction ignores foreign callback data but still acks', async () => {
    const provider = new TelegramChannelProvider()
    const calls: string[] = []
    stubCallApi(provider, async (_token, method) => {
        calls.push(method)
        return true
    })
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    const foreign = provider.parseInboundAction?.(
        {
            headers: {},
            body: {
                callback_query: {
                    id: 'cbq-2',
                    from: { id: 7 },
                    message: {
                        message_id: 700,
                        chat: { id: -100, type: 'supergroup' }
                    },
                    data: 'other|thing'
                }
            }
        },
        ctx
    )
    assert.equal(foreign, null)
    const notCallback = provider.parseInboundAction?.(
        {
            headers: {},
            body: {
                update_id: 31,
                message: {
                    message_id: 1,
                    from: { id: 1 },
                    chat: { id: 1, type: 'private' },
                    text: 'hi'
                }
            }
        },
        ctx
    )
    assert.equal(notCallback, null)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ['answerCallbackQuery'])
})

test('telegram sendCommandView renders a session list with buttons', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        return { message_id: 42 }
    })
    const item = (index: number, id: string, isActive: boolean) => ({
        index,
        channelSessionId: id,
        chatSessionId: `chat-${id}`,
        displayName: `session ${index}`,
        chatTitle: null,
        isActive,
        archivedAt: null,
        lastActivityAt: null
    })
    const result = await provider.sendCommandView?.(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        {
            kind: 'session_list',
            text: 'Sessions:',
            items: [item(1, 'chs_a', true), item(2, 'chs_b', false)],
            page: { current: 2, total: 3 }
        }
    )
    assert.equal(result?.providerMessageId, '42')
    assert.equal(calls[0]?.parse_mode, 'HTML')
    const markup = calls[0]?.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }
    assert.equal(markup.inline_keyboard.length, 4)
    assert.equal(markup.inline_keyboard[0]?.[0]?.text, '● 1. session 1')
    assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, 'mf|sw|chs_a')
    assert.deepEqual(
        markup.inline_keyboard[2]?.map((b) => b.callback_data),
        ['mf|pg|1', 'mf|pg|3']
    )
    assert.equal(markup.inline_keyboard[3]?.[0]?.callback_data, 'mf|new')
})

test('telegram sendCommandView renders detail actions for inactive sessions', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        return { message_id: 43 }
    })
    await provider.sendCommandView?.(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:42:99',
        {
            kind: 'session_detail',
            text: 'Session detail',
            item: {
                index: 1,
                channelSessionId: 'chs_c',
                chatSessionId: 'chat-c',
                displayName: 'work',
                chatTitle: null,
                isActive: false,
                archivedAt: null,
                lastActivityAt: null
            }
        }
    )
    const markup = calls[0]?.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }
    assert.deepEqual(
        markup.inline_keyboard[0]?.map((b) => b.callback_data),
        ['mf|sw|chs_c', 'mf|del|chs_c']
    )
})

test('telegram validateConfig parses final message mode and reply hud', () => {
    const provider = new TelegramChannelProvider()
    const fresh = provider.validateConfig({
        finalMessageMode: 'fresh',
        replyHud: true
    })
    assert.equal(fresh.finalMessageMode, 'fresh')
    assert.equal(fresh.replyHud, true)
    const defaults = provider.validateConfig({})
    assert.equal(defaults.finalMessageMode, 'edit')
    assert.equal(defaults.replyHud, false)
})

test('telegram deleteMessage removes the message by scope chat id', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    stubCallApi(provider, async (_token, method, params) => {
        calls.push({ method, params })
        return true
    })
    await provider.deleteMessage?.(
        {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: { botToken: '12345678:AAA', webhookSecret: null }
        },
        'telegram:-100:thread:77',
        '901'
    )
    assert.equal(calls[0]?.method, 'deleteMessage')
    assert.equal(calls[0]?.params.chat_id, '-100')
    assert.equal(calls[0]?.params.message_id, 901)
})

test('telegram sendDirect targets chats, users, and composite replies', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<Record<string, unknown>> = []
    stubCallApi(provider, async (_token, _method, params) => {
        calls.push(params)
        return { message_id: calls.length }
    })
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    await provider.sendDirect?.(ctx, { kind: 'chat', chatId: '-100555' }, 'hi')
    assert.equal(calls[0]?.chat_id, '-100555')
    await provider.sendDirect?.(ctx, { kind: 'user', userId: '777' }, 'hi')
    assert.equal(calls[1]?.chat_id, '777')
    await provider.sendDirect?.(
        ctx,
        { kind: 'reply', messageId: '-100555:31' },
        'hi'
    )
    assert.equal(calls[2]?.chat_id, '-100555')
    assert.deepEqual(calls[2]?.reply_parameters, {
        message_id: 31,
        allow_sending_without_reply: true
    })
    await assert.rejects(
        provider.sendDirect!(ctx, { kind: 'reply', messageId: '31' }, 'hi'),
        /must be "<chatId>:<messageId>"/
    )
})

test('telegram requests honor flood-control retry_after once', async () => {
    const provider = new TelegramChannelProvider()
    let performs = 0
    const request = (
        provider as unknown as {
            requestTelegram: (
                method: string,
                perform: () => Promise<{
                    ok: boolean
                    status: number
                    text: string
                    json: Record<string, unknown> | null
                }>
            ) => Promise<unknown>
        }
    ).requestTelegram.bind(provider)
    const result = await request('sendMessage', async () => {
        performs += 1
        if (performs === 1)
            return {
                ok: false,
                status: 429,
                text: '',
                json: {
                    ok: false,
                    description: 'Too Many Requests: retry after 0',
                    parameters: { retry_after: 0 }
                }
            }
        return {
            ok: true,
            status: 200,
            text: '',
            json: { ok: true, result: { message_id: 5 } }
        }
    })
    assert.equal(performs, 2)
    assert.deepEqual(result, { message_id: 5 })
    await assert.rejects(
        request('sendMessage', async () => ({
            ok: false,
            status: 429,
            text: '',
            json: {
                ok: false,
                description: 'Too Many Requests: retry after 0',
                parameters: { retry_after: 0 }
            }
        })),
        /429 Too Many Requests/
    )
    let unrelated = 0
    await assert.rejects(
        request('sendMessage', async () => {
            unrelated += 1
            return {
                ok: false,
                status: 400,
                text: '',
                json: { ok: false, description: 'Bad Request: chat not found' }
            }
        }),
        /chat not found/
    )
    assert.equal(unrelated, 1)
})

test('telegram persistent 429 classifies rate_limited with the retry hint', async () => {
    const provider = new TelegramChannelProvider()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
        calls++
        return new Response(
            JSON.stringify({
                ok: false,
                description: 'Too Many Requests: retry after 0',
                parameters: { retry_after: 0 }
            }),
            { status: 429 }
        )
    }
    try {
        await assert.rejects(
            provider.sendText(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: {
                        botToken: '12345678:AAA',
                        webhookSecret: null
                    }
                },
                'telegram:42:99',
                'hello'
            ),
            (err: unknown) => {
                assert.ok(err instanceof ChannelSendError)
                assert.equal(err.kind, 'rate_limited')
                assert.equal(err.retryAfterMs, 0)
                return true
            }
        )
        assert.equal(calls, 2, 'one inline flood retry before surfacing')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('telegram 403 classifies forbidden so the bridge dead-letters it', async () => {
    const provider = new TelegramChannelProvider()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                ok: false,
                description: 'Forbidden: bot was blocked by the user'
            }),
            { status: 403 }
        )
    try {
        await assert.rejects(
            provider.sendText(
                {
                    channel: makeChannel(),
                    config: baseConfig(),
                    credentials: {
                        botToken: '12345678:AAA',
                        webhookSecret: null
                    }
                },
                'telegram:42:99',
                'hello'
            ),
            (err: unknown) => {
                assert.ok(err instanceof ChannelSendError)
                assert.equal(err.kind, 'forbidden')
                assert.match(err.message, /bot was blocked/)
                return true
            }
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('telegram ack reaction pins eyes while working and clears on done', async () => {
    const provider = new TelegramChannelProvider()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    stubCallApi(provider, async (_token, method, params) => {
        calls.push({ method, params })
        return {}
    })
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    await provider.setInboundReaction(ctx, 'telegram:42:99', '777', 'working')
    await provider.setInboundReaction(ctx, 'telegram:42:99', '777', 'done')

    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.method, 'setMessageReaction')
    assert.equal(calls[0]?.params.chat_id, '42')
    assert.equal(calls[0]?.params.message_id, 777)
    assert.deepEqual(calls[0]?.params.reaction, [
        { type: 'emoji', emoji: '👀' }
    ])
    assert.deepEqual(
        calls[1]?.params.reaction,
        [],
        'terminal states clear the reaction — no checkmark in the bot emoji set'
    )
})

test('telegram sendDirectAttachments posts to the target chat with reply params', async () => {
    const provider = new TelegramChannelProvider()
    const forms: Array<{ method: string; form: FormData }> = []
    ;(
        provider as unknown as {
            callApiMultipart: (
                token: string,
                method: string,
                form: FormData
            ) => Promise<unknown>
        }
    ).callApiMultipart = async (_token, method, form) => {
        forms.push({ method, form })
        return { message_id: forms.length }
    }
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: { botToken: '12345678:AAA', webhookSecret: null }
    }
    const result = await provider.sendDirectAttachments(
        ctx,
        { kind: 'reply', messageId: '42:777' },
        [
            {
                name: 'weekly.pdf',
                contentType: 'application/pdf',
                bytes: Buffer.from('pdf')
            },
            {
                name: 'chart.png',
                contentType: 'image/png',
                bytes: Buffer.from('png')
            }
        ]
    )
    assert.equal(result.providerMessageId, '2')
    assert.equal(forms[0]?.method, 'sendDocument')
    assert.equal(forms[0]?.form.get('chat_id'), '42')
    assert.match(
        String(forms[0]?.form.get('reply_parameters')),
        /"message_id":777/
    )
    assert.equal(forms[1]?.method, 'sendPhoto')
    assert.equal(
        forms[1]?.form.get('reply_parameters'),
        null,
        'only the first attachment carries the reply anchor'
    )
})
