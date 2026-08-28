import type { LarkChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { ChannelRow } from '@manyfold/db'
import { LarkChannelProvider } from '../src/modules/channels/providers/lark.provider'
import {
    UnsupportedEventError,
    type NormalizedInboundEvent,
    type SessionCardItem
} from '../src/modules/channels/channel-provider'

const makeProvider = (): LarkChannelProvider =>
    new LarkChannelProvider({
        get: () => 'https://open.feishu.cn'
    } as never)

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'lark',
    label: 'lark test',
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

test('lark validateConfig coerces defaults and trims appId', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: '  cli_abc  ',
        verificationToken: ' tok ',
        progressMode: 'final',
        shareSessionInChannel: 'truthy'
    })
    assert.equal(config.appId, 'cli_abc')
    assert.equal(config.appRegion, 'feishu')
    assert.equal(config.verificationToken, 'tok')
    assert.equal(config.progressMode, 'final')
    assert.equal(config.mentionOnly, true)
    assert.equal(config.shareSessionInChannel, false)
    assert.equal(config.contextProjection, true)
    assert.equal(
        provider.validateConfig({
            appId: 'cli_abc',
            verificationToken: 'tok',
            contextProjection: false
        }).contextProjection,
        false
    )
})

test('lark validateConfig defaults agentManagedReply off and only accepts literal true', () => {
    const provider = makeProvider()
    const base = { appId: 'cli_abc', verificationToken: 'tok' }
    assert.equal(provider.validateConfig(base).agentManagedReply, false)
    assert.equal(
        provider.validateConfig({ ...base, agentManagedReply: 'yes' })
            .agentManagedReply,
        false,
        'agentManagedReply silences Manyfold delivery — only an explicit boolean opt-in may flip it'
    )
    assert.equal(
        provider.validateConfig({ ...base, agentManagedReply: true })
            .agentManagedReply,
        true
    )
})

test('lark validateConfig accepts explicit app region', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: 'cli_abc',
        appRegion: 'lark',
        subscriptionMode: 'websocket'
    })
    assert.equal(config.appRegion, 'lark')
})

test('lark validateConfig rejects unknown app region', () => {
    const provider = makeProvider()
    assert.throws(
        () =>
            provider.validateConfig({
                appId: 'cli_abc',
                appRegion: 'mars',
                subscriptionMode: 'websocket'
            }),
        /appRegion/
    )
})

test('lark validateConfig rejects unauthenticated webhook config but allows websocket', () => {
    const provider = makeProvider()
    assert.throws(
        () => provider.validateConfig({ appId: 'cli_abc' }),
        /verificationToken or config\.encryptKey/
    )
    const config = provider.validateConfig({
        appId: 'cli_abc',
        subscriptionMode: 'websocket'
    })
    assert.equal(config.subscriptionMode, 'websocket')
})

test('lark validateConfig requires appId', () => {
    const provider = makeProvider()
    assert.throws(() => provider.validateConfig({}), /appId is required/)
})

test('lark validateCredentials enforces appSecret string', () => {
    const provider = makeProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.deepEqual(provider.validateCredentials({ appSecret: 'sec' }), {
        appSecret: 'sec'
    })
    assert.throws(
        () => provider.validateCredentials({ appSecret: '' }),
        /appSecret is required/
    )
})

test('lark websocket start waits for initial ready before returning connected', async () => {
    const provider = makeProvider()
    const statuses: string[] = []
    let started = false
    let domain: Lark.Domain | undefined
    ;(
        provider as unknown as {
            createWsClient: (params: {
                domain?: Lark.Domain
                onReady?: () => void
            }) => {
                start: () => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async () => {
            started = true
            domain = params.domain
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            appRegion: 'lark',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async () => {},
        (status) => statuses.push(status)
    )

    assert.equal(started, true)
    assert.equal(domain, Lark.Domain.Lark)
    assert.equal(handle.status, 'connected')
    assert.deepEqual(statuses, ['connected'])
    await handle.stop()
})

test('lark websocket dispatches SDK-flattened receive_v1 events', async () => {
    const provider = makeProvider()
    const received: NormalizedInboundEvent[] = []
    let dispatcher: {
        invoke: (
            data: unknown,
            params: { needCheck: false }
        ) => Promise<unknown>
    } | null = null
    ;(
        provider as unknown as {
            createWsClient: (params: { onReady?: () => void }) => {
                start: (params: {
                    eventDispatcher: NonNullable<typeof dispatcher>
                }) => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async (startParams) => {
            dispatcher = startParams.eventDispatcher
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            botName: 'NCA'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async (event) => {
            received.push(event)
        }
    )

    const capturedDispatcher = dispatcher as Lark.EventDispatcher | null
    await capturedDispatcher?.invoke(
        {
            schema: '2.0',
            header: {
                event_id: 'evt_ws_1',
                event_type: 'im.message.receive_v1'
            },
            event: {
                message: {
                    message_id: 'om_1',
                    chat_id: 'oc_group',
                    chat_type: 'group',
                    message_type: 'text',
                    content: JSON.stringify({ text: '@NCA hi' }),
                    mentions: [{ name: 'NCA', id: { open_id: 'ou_bot' } }]
                },
                sender: { sender_id: { open_id: 'ou_sender' } }
            }
        },
        { needCheck: false }
    )

    assert.equal(received.length, 1)
    assert.equal(received[0]?.providerEventId, 'evt_ws_1')
    assert.equal(received[0]?.chatId, 'oc_group')
    assert.equal(received[0]?.senderId, 'ou_sender')
    assert.equal(received[0]?.text, '@NCA hi')
    assert.equal(received[0]?.isMention, true)
    await handle.stop()
})

test('lark websocket dispatches legacy message events', async () => {
    const telemetryEvents: Array<{
        name: string
        attrs: Record<string, unknown>
    }> = []
    const provider = new LarkChannelProvider(
        { get: () => 'https://open.feishu.cn' } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                telemetryEvents.push({ name, attrs })
            }
        } as never
    )
    const received: NormalizedInboundEvent[] = []
    let dispatcher: {
        invoke: (
            data: unknown,
            params: { needCheck: false }
        ) => Promise<unknown>
    } | null = null
    ;(
        provider as unknown as {
            createWsClient: (params: { onReady?: () => void }) => {
                start: (params: {
                    eventDispatcher: NonNullable<typeof dispatcher>
                }) => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async (startParams) => {
            dispatcher = startParams.eventDispatcher
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async (event) => {
            received.push(event)
        }
    )

    const capturedDispatcher = dispatcher as Lark.EventDispatcher | null
    await capturedDispatcher?.invoke(
        {
            event: {
                type: 'message',
                open_message_id: 'om_legacy',
                open_chat_id: 'oc_legacy',
                chat_type: 'group',
                open_id: 'ou_sender',
                msg_type: 'text',
                text_without_at_bot: 'hello',
                is_mention: true
            }
        },
        { needCheck: false }
    )

    assert.equal(received.length, 1)
    assert.equal(received[0]?.providerEventId, 'om_legacy')
    assert.equal(received[0]?.chatId, 'oc_legacy')
    assert.equal(received[0]?.senderId, 'ou_sender')
    assert.equal(received[0]?.text, 'hello')
    assert.equal(received[0]?.isMention, true)
    assert.deepEqual(
        telemetryEvents,
        [
            {
                name: 'channel.lark.legacy_event',
                attrs: { source: 'ws', channelId: 'chn-1', messageType: 'text' }
            }
        ],
        'a legacy-schema hit must be observable (legacy-inventory §4.3)'
    )
    await handle.stop()
})

test('lark websocket drops unsupported and empty-text messages', async () => {
    const provider = makeProvider()
    const received: NormalizedInboundEvent[] = []
    let dispatcher: {
        invoke: (
            data: unknown,
            params: { needCheck: false }
        ) => Promise<unknown>
    } | null = null
    ;(
        provider as unknown as {
            createWsClient: (params: { onReady?: () => void }) => {
                start: (params: {
                    eventDispatcher: NonNullable<typeof dispatcher>
                }) => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async (startParams) => {
            dispatcher = startParams.eventDispatcher
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async (event) => {
            received.push(event)
        }
    )

    const capturedDispatcher = dispatcher as Lark.EventDispatcher | null
    await capturedDispatcher?.invoke(
        {
            schema: '2.0',
            header: {
                event_id: 'evt_sticker',
                event_type: 'im.message.receive_v1'
            },
            event: {
                message: {
                    message_id: 'om_sticker',
                    chat_id: 'oc_group',
                    chat_type: 'group',
                    message_type: 'sticker',
                    content: JSON.stringify({ file_key: 'stk_k' })
                },
                sender: { sender_id: { open_id: 'ou_sender' } }
            }
        },
        { needCheck: false }
    )
    await capturedDispatcher?.invoke(
        {
            schema: '2.0',
            header: {
                event_id: 'evt_blank',
                event_type: 'im.message.receive_v1'
            },
            event: {
                message: {
                    message_id: 'om_blank',
                    chat_id: 'oc_group',
                    chat_type: 'group',
                    message_type: 'text',
                    content: JSON.stringify({ text: '   ' })
                },
                sender: { sender_id: { open_id: 'ou_sender' } }
            }
        },
        { needCheck: false }
    )

    assert.equal(received.length, 0)
    await handle.stop()
})

test('lark websocket normalizes image messages into resource attachments', async () => {
    const provider = makeProvider()
    const received: NormalizedInboundEvent[] = []
    let dispatcher: {
        invoke: (
            data: unknown,
            params: { needCheck: false }
        ) => Promise<unknown>
    } | null = null
    ;(
        provider as unknown as {
            createWsClient: (params: { onReady?: () => void }) => {
                start: (params: {
                    eventDispatcher: NonNullable<typeof dispatcher>
                }) => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async (startParams) => {
            dispatcher = startParams.eventDispatcher
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async (event) => {
            received.push(event)
        }
    )

    const capturedDispatcher = dispatcher as Lark.EventDispatcher | null
    await capturedDispatcher?.invoke(
        {
            schema: '2.0',
            header: {
                event_id: 'evt_img',
                event_type: 'im.message.receive_v1'
            },
            event: {
                message: {
                    message_id: 'om_img',
                    chat_id: 'oc_group',
                    chat_type: 'group',
                    message_type: 'image',
                    content: JSON.stringify({ image_key: 'img_k' })
                },
                sender: { sender_id: { open_id: 'ou_sender' } }
            }
        },
        { needCheck: false }
    )

    assert.equal(received.length, 1)
    assert.equal(received[0]?.text, '')
    assert.deepEqual(received[0]?.attachments, [
        {
            url: 'lark-resource://om_img/img_k?type=image',
            name: 'image.png',
            contentType: 'image/png'
        }
    ])
    await handle.stop()
})

test('lark websocket drops legacy non-text messages without text', async () => {
    const provider = makeProvider()
    const received: NormalizedInboundEvent[] = []
    let dispatcher: {
        invoke: (
            data: unknown,
            params: { needCheck: false }
        ) => Promise<unknown>
    } | null = null
    ;(
        provider as unknown as {
            createWsClient: (params: { onReady?: () => void }) => {
                start: (params: {
                    eventDispatcher: NonNullable<typeof dispatcher>
                }) => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async (startParams) => {
            dispatcher = startParams.eventDispatcher
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async (event) => {
            received.push(event)
        }
    )

    const capturedDispatcher = dispatcher as Lark.EventDispatcher | null
    await capturedDispatcher?.invoke(
        {
            event: {
                type: 'message',
                open_message_id: 'om_legacy_img',
                open_chat_id: 'oc_legacy',
                chat_type: 'group',
                open_id: 'ou_sender',
                msg_type: 'image'
            }
        },
        { needCheck: false }
    )

    assert.equal(received.length, 0)
    await handle.stop()
})

test('lark parseInbound throws UnsupportedEventError for unsupported message types', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    assert.throws(
        () =>
            provider.parseInbound(
                {
                    headers: {},
                    body: {
                        header: {
                            event_id: 'evt_sticker',
                            event_type: 'im.message.receive_v1'
                        },
                        event: {
                            message: {
                                message_id: 'om_sticker',
                                chat_id: 'oc_private',
                                chat_type: 'private',
                                message_type: 'sticker',
                                content: JSON.stringify({ file_key: 'stk_k' })
                            },
                            sender: { sender_id: { open_id: 'ou_sender' } }
                        }
                    }
                },
                { channel, config, credentials: null }
            ),
        UnsupportedEventError
    )
})

const parseModernMessage = (
    provider: LarkChannelProvider,
    message: Record<string, unknown>
): NormalizedInboundEvent => {
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    return provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_parse',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_parse',
                        chat_id: 'oc_private',
                        chat_type: 'private',
                        ...message
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
}

test('lark parseInbound normalizes file messages into attachments', () => {
    const event = parseModernMessage(makeProvider(), {
        message_type: 'file',
        content: JSON.stringify({
            file_key: 'f_k',
            file_name: 'report.pdf',
            file_size: 1234
        })
    })
    assert.equal(event.text, '')
    assert.deepEqual(event.attachments, [
        {
            url: 'lark-resource://om_parse/f_k?type=file',
            name: 'report.pdf',
            contentType: null,
            size: 1234
        }
    ])
})

test('lark parseInbound extracts post rich text with title, mentions and links', () => {
    const event = parseModernMessage(makeProvider(), {
        message_type: 'post',
        content: JSON.stringify({
            title: 'Release note',
            content: [
                [
                    { tag: 'text', text: 'deploy ' },
                    { tag: 'a', text: 'the docs', href: 'https://x.dev' },
                    { tag: 'at', user_name: 'NCA' }
                ],
                [{ tag: 'text', text: 'second line' }]
            ]
        })
    })
    assert.equal(event.text, 'Release note\ndeploy the docs@NCA\nsecond line')
    assert.equal(event.attachments, undefined)
})

test('lark parseInbound accepts locale-keyed post payloads with images only', () => {
    const event = parseModernMessage(makeProvider(), {
        message_type: 'post',
        content: JSON.stringify({
            post: {
                zh_cn: {
                    title: '',
                    content: [[{ tag: 'img', image_key: 'img_post' }]]
                }
            }
        })
    })
    assert.equal(event.text, '')
    assert.deepEqual(event.attachments, [
        {
            url: 'lark-resource://om_parse/img_post?type=image',
            name: 'image.png',
            contentType: 'image/png'
        }
    ])
})

test('lark parseInbound maps audio to a voice placeholder without attachments', () => {
    const event = parseModernMessage(makeProvider(), {
        message_type: 'audio',
        content: JSON.stringify({ file_key: 'a_k', duration: 12 })
    })
    assert.equal(event.text, '[voice message]')
    assert.equal(event.attachments, undefined)
})

test('lark parseInbound maps media to video placeholder plus cover attachment', () => {
    const event = parseModernMessage(makeProvider(), {
        message_type: 'media',
        content: JSON.stringify({
            file_key: 'v_k',
            image_key: 'cover_k',
            file_name: 'demo.mp4'
        })
    })
    assert.equal(event.text, '[video: demo.mp4]')
    assert.deepEqual(event.attachments, [
        {
            url: 'lark-resource://om_parse/cover_k?type=image',
            name: 'image.png',
            contentType: 'image/png'
        }
    ])
})

test('lark websocket start fails fast when initial ready never arrives', async () => {
    const provider = new LarkChannelProvider({
        get: (key: string) => {
            if (key === 'LARK_OPEN_BASE_URL') return 'https://open.feishu.cn'
            if (key === 'LARK_WS_CONNECT_TIMEOUT_MS') return 1
            return undefined
        }
    } as never)
    const statuses: Array<{ status: string; message?: string }> = []
    let closed = false
    ;(
        provider as unknown as {
            createWsClient: () => {
                start: () => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = () => ({
        start: async () => {},
        close: () => {
            closed = true
        }
    })

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket'
        }
    })
    const config = provider.validateConfig(channel.configJson)

    await assert.rejects(
        provider.start(
            { channel, config, credentials: { appSecret: 'secret' } },
            async () => {},
            (status, detail) =>
                statuses.push({ status, message: detail?.message })
        ),
        /handshake did not complete/
    )

    assert.equal(closed, true)
    assert.deepEqual(
        statuses.map((s) => s.status),
        ['error']
    )
    assert.match(statuses[0]?.message ?? '', /long connection mode/)
    assert.match(statuses[0]?.message ?? '', /App region/)
    assert.doesNotMatch(statuses[0]?.message ?? '', /LARK_OPEN_BASE_URL/)
})

test('lark scopeKey: private DM uses chatId:senderId', () => {
    const provider = makeProvider()
    const config: LarkChannelConfig = {
        appId: 'cli_x',
        subscriptionMode: 'webhook',
        verificationToken: null,
        encryptKey: null,
        mentionOnly: true,
        shareSessionInChannel: false,
        threadIsolation: false,
        progressMode: 'preview',
        botName: null
    }
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e1',
            chatId: 'oc_1',
            chatType: 'private',
            senderId: 'ou_user_a',
            senderName: 'A',
            text: 'hi',
            threadId: null,
            isMention: false,
            raw: {}
        },
        config
    )
    assert.equal(result.scopeKey, 'feishu:oc_1:ou_user_a')
    assert.equal(result.scopeName, 'A')
})

test('lark scopeKey: group default is per-user', () => {
    const provider = makeProvider()
    const config: LarkChannelConfig = {
        appId: 'cli_x',
        subscriptionMode: 'webhook',
        verificationToken: null,
        encryptKey: null,
        mentionOnly: true,
        shareSessionInChannel: false,
        threadIsolation: false,
        progressMode: 'preview',
        botName: null
    }
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e1',
            chatId: 'oc_g',
            chatType: 'group',
            senderId: 'ou_user_b',
            senderName: 'B',
            text: 'hi',
            threadId: null,
            isMention: true,
            raw: {}
        },
        config
    )
    assert.equal(result.scopeKey, 'feishu:oc_g:ou_user_b')
})

test('lark scopeKey: global Lark app uses lark prefix', () => {
    const provider = makeProvider()
    const config: LarkChannelConfig = {
        appId: 'cli_x',
        appRegion: 'lark',
        subscriptionMode: 'webhook',
        verificationToken: null,
        encryptKey: null,
        mentionOnly: true,
        shareSessionInChannel: false,
        threadIsolation: false,
        progressMode: 'preview',
        botName: null
    }
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e1',
            chatId: 'oc_g',
            chatType: 'group',
            senderId: 'ou_user_b',
            senderName: 'B',
            text: 'hi',
            threadId: null,
            isMention: true,
            raw: {}
        },
        config
    )
    assert.equal(result.scopeKey, 'lark:oc_g:ou_user_b')
})

test('lark scopeKey: shareSessionInChannel collapses to chatId', () => {
    const provider = makeProvider()
    const config: LarkChannelConfig = {
        appId: 'cli_x',
        subscriptionMode: 'webhook',
        verificationToken: null,
        encryptKey: null,
        mentionOnly: false,
        shareSessionInChannel: true,
        threadIsolation: false,
        progressMode: 'preview',
        botName: null
    }
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e1',
            chatId: 'oc_g',
            chatType: 'group',
            senderId: 'ou_user_b',
            senderName: null,
            text: 'hi',
            threadId: null,
            isMention: false,
            raw: {}
        },
        config
    )
    assert.equal(result.scopeKey, 'feishu:oc_g')
})

test('lark scopeKey: threadIsolation uses thread id', () => {
    const provider = makeProvider()
    const config: LarkChannelConfig = {
        appId: 'cli_x',
        subscriptionMode: 'webhook',
        verificationToken: null,
        encryptKey: null,
        mentionOnly: false,
        shareSessionInChannel: false,
        threadIsolation: true,
        progressMode: 'preview',
        botName: null
    }
    const result = provider.computeScopeKey(
        {
            providerEventId: 'e1',
            chatId: 'oc_g',
            chatType: 'group',
            senderId: 'ou_user_b',
            senderName: null,
            text: 'hi',
            threadId: 'th_42',
            isMention: false,
            raw: {}
        },
        config
    )
    assert.equal(result.scopeKey, 'feishu:oc_g:thread:th_42')
})

test('lark verifySignature: url_verification returns challenge response', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            verificationToken: 'tok'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = provider.verifySignature(
        {
            headers: {},
            body: { type: 'url_verification', token: 'tok', challenge: 'XYZ' }
        },
        { channel, config, credentials: null }
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.challengeResponse, {
        status: 200,
        body: { challenge: 'XYZ' }
    })
})

test('lark verifySignature: rejects missing verification token', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', verificationToken: 'expected' }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = provider.verifySignature(
        {
            headers: {},
            body: { event: {} }
        },
        { channel, config, credentials: null }
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'verification_token_mismatch')
})

test('lark verifySignature: rejects plaintext body when only encryptKey authenticates the webhook', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', encryptKey: 'secret-key' }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = provider.verifySignature(
        {
            headers: {},
            body: { type: 'url_verification', challenge: 'plain' }
        },
        { channel, config, credentials: null }
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'encrypted_body_required')
})

test('lark verifySignature: rejects body when verification token mismatches', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', verificationToken: 'expected' }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = provider.verifySignature(
        {
            headers: {},
            body: { token: 'wrong', event: {} }
        },
        { channel, config, credentials: null }
    )
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'verification_token_mismatch')
})

test('lark verifySignature: decrypts AES-256-CBC body when encryptKey is set', () => {
    const provider = makeProvider()
    const encryptKey = 'super-secret-key'
    const plain = JSON.stringify({
        type: 'url_verification',
        challenge: 'enc-challenge'
    })
    const aesKey = createHash('sha256').update(encryptKey).digest()
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv)
    const encrypted = Buffer.concat([
        iv,
        cipher.update(Buffer.from(plain, 'utf8')),
        cipher.final()
    ]).toString('base64')

    const channel = makeChannel({
        configJson: { appId: 'cli_x', encryptKey }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = provider.verifySignature(
        {
            headers: {},
            body: { encrypt: encrypted }
        },
        { channel, config, credentials: null }
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.challengeResponse, {
        status: 200,
        body: { challenge: 'enc-challenge' }
    })
})

test('lark parseInbound does not treat arbitrary mentions as bot mentions', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            mentionOnly: true
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_1',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_1',
                        chat_id: 'oc_group',
                        chat_type: 'group',
                        message_type: 'text',
                        content: JSON.stringify({ text: '@Alice hi' }),
                        mentions: [{ name: 'Alice' }]
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.isMention, false)
})

test('lark parseInbound marks configured bot mention', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            mentionOnly: true,
            botName: 'NCA Bot'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_1',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_1',
                        chat_id: 'oc_group',
                        chat_type: 'group',
                        message_type: 'text',
                        content: JSON.stringify({ text: '@NCA Bot hi' }),
                        mentions: [{ name: 'NCA Bot' }]
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.isMention, true)
})

test('lark mention matches botOpenId even when botName drifted', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            mentionOnly: true,
            botName: '@feishu01',
            botOpenId: 'ou_bot_self'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_1',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_1',
                        chat_id: 'oc_group',
                        chat_type: 'group',
                        message_type: 'text',
                        content: JSON.stringify({ text: '@_user_1 hi' }),
                        mentions: [
                            {
                                key: '@_user_1',
                                name: 'feishu01',
                                id: { open_id: 'ou_bot_self' }
                            }
                        ]
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.isMention, true)
})

test('lark mention with matching name but foreign open_id is not the bot', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            mentionOnly: true,
            botName: 'NCA Bot',
            botOpenId: 'ou_bot_self'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_1',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_1',
                        chat_id: 'oc_group',
                        chat_type: 'group',
                        message_type: 'text',
                        content: JSON.stringify({ text: '@_user_1 hi' }),
                        mentions: [
                            {
                                key: '@_user_1',
                                name: 'NCA Bot',
                                id: { open_id: 'ou_other_bot' }
                            }
                        ]
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.isMention, false)
})

test('lark validateConfig preserves botOpenId across config edits', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: 'cli_x',
        verificationToken: 'tok',
        botName: 'NCA Bot',
        botOpenId: ' ou_bot_self '
    })
    assert.equal(config.botOpenId, 'ou_bot_self')
    assert.equal(
        provider.validateConfig({
            appId: 'cli_x',
            verificationToken: 'tok',
            botName: 'NCA Bot'
        }).botOpenId,
        null
    )
})

test('lark register captures botOpenId into configPatch', async () => {
    const provider = makeProvider()
    ;(
        provider as unknown as {
            fetchBotInfo: () => Promise<{
                openId: string
                appName: string | null
                activated: boolean
            }>
        }
    ).fetchBotInfo = async () => ({
        openId: 'ou_bot_self',
        appName: 'feishu01',
        activated: true
    })
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            botName: '@feishu01'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = await provider.register({
        channel,
        config,
        credentials: { appSecret: 'secret' }
    })
    assert.equal(result.ok, true)
    const patched = result.configPatch as LarkChannelConfig | undefined
    assert.equal(patched?.botOpenId, 'ou_bot_self')
    assert.equal(patched?.botName, '@feishu01')
})

test('lark register failure reports error without configPatch', async () => {
    const provider = makeProvider()
    ;(
        provider as unknown as { fetchBotInfo: () => Promise<never> }
    ).fetchBotInfo = async () => {
        throw new Error('lark api code=99991663 msg=app not enabled')
    }
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            botName: 'NCA Bot'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = await provider.register({
        channel,
        config,
        credentials: { appSecret: 'secret' }
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /99991663/)
    assert.equal(result.configPatch, undefined)
})

test('lark sendText replies in thread for threaded scope keys', async () => {
    const provider = makeProvider()
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        const parsedBody =
            typeof init.body === 'string'
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : {}
        calls.push({ url, body: parsedBody })
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        return { data: { message_id: 'om_reply' } }
    }

    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            threadIsolation: true
        }
    })
    const config = provider.validateConfig(channel.configJson)
    const result = await provider.sendText(
        {
            channel,
            config,
            credentials: { appSecret: 'secret' }
        },
        'feishu:oc_group:thread:om_root',
        'hello'
    )

    assert.equal(result.providerMessageId, 'om_reply')
    assert.equal(calls.length, 2)
    assert.match(
        calls[1]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\/om_root\/reply$/
    )
    assert.equal(calls[1]?.body.reply_in_thread, true)
    assert.equal(calls[1]?.body.msg_type, 'text')
})

test('lark parseInbound fills messageId, replyToMessageId and group replyTargetId', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_1',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_msg',
                        chat_id: 'oc_group',
                        chat_type: 'group',
                        message_type: 'text',
                        parent_id: 'om_parent',
                        content: JSON.stringify({ text: 'hi' })
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.messageId, 'om_msg')
    assert.equal(event.replyToMessageId, 'om_parent')
    assert.equal(event.replyTargetId, 'om_msg')
})

test('lark parseInbound leaves replyTargetId null in private chats', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_1',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_msg',
                        chat_id: 'oc_dm',
                        chat_type: 'p2p',
                        message_type: 'text',
                        content: JSON.stringify({ text: 'hi' })
                    },
                    sender: { sender_id: { open_id: 'ou_sender' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.messageId, 'om_msg')
    assert.equal(event.replyToMessageId, null)
    assert.equal(event.replyTargetId, null)
})

test('lark legacy events fill messageId, replyToMessageId and group replyTargetId', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const event = provider.parseInbound(
        {
            headers: {},
            body: {
                event_id: 'evt_leg',
                event: {
                    type: 'message',
                    open_chat_id: 'oc_group',
                    open_id: 'ou_sender',
                    chat_type: 'group',
                    msg_type: 'text',
                    text: 'hi',
                    open_message_id: 'om_leg',
                    parent_id: 'om_parent'
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(event.messageId, 'om_leg')
    assert.equal(event.replyToMessageId, 'om_parent')
    assert.equal(event.replyTargetId, 'om_leg')
})

const captureFetchJson = (
    provider: LarkChannelProvider
): Array<{ url: string; body: Record<string, unknown> }> => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        const parsedBody =
            typeof init.body === 'string'
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : {}
        calls.push({ url, body: parsedBody })
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        return { data: { message_id: `om_out_${calls.length}` } }
    }
    return calls
}

test('lark sendText native-replies the first chunk when replyToProviderMessageId is set', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)

    const longText = 'x'.repeat(4500)
    const result = await provider.sendText(
        { channel, config, credentials: { appSecret: 'secret' } },
        'feishu:oc_group:ou_user',
        longText,
        { replyToProviderMessageId: 'om_asker' }
    )

    assert.ok(result.providerMessageId)
    assert.equal(calls.length, 3)
    assert.match(
        calls[1]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\/om_asker\/reply$/
    )
    assert.equal(calls[1]?.body.reply_in_thread, undefined)
    assert.match(
        calls[2]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\?receive_id_type=chat_id$/
    )
    assert.equal(calls[2]?.body.receive_id, 'oc_group')
})

test('lark sendText reply target wins over thread routing and stays in-thread', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            threadIsolation: true
        }
    })
    const config = provider.validateConfig(channel.configJson)

    await provider.sendText(
        { channel, config, credentials: { appSecret: 'secret' } },
        'feishu:oc_group:thread:om_root',
        'hello',
        { replyToProviderMessageId: 'om_asker' }
    )

    assert.equal(calls.length, 2)
    assert.match(
        calls[1]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\/om_asker\/reply$/
    )
    assert.equal(calls[1]?.body.reply_in_thread, true)
})

test('lark strict validateConfig rejects mention gating without botName', () => {
    const provider = makeProvider()
    assert.throws(
        () =>
            provider.validateConfig(
                { appId: 'cli_x', subscriptionMode: 'websocket' },
                { strict: true }
            ),
        /botName/
    )
})

test('lark strict validateConfig passes with botName or mentionOnly disabled', () => {
    const provider = makeProvider()
    const withBotName = provider.validateConfig(
        { appId: 'cli_x', subscriptionMode: 'websocket', botName: 'NCA Bot' },
        { strict: true }
    )
    assert.equal(withBotName.botName, 'NCA Bot')
    const withoutGate = provider.validateConfig(
        { appId: 'cli_x', subscriptionMode: 'websocket', mentionOnly: false },
        { strict: true }
    )
    assert.equal(withoutGate.mentionOnly, false)
    const withBotOpenId = provider.validateConfig(
        {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            botOpenId: 'ou_bot_self'
        },
        { strict: true }
    )
    assert.equal(withBotOpenId.botOpenId, 'ou_bot_self')
    const lenient = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket'
    })
    assert.equal(lenient.botName, null)
})

test('lark sendDirect routes chat, user and reply targets to the right APIs', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const ctx = { channel, config, credentials: { appSecret: 'secret' } }

    const chat = await provider.sendDirect(
        ctx,
        { kind: 'chat', chatId: 'oc_group' },
        'hello'
    )
    assert.ok(chat.providerMessageId)
    assert.match(
        calls[1]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\?receive_id_type=chat_id$/
    )
    assert.equal(calls[1]?.body.receive_id, 'oc_group')

    await provider.sendDirect(ctx, { kind: 'user', userId: 'ou_member' }, 'hi')
    assert.match(
        calls[2]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\?receive_id_type=open_id$/
    )
    assert.equal(calls[2]?.body.receive_id, 'ou_member')

    await provider.sendDirect(
        ctx,
        { kind: 'reply', messageId: 'om_q' },
        'answer'
    )
    assert.match(
        calls[3]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\/om_q\/reply$/
    )
    assert.equal(calls[3]?.body.reply_in_thread, undefined)
    assert.equal(calls[3]?.body.msg_type, 'text')
})

test('lark downloadAttachment fetches resource with bearer and caps bytes', async () => {
    const provider = makeProvider()
    captureFetchJson(provider)
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const ctx = { channel, config, credentials: { appSecret: 'secret' } }
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => {
        requests.push({
            url: String(input),
            auth:
                (init?.headers as Record<string, string> | undefined)
                    ?.Authorization ?? null
        })
        return new Response(Buffer.from('png-bytes'), {
            status: 200,
            headers: { 'content-type': 'image/png' }
        })
    }) as typeof fetch
    try {
        const file = await provider.downloadAttachment(
            ctx,
            {
                url: 'lark-resource://om_img/img_k?type=image',
                name: 'image.png',
                contentType: 'image/png'
            },
            { maxBytes: 1024 }
        )
        assert.equal(file.contentType, 'image/png')
        assert.equal(file.bytes.toString('utf8'), 'png-bytes')
        assert.match(
            requests[0]?.url ?? '',
            /\/open-apis\/im\/v1\/messages\/om_img\/resources\/img_k\?type=image$/
        )
        assert.equal(requests[0]?.auth, 'Bearer tenant-token')

        await assert.rejects(
            provider.downloadAttachment(
                ctx,
                {
                    url: 'lark-resource://om_img/img_k?type=image',
                    name: 'image.png',
                    contentType: 'image/png'
                },
                { maxBytes: 4 }
            ),
            /exceeds 4 bytes/
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('lark downloadAttachment rejects non lark-resource urls', async () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    await assert.rejects(
        provider.downloadAttachment(
            { channel, config, credentials: { appSecret: 'secret' } },
            {
                url: 'https://evil.example.com/file',
                name: 'file',
                contentType: null
            },
            { maxBytes: 1024 }
        ),
        /not a lark-resource url/
    )
})

const backfillEvent = (
    overrides: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent =>
    ({
        providerEventId: 'evt_bf',
        chatId: 'oc_group',
        chatType: 'group',
        senderId: 'ou_sender',
        senderName: null,
        text: 'summarize the discussion',
        threadId: null,
        isMention: true,
        messageId: 'om_trigger',
        raw: {},
        ...overrides
    }) as NormalizedInboundEvent

const historyItem = (
    id: string,
    senderId: string,
    text: string,
    senderType = 'user'
): Record<string, unknown> => ({
    message_id: id,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: { id: senderId, sender_type: senderType }
})

const historyListFetch = (
    provider: LarkChannelProvider,
    items: Array<Record<string, unknown>>
): Array<string> => {
    const urls: string[] = []
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url) => {
        urls.push(url)
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (url.includes('/open-apis/im/v1/messages?container_id_type='))
            return { data: { items } }
        if (url.includes('/open-apis/contact/v3/users/'))
            throw new Error('lark api code=99991403 msg=no scope')
        return {}
    }
    return urls
}

test('lark fetchHistoryContext lists the chat container and stops at own conversational reply', async () => {
    const provider = makeProvider()
    const urls = historyListFetch(provider, [
        historyItem('om_trigger', 'ou_sender', 'summarize the discussion'),
        historyItem('om_3', 'ou_b', 'third message'),
        historyItem('om_2', 'cli_x', 'my earlier reply', 'app'),
        historyItem('om_1', 'ou_a', 'first message')
    ])
    const ctx = larkCtxForSend(provider)
    const block = await provider.fetchHistoryContext(ctx, backfillEvent(), {
        scopeKey: 'feishu:oc_group:ou_sender',
        limit: 50
    })
    assert.ok(block)
    assert.match(block?.text ?? '', /\[Recent channel messages\]/)
    assert.match(block?.text ?? '', /\[ou_b\] third message/)
    assert.doesNotMatch(block?.text ?? '', /first message/)
    assert.doesNotMatch(block?.text ?? '', /summarize the discussion/)
    const listUrl = urls.find((u) => u.includes('container_id_type='))
    assert.match(
        listUrl ?? '',
        /container_id_type=chat&container_id=oc_group.*sort_type=ByCreateTimeDesc/
    )
})

test('lark fetchHistoryContext skips own housekeeping messages without breaking', async () => {
    const provider = makeProvider()
    ;(
        provider as unknown as {
            recordNonConversational: (c: string, m: string) => void
        }
    ).recordNonConversational('chn-1', 'om_notice')
    historyListFetch(provider, [
        historyItem('om_4', 'ou_b', 'after the notice'),
        historyItem('om_notice', 'cli_x', 'queued #2', 'app'),
        historyItem('om_2', 'cli_x', 'real reply', 'app'),
        historyItem('om_1', 'ou_a', 'before the reply')
    ])
    const ctx = larkCtxForSend(provider)
    const block = await provider.fetchHistoryContext(ctx, backfillEvent(), {
        scopeKey: 'feishu:oc_group:ou_sender',
        limit: 50
    })
    assert.match(block?.text ?? '', /after the notice/)
    assert.doesNotMatch(block?.text ?? '', /queued #2/)
    assert.doesNotMatch(block?.text ?? '', /before the reply/)
})

test('lark fetchHistoryContext uses the thread container for real thread messages', async () => {
    const provider = makeProvider()
    const urls = historyListFetch(provider, [
        historyItem('om_t1', 'ou_a', 'thread starter')
    ])
    const ctx = larkCtxForSend(provider)
    const block = await provider.fetchHistoryContext(
        ctx,
        backfillEvent({
            raw: { event: { message: { thread_id: 'omt_9' } } }
        }),
        { scopeKey: 'feishu:oc_group:ou_sender', limit: 50 }
    )
    assert.ok(block)
    const listUrl = urls.find((u) => u.includes('container_id_type='))
    assert.match(listUrl ?? '', /container_id_type=thread&container_id=omt_9/)
})

test('lark fetchHistoryContext returns null when empty and fails open on errors', async () => {
    const provider = makeProvider()
    historyListFetch(provider, [])
    const ctx = larkCtxForSend(provider)
    assert.equal(
        await provider.fetchHistoryContext(ctx, backfillEvent(), {
            scopeKey: 'feishu:oc_group:ou_sender',
            limit: 50
        }),
        null
    )
    ;(
        provider as unknown as {
            fetchJson: () => Promise<Record<string, unknown>>
        }
    ).fetchJson = async () => {
        throw new Error('lark api 403 forbidden')
    }
    assert.equal(
        await provider.fetchHistoryContext(ctx, backfillEvent(), {
            scopeKey: 'feishu:oc_group:ou_sender',
            limit: 50
        }),
        null
    )
})

test('lark fetchHistoryContext caps the total block size', async () => {
    const provider = makeProvider()
    const long = 'y'.repeat(500)
    historyListFetch(
        provider,
        Array.from({ length: 15 }, (_, i) =>
            historyItem(`om_${i}`, 'ou_a', `${i} ${long}`)
        )
    )
    const ctx = larkCtxForSend(provider)
    const block = await provider.fetchHistoryContext(ctx, backfillEvent(), {
        scopeKey: 'feishu:oc_group:ou_sender',
        limit: 50
    })
    assert.ok(block)
    assert.ok((block?.text.length ?? 0) <= 6200)
})

test('lark finishPreview promotes the preview out of the housekeeping set', async () => {
    const provider = makeProvider()
    captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    const handle = await provider.sendPreviewStart(
        ctx,
        'feishu:oc_group:ou_sender'
    )
    const sets = (
        provider as unknown as {
            nonConversationalIds: Map<string, Set<string>>
        }
    ).nonConversationalIds
    assert.equal(sets.get('chn-1')?.has(handle.providerMessageId), true)
    await provider.finishPreview(ctx, handle, 'final')
    assert.equal(sets.get('chn-1')?.has(handle.providerMessageId), false)
})

test('lark validateConfig parses history backfill fields', () => {
    const provider = makeProvider()
    const defaulted = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket'
    })
    assert.equal(defaulted.historyBackfill, true)
    assert.equal(defaulted.historyBackfillLimit, 50)
    const custom = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        historyBackfill: false,
        historyBackfillLimit: 250
    })
    assert.equal(custom.historyBackfill, false)
    assert.equal(custom.historyBackfillLimit, 100)
})

const cardkitFetch = (
    provider: LarkChannelProvider,
    opts: { failCreate?: boolean; failUpdateAfter?: number } = {}
): Array<{ url: string; method: string; body: Record<string, unknown> }> => {
    const calls: Array<{
        url: string
        method: string
        body: Record<string, unknown>
    }> = []
    let updates = 0
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        const body =
            typeof init.body === 'string'
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : {}
        calls.push({ url, method: init.method ?? 'GET', body })
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (url.endsWith('/open-apis/cardkit/v1/cards')) {
            if (opts.failCreate)
                throw new Error('lark api code=999 msg=cardkit unavailable')
            return { data: { card_id: 'ck_1' } }
        }
        if (url.includes('/elements/md_1/content')) {
            updates += 1
            if (
                opts.failUpdateAfter !== undefined &&
                updates > opts.failUpdateAfter
            )
                throw new Error('lark api code=300 msg=stale sequence')
            return {}
        }
        return { data: { message_id: `om_prev_${calls.length}` } }
    }
    return calls
}

const cardkitCtx = (provider: LarkChannelProvider) => {
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            streaming: 'cardkit'
        }
    })
    return {
        channel,
        config: provider.validateConfig(channel.configJson),
        credentials: { appSecret: 'secret' }
    }
}

test('lark cardkit preview creates an entity and streams with increasing sequence', async () => {
    const provider = makeProvider()
    const calls = cardkitFetch(provider)
    const ctx = cardkitCtx(provider)
    const handle = await provider.sendPreviewStart(
        ctx,
        'feishu:oc_group:ou_sender'
    )
    assert.ok(handle.providerMessageId)
    const create = calls.find((c) =>
        c.url.endsWith('/open-apis/cardkit/v1/cards')
    )
    assert.ok(create)
    const send = calls.find((c) => String(c.body.msg_type) === 'interactive')
    assert.equal(
        send?.body.content,
        JSON.stringify({ type: 'card', data: { card_id: 'ck_1' } })
    )
    await provider.updatePreview(ctx, handle, 'partial one')
    await provider.updatePreview(ctx, handle, 'partial two')
    await provider.finishPreview(ctx, handle, 'final text')
    const updates = calls.filter((c) =>
        c.url.includes('/elements/md_1/content')
    )
    assert.equal(updates.length, 3)
    assert.deepEqual(
        updates.map((c) => c.body.sequence),
        [2, 3, 4]
    )
    const close = calls.find((c) => c.url.includes('/settings'))
    assert.equal(close?.method, 'PATCH')
    assert.match(String(close?.body.settings), /"streaming_mode":false/)
})

test('lark cardkit create failure falls back to patch previews', async () => {
    const provider = makeProvider()
    const calls = cardkitFetch(provider, { failCreate: true })
    const ctx = cardkitCtx(provider)
    const handle = await provider.sendPreviewStart(
        ctx,
        'feishu:oc_group:ou_sender'
    )
    assert.ok(handle.providerMessageId)
    assert.deepEqual(handle.raw, { mode: 'patch' })
    await provider.updatePreview(ctx, handle, 'partial')
    const patch = calls.find((c) => c.method === 'PATCH')
    assert.ok(patch, 'expected message PATCH fallback')
    assert.match(patch?.url ?? '', /\/open-apis\/im\/v1\/messages\//)
})

test('lark cardkit mid-stream failure degrades and finish repairs via patch', async () => {
    const provider = makeProvider()
    const calls = cardkitFetch(provider, { failUpdateAfter: 1 })
    const ctx = cardkitCtx(provider)
    const handle = await provider.sendPreviewStart(
        ctx,
        'feishu:oc_group:ou_sender'
    )
    await provider.updatePreview(ctx, handle, 'ok frame')
    await provider.updatePreview(ctx, handle, 'stale frame')
    await provider.updatePreview(ctx, handle, 'skipped frame')
    const updatesBeforeFinish = calls.filter((c) =>
        c.url.includes('/elements/md_1/content')
    ).length
    assert.equal(updatesBeforeFinish, 2)
    await provider.finishPreview(ctx, handle, 'final text')
    const patch = calls.find(
        (c) =>
            c.method === 'PATCH' &&
            /\/open-apis\/im\/v1\/messages\//.test(c.url)
    )
    assert.ok(patch, 'finish should repair the message via patchCard')
})

test('lark validateConfig parses streaming with patch default', () => {
    const provider = makeProvider()
    const defaulted = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket'
    })
    assert.equal(defaulted.streaming, 'patch')
    const cardkit = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        streaming: 'cardkit'
    })
    assert.equal(cardkit.streaming, 'cardkit')
})

const replyEvent = (replyToMessageId: string): NormalizedInboundEvent =>
    ({
        providerEventId: 'evt_reply',
        chatId: 'oc_group',
        chatType: 'group',
        senderId: 'ou_sender',
        senderName: null,
        text: 'what did this say?',
        threadId: null,
        isMention: true,
        replyToMessageId,
        raw: {}
    }) as NormalizedInboundEvent

const messageLookupFetch = (
    provider: LarkChannelProvider,
    item: Record<string, unknown> | null
): { count: () => number } => {
    let lookups = 0
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url) => {
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (/\/open-apis\/im\/v1\/messages\/[^/?]+$/.test(url)) {
            lookups += 1
            if (!item) throw new Error('lark api code=230011 msg=withdrawn')
            return { data: { items: [item] } }
        }
        return {}
    }
    return { count: () => lookups }
}

test('lark fetchReplyContext renders a truncated quote line and caches it', async () => {
    const provider = makeProvider()
    const lookups = messageLookupFetch(provider, {
        msg_type: 'text',
        body: { content: JSON.stringify({ text: `long ${'x'.repeat(600)}` }) },
        sender: { id: 'ou_author', sender_type: 'user' }
    })
    const ctx = larkCtxForSend(provider)
    const first = await provider.fetchReplyContext(ctx, replyEvent('om_q'))
    assert.ok(first?.startsWith('[Replying to "ou_author"]: "long '))
    assert.ok((first?.length ?? 0) <= 540)
    const second = await provider.fetchReplyContext(ctx, replyEvent('om_q'))
    assert.equal(second, first)
    assert.equal(lookups.count(), 1)
})

test('lark fetchReplyContext returns null for withdrawn messages without throwing', async () => {
    const provider = makeProvider()
    messageLookupFetch(provider, null)
    const ctx = larkCtxForSend(provider)
    const result = await provider.fetchReplyContext(ctx, replyEvent('om_gone'))
    assert.equal(result, null)
})

const contactLookupFetch = (
    provider: LarkChannelProvider,
    name: string | null
): { count: () => number } => {
    let lookups = 0
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url) => {
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (url.includes('/open-apis/contact/v3/users/')) {
            lookups += 1
            if (!name) throw new Error('lark api code=99991403 msg=no scope')
            return { data: { user: { name } } }
        }
        return {}
    }
    return { count: () => lookups }
}

test('lark resolveSenderName resolves and caches contact names', async () => {
    const provider = makeProvider()
    const lookups = contactLookupFetch(provider, 'Alice')
    const ctx = larkCtxForSend(provider)
    const first = await provider.resolveSenderName(ctx, actorEvent('ou_alice'))
    assert.equal(first, 'Alice')
    const second = await provider.resolveSenderName(ctx, actorEvent('ou_alice'))
    assert.equal(second, 'Alice')
    assert.equal(lookups.count(), 1)
})

test('lark resolveSenderName caches misses and skips non-open_id senders', async () => {
    const provider = makeProvider()
    const lookups = contactLookupFetch(provider, null)
    const ctx = larkCtxForSend(provider)
    assert.equal(
        await provider.resolveSenderName(ctx, actorEvent('ou_denied')),
        null
    )
    assert.equal(
        await provider.resolveSenderName(ctx, actorEvent('ou_denied')),
        null
    )
    assert.equal(lookups.count(), 1)
    assert.equal(
        await provider.resolveSenderName(ctx, actorEvent('legacy_id')),
        null
    )
    assert.equal(lookups.count(), 1)
})

test('lark fetchReplyContext renders placeholders for media replies', async () => {
    const provider = makeProvider()
    messageLookupFetch(provider, {
        msg_type: 'image',
        body: { content: JSON.stringify({ image_key: 'k' }) },
        sender: { id: 'ou_author' }
    })
    const ctx = larkCtxForSend(provider)
    const result = await provider.fetchReplyContext(ctx, replyEvent('om_img'))
    assert.equal(result, '[Replying to "ou_author"]: "[image]"')
})

test('lark startTyping adds a Typing reaction and stop removes it', async () => {
    const provider = makeProvider()
    const calls: Array<{ url: string; method: string }> = []
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        calls.push({ url, method: init.method ?? 'GET' })
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (init.method === 'POST') return { data: { reaction_id: 'r_1' } }
        return {}
    }
    const ctx = larkCtxForSend(provider)
    const stop = await provider.startTyping(ctx, 'feishu:oc_group:ou_sender', {
        triggerProviderMessageId: 'om_trigger'
    })
    assert.match(
        calls[1]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\/om_trigger\/reactions$/
    )
    stop()
    stop()
    await new Promise((resolve) => setImmediate(resolve))
    const deletes = calls.filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.match(deletes[0]?.url ?? '', /\/om_trigger\/reactions\/r_1$/)
})

test('lark startTyping is a noop without a trigger message id', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    const stop = await provider.startTyping(ctx, 'feishu:oc_group:ou_sender')
    stop()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 0)
})

test('lark startTyping disables reactions for a while after rate-limit codes', async () => {
    const provider = makeProvider()
    let posts = 0
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (init.method === 'POST') {
            posts += 1
            throw new Error('lark api code=99991400 msg=rate limited')
        }
        return {}
    }
    const ctx = larkCtxForSend(provider)
    const first = await provider.startTyping(ctx, 'feishu:oc_group:ou_sender', {
        triggerProviderMessageId: 'om_a'
    })
    first()
    assert.equal(posts, 1)
    const second = await provider.startTyping(
        ctx,
        'feishu:oc_group:ou_sender',
        { triggerProviderMessageId: 'om_b' }
    )
    second()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(posts, 1)
})

const cardActionBody = (value: Record<string, unknown>) => ({
    schema: '2.0',
    header: {
        event_id: 'evt_card_1',
        event_type: 'card.action.trigger',
        token: 'tok'
    },
    event: {
        operator: { open_id: 'ou_presser' },
        action: { tag: 'button', value },
        context: { open_chat_id: 'oc_group', open_message_id: 'om_card' }
    }
})

test('lark parseInboundAction normalizes card.action.trigger callbacks', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', verificationToken: 'tok' }
    })
    const config = provider.validateConfig(channel.configJson)
    const action = provider.parseInboundAction(
        {
            headers: {},
            body: cardActionBody({
                a: 'act:/switch-session',
                s: 'cs_2',
                k: 'feishu:oc_group:ou_presser'
            })
        },
        { channel, config, credentials: null }
    )
    assert.ok(action)
    assert.equal(action?.providerEventId, 'evt_card_1')
    assert.equal(action?.chatId, 'oc_group')
    assert.equal(action?.chatType, 'group')
    assert.equal(action?.senderId, 'ou_presser')
    assert.equal(action?.action, 'act:/switch-session')
    assert.equal(action?.targetChannelSessionId, 'cs_2')
    assert.equal(action?.targetPage, null)
    assert.equal(action?.scopeKey, 'feishu:oc_group:ou_presser')
})

test('lark parseInboundAction decodes encrypted card callbacks and thread scopes', () => {
    const provider = makeProvider()
    const encryptKey = 'card-secret'
    const plain = JSON.stringify(
        cardActionBody({
            a: 'nav:/list-page',
            p: 2,
            k: 'feishu:oc_group:thread:om_root'
        })
    )
    const aesKey = createHash('sha256').update(encryptKey).digest()
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv)
    const encrypted = Buffer.concat([
        iv,
        cipher.update(Buffer.from(plain, 'utf8')),
        cipher.final()
    ]).toString('base64')
    const channel = makeChannel({ configJson: { appId: 'cli_x', encryptKey } })
    const config = provider.validateConfig(channel.configJson)
    const action = provider.parseInboundAction(
        {
            headers: {},
            body: { encrypt: encrypted }
        },
        { channel, config, credentials: null }
    )
    assert.ok(action)
    assert.equal(action?.action, 'nav:/list-page')
    assert.equal(action?.targetPage, 2)
    assert.equal(action?.threadId, 'om_root')
    assert.equal(action?.chatType, 'group')
})

test('lark parseInboundAction ignores message events', () => {
    const provider = makeProvider()
    const channel = makeChannel({
        configJson: { appId: 'cli_x', verificationToken: 'tok' }
    })
    const config = provider.validateConfig(channel.configJson)
    const action = provider.parseInboundAction(
        {
            headers: {},
            body: {
                header: {
                    event_id: 'evt_msg',
                    event_type: 'im.message.receive_v1'
                },
                event: {
                    message: {
                        message_id: 'om_1',
                        chat_id: 'oc_1',
                        chat_type: 'p2p',
                        message_type: 'text',
                        content: JSON.stringify({ text: 'hi' })
                    },
                    sender: { sender_id: { open_id: 'ou_s' } }
                }
            }
        },
        { channel, config, credentials: null }
    )
    assert.equal(action, null)
})

const sessionItem = (
    index: number,
    overrides: Partial<SessionCardItem> = {}
): SessionCardItem => ({
    index,
    channelSessionId: `cs_${index}`,
    chatSessionId: `chat_${index}`,
    displayName: `session ${index}`,
    chatTitle: null,
    isActive: index === 1,
    archivedAt: null,
    lastActivityAt: null,
    ...overrides
})

test('lark sendCommandView renders session_list cards with action envelopes', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    const res = await provider.sendCommandView(
        ctx,
        'feishu:oc_group:ou_sender',
        {
            kind: 'session_list',
            text: 'Sessions (page 1/2)',
            items: [sessionItem(1), sessionItem(2), sessionItem(3)],
            page: { current: 1, total: 2 }
        }
    )
    assert.ok(res.providerMessageId)
    assert.equal(calls[1]?.body.msg_type, 'interactive')
    const card = JSON.parse(String(calls[1]?.body.content)) as {
        elements: Array<{
            tag: string
            content?: string
            actions?: Array<{ value: Record<string, unknown> }>
        }>
    }
    assert.match(card.elements[0]?.content ?? '', /Sessions \(page 1\/2\)/)
    assert.match(card.elements[0]?.content ?? '', /session 2/)
    const buttons = card.elements
        .filter((el) => el.tag === 'action')
        .flatMap((el) => el.actions ?? [])
    const verbs = buttons.map((b) => b.value.a)
    assert.deepEqual(verbs, [
        'act:/switch-session',
        'act:/switch-session',
        'act:/new-session',
        'nav:/current',
        'nav:/list-page'
    ])
    const switchButton = buttons[0]?.value as {
        s?: string
        k?: string
    }
    assert.equal(switchButton.s, 'cs_2')
    assert.equal(switchButton.k, 'feishu:oc_group:ou_sender')
    const pageButton = buttons[buttons.length - 1]?.value as { p?: number }
    assert.equal(pageButton.p, 2)
})

test('lark sendCommandView caps switch buttons and falls back to text views', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    await provider.sendCommandView(ctx, 'feishu:oc_group:ou_sender', {
        kind: 'session_list',
        text: 'Sessions',
        items: Array.from({ length: 12 }, (_, i) =>
            sessionItem(i + 1, { isActive: false })
        ),
        page: { current: 1, total: 1 }
    })
    const card = JSON.parse(String(calls[1]?.body.content)) as {
        elements: Array<{
            tag: string
            actions?: Array<{ value: Record<string, unknown> }>
        }>
    }
    const switchButtons = card.elements
        .filter((el) => el.tag === 'action')
        .flatMap((el) => el.actions ?? [])
        .filter((b) => b.value.a === 'act:/switch-session')
    assert.equal(switchButtons.length, 8)

    await provider.sendCommandView(ctx, 'feishu:oc_group:ou_sender', {
        kind: 'text',
        text: 'plain help'
    })
    const last = calls[calls.length - 1]
    assert.equal(last?.body.msg_type, 'text')
})

test('lark websocket start forwards card actions to onAction', async () => {
    const provider = makeProvider()
    const actions: unknown[] = []
    let dispatcher: {
        invoke: (
            data: unknown,
            params: { needCheck: false }
        ) => Promise<unknown>
    } | null = null
    ;(
        provider as unknown as {
            createWsClient: (params: { onReady?: () => void }) => {
                start: (params: {
                    eventDispatcher: NonNullable<typeof dispatcher>
                }) => Promise<void>
                close: () => void
            }
        }
    ).createWsClient = (params) => ({
        start: async (startParams) => {
            dispatcher = startParams.eventDispatcher
            queueMicrotask(() => params.onReady?.())
        },
        close: () => {}
    })
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const handle = await provider.start(
        { channel, config, credentials: { appSecret: 'secret' } },
        async () => {},
        undefined,
        async (action) => {
            actions.push(action)
        }
    )
    const capturedDispatcher = dispatcher as Lark.EventDispatcher | null
    await capturedDispatcher?.invoke(
        cardActionBody({
            a: 'act:/new-session',
            k: 'feishu:oc_group:ou_presser'
        }),
        { needCheck: false }
    )
    assert.equal(actions.length, 1)
    assert.equal((actions[0] as { action?: string }).action, 'act:/new-session')
    await handle.stop()
})

const actorEvent = (senderId: string): NormalizedInboundEvent =>
    ({
        providerEventId: 'evt_actor',
        chatId: 'oc_group',
        chatType: 'group',
        senderId,
        senderName: null,
        text: 'hi',
        threadId: null,
        isMention: true,
        raw: {}
    }) as NormalizedInboundEvent

test('lark evaluateInboundActor allows everyone when lists are empty', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket'
    })
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent('ou_any'), config),
        {
            allowed: true,
            operator: false
        }
    )
})

test('lark evaluateInboundActor rejects senders outside a non-empty allowlist', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        allowedUserIds: ['ou_allowed']
    })
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent('ou_other'), config),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent('ou_allowed'), config),
        { allowed: true, operator: false }
    )
})

test('lark evaluateInboundActor operator implies chat permission', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        allowedUserIds: ['ou_allowed'],
        operatorUserIds: ['ou_op']
    })
    assert.deepEqual(
        provider.evaluateInboundActor(actorEvent('ou_op'), config),
        { allowed: true, operator: true }
    )
})

test('lark validateConfig dedupes and trims actor id lists and survives re-validate', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        allowedUserIds: [' ou_a ', 'ou_a', '', 42, 'ou_b'],
        operatorUserIds: ['ou_op']
    })
    assert.deepEqual(config.allowedUserIds, ['ou_a', 'ou_b'])
    assert.deepEqual(config.operatorUserIds, ['ou_op'])
    const revalidated = provider.validateConfig(config)
    assert.deepEqual(revalidated.allowedUserIds, ['ou_a', 'ou_b'])
    assert.deepEqual(revalidated.operatorUserIds, ['ou_op'])
})

const larkCtxForSend = (provider: LarkChannelProvider) => {
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    return {
        channel,
        config: provider.validateConfig(channel.configJson),
        credentials: { appSecret: 'secret' }
    }
}

test('lark sendText auto mode renders markdown replies as interactive cards', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    await provider.sendText(
        ctx,
        'feishu:oc_group:ou_sender',
        'result:\n\n```ts\nconst x = 1\n```'
    )
    assert.equal(calls[1]?.body.msg_type, 'interactive')
    const card = JSON.parse(String(calls[1]?.body.content)) as {
        elements: Array<{ tag: string }>
    }
    assert.equal(card.elements[0]?.tag, 'markdown')
    assert.equal(
        card.elements.some((el) => el.tag === 'note'),
        false
    )
})

test('lark sendText auto mode keeps plain prose as text', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    await provider.sendText(ctx, 'feishu:oc_group:ou_sender', 'hello there')
    assert.equal(calls[1]?.body.msg_type, 'text')
})

test('lark sendText forces text for nonConversational notices even with markdown', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const ctx = larkCtxForSend(provider)
    await provider.sendText(
        ctx,
        'feishu:oc_group:ou_sender',
        '**queued** `#2`',
        { nonConversational: true }
    )
    assert.equal(calls[1]?.body.msg_type, 'text')
})

test('lark sendText honors explicit renderMode text and card', async () => {
    const provider = makeProvider()
    const calls = captureFetchJson(provider)
    const channel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            renderMode: 'text'
        }
    })
    const config = provider.validateConfig(channel.configJson)
    await provider.sendText(
        { channel, config, credentials: { appSecret: 'secret' } },
        'feishu:oc_group:ou_sender',
        '**bold** stays text'
    )
    assert.equal(calls[1]?.body.msg_type, 'text')

    const cardChannel = makeChannel({
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            renderMode: 'card'
        }
    })
    const cardConfig = provider.validateConfig(cardChannel.configJson)
    await provider.sendText(
        {
            channel: cardChannel,
            config: cardConfig,
            credentials: { appSecret: 'secret' }
        },
        'feishu:oc_group:ou_sender',
        'plain prose becomes a card'
    )
    assert.equal(calls[2]?.body.msg_type, 'interactive')
})

test('lark sendText falls back to plain text when the card send is rejected', async () => {
    const provider = makeProvider()
    const sent: Array<{ msg_type?: string }> = []
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        const body = JSON.parse(String(init.body)) as { msg_type?: string }
        sent.push(body)
        if (body.msg_type === 'interactive')
            throw new Error('lark api code=11310 msg=card size limit')
        return { data: { message_id: 'om_fallback' } }
    }
    const ctx = larkCtxForSend(provider)
    const res = await provider.sendText(
        ctx,
        'feishu:oc_group:ou_sender',
        '# heading'
    )
    assert.equal(res.providerMessageId, 'om_fallback')
    assert.deepEqual(
        sent.map((b) => b.msg_type),
        ['interactive', 'text']
    )
})

test('lark validateConfig parses renderMode with auto default', () => {
    const provider = makeProvider()
    const defaulted = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket'
    })
    assert.equal(defaulted.renderMode, 'auto')
    const explicit = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        renderMode: 'card'
    })
    assert.equal(explicit.renderMode, 'card')
    const invalid = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        renderMode: 'fancy'
    })
    assert.equal(invalid.renderMode, 'auto')
})

const captureUploads = (
    provider: LarkChannelProvider
): Array<{ url: string; init: RequestInit }> => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        if (url.endsWith('/open-apis/im/v1/images'))
            return { data: { image_key: 'img_up' } }
        if (url.endsWith('/open-apis/im/v1/files'))
            return { data: { file_key: 'file_up' } }
        return { data: { message_id: `om_out_${calls.length}` } }
    }
    return calls
}

test('lark sendAttachments uploads images and sends image messages', async () => {
    const provider = makeProvider()
    const calls = captureUploads(provider)
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const res = await provider.sendAttachments(
        { channel, config, credentials: { appSecret: 'secret' } },
        'feishu:oc_group:ou_sender',
        [
            {
                name: 'chart.png',
                contentType: 'image/png',
                bytes: Buffer.from('img')
            }
        ]
    )
    assert.ok(res.providerMessageId)
    assert.match(calls[1]?.url ?? '', /\/open-apis\/im\/v1\/images$/)
    assert.ok(calls[1]?.init.body instanceof FormData)
    const form = calls[1]?.init.body as FormData
    assert.equal(form.get('image_type'), 'message')
    const sendBody = JSON.parse(String(calls[2]?.init.body)) as {
        msg_type: string
        content: string
    }
    assert.match(calls[2]?.url ?? '', /receive_id_type=chat_id$/)
    assert.equal(sendBody.msg_type, 'image')
    assert.equal(sendBody.content, JSON.stringify({ image_key: 'img_up' }))
})

test('lark sendAttachments uploads files with extension-based file_type into threads', async () => {
    const provider = makeProvider()
    const calls = captureUploads(provider)
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    await provider.sendAttachments(
        { channel, config, credentials: { appSecret: 'secret' } },
        'feishu:oc_group:thread:om_root',
        [
            {
                name: 'report.pdf',
                contentType: 'application/pdf',
                bytes: Buffer.from('pdf')
            }
        ]
    )
    assert.match(calls[1]?.url ?? '', /\/open-apis\/im\/v1\/files$/)
    const form = calls[1]?.init.body as FormData
    assert.equal(form.get('file_type'), 'pdf')
    assert.equal(form.get('file_name'), 'report.pdf')
    const sendBody = JSON.parse(String(calls[2]?.init.body)) as {
        msg_type: string
        reply_in_thread?: boolean
    }
    assert.match(
        calls[2]?.url ?? '',
        /\/open-apis\/im\/v1\/messages\/om_root\/reply$/
    )
    assert.equal(sendBody.msg_type, 'file')
    assert.equal(sendBody.reply_in_thread, true)
})

test('lark sendAttachments propagates upload failures', async () => {
    const provider = makeProvider()
    ;(
        provider as unknown as {
            fetchJson: (
                url: string,
                init: RequestInit
            ) => Promise<Record<string, unknown>>
        }
    ).fetchJson = async (url) => {
        if (url.endsWith('/tenant_access_token/internal'))
            return { tenant_access_token: 'tenant-token', expire: 7200 }
        throw new Error('lark api code=234001 msg=no permission')
    }
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    await assert.rejects(
        provider.sendAttachments(
            { channel, config, credentials: { appSecret: 'secret' } },
            'feishu:oc_group:ou_sender',
            [
                {
                    name: 'chart.png',
                    contentType: 'image/png',
                    bytes: Buffer.from('img')
                }
            ]
        ),
        /no permission/
    )
})

test('lark validateConfig parses outboundFiles with default on', () => {
    const provider = makeProvider()
    const defaulted = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket'
    })
    assert.equal(defaulted.outboundFiles, true)
    const disabled = provider.validateConfig({
        appId: 'cli_x',
        subscriptionMode: 'websocket',
        outboundFiles: false
    })
    assert.equal(disabled.outboundFiles, false)
})

test('lark downloadAttachment surfaces open platform json error envelopes', async () => {
    const provider = makeProvider()
    captureFetchJson(provider)
    const channel = makeChannel({
        configJson: { appId: 'cli_x', subscriptionMode: 'websocket' }
    })
    const config = provider.validateConfig(channel.configJson)
    const ctx = { channel, config, credentials: { appSecret: 'secret' } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: 234001, msg: 'no permission' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })) as typeof fetch
    try {
        await assert.rejects(
            provider.downloadAttachment(
                ctx,
                {
                    url: 'lark-resource://om_img/f_k?type=file',
                    name: 'report.pdf',
                    contentType: null
                },
                { maxBytes: 1024 }
            ),
            /api error/
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('lark sendDirectAttachments uploads then sends to the direct target', async () => {
    const provider = makeProvider()
    const internal = provider as unknown as {
        getTenantAccessToken: () => Promise<string>
        uploadImage: () => Promise<string>
        uploadFile: () => Promise<string>
        fetchJson: (
            url: string,
            init: { body?: string }
        ) => Promise<{ data?: unknown }>
    }
    internal.getTenantAccessToken = async () => 'tok'
    internal.uploadImage = async () => 'img_key_1'
    internal.uploadFile = async () => 'file_key_1'
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    internal.fetchJson = async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body ?? '{}') })
        return { data: { message_id: `om_${posts.length}` } }
    }
    const ctx = {
        channel: makeChannel(),
        config: {
            appId: 'cli_x',
            verificationToken: null,
            encryptKey: null,
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: false,
            progressMode: 'preview' as const,
            botName: null
        },
        credentials: null
    }
    const result = await provider.sendDirectAttachments(
        ctx,
        { kind: 'user', userId: 'ou_member' },
        [
            {
                name: 'chart.png',
                contentType: 'image/png',
                bytes: Buffer.from('png')
            },
            {
                name: 'weekly.pdf',
                contentType: 'application/pdf',
                bytes: Buffer.from('pdf')
            }
        ]
    )
    assert.equal(result.providerMessageId, 'om_2')
    assert.match(posts[0]?.url ?? '', /receive_id_type=open_id/)
    assert.equal(posts[0]?.body.msg_type, 'image')
    assert.equal(posts[0]?.body.receive_id, 'ou_member')
    assert.match(String(posts[0]?.body.content), /img_key_1/)
    assert.equal(posts[1]?.body.msg_type, 'file')
    assert.match(String(posts[1]?.body.content), /file_key_1/)
})
