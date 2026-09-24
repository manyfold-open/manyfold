import type {
    ChannelProviderName,
    ChatMessage
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    ChannelSource,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { manyfoldProviderToNarraNexusChannelProvider } from '../src/modules/narranexus/narranexus-paths'
import { NarraNexusChatAdapter } from '../src/modules/narranexus/chat/narranexus-chat.adapter'
import { GatewayHttpChatAdapter } from '../src/modules/chat/adapters/gateway-http-chat.adapter'

// channel_provider/channel_context on the /v1/chat/completions body is what
// flips NarraNexus from OWNER CHAT ("do NOT call im +messages-send") into
// channel mode where the agent delivers through its own channel tools. With
// agentManagedReply on, Manyfold suppresses its own outbound — so a body that
// silently loses these fields makes the group reply vanish entirely. These
// tests pin the wire contract through the real adapter chain
// (NarraNexusChatAdapter -> GatewayHttpChatAdapter -> sendOpenAiCompat).

const INGRESS_HOST = 'gw.example.com'

const makeDb = (resultQueue: Array<Array<Record<string, unknown>>>) => {
    let i = 0
    return {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        resultQueue[Math.min(i++, resultQueue.length - 1)]
                })
            })
        })
    }
}

// sendMessage hits the db three times: the agent row, the resolveRuntime
// agent row, then the runtime credentials row.
const adapterArgs = (framework: 'narranexus' | 'openclaw') =>
    [
        makeDb([
            [{ runtime: 'sprites', internalId: 'main', daemonId: null }],
            [
                {
                    ingressHost: INGRESS_HOST,
                    runtimeId: 'rt-1',
                    framework,
                    internalId:
                        framework === 'narranexus' ? 'narranexus' : 'main',
                    name: 'main'
                }
            ],
            [{ payloadCiphertext: 'ct', keyVersion: 1 }]
        ]) as never,
        {
            decrypt: () =>
                framework === 'narranexus'
                    ? JSON.stringify({ gatewayToken: 'tok' })
                    : JSON.stringify({
                          gatewayToken: 'tok',
                          primaryModelName: 'claude'
                      })
        } as never,
        {} as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        {} as never,
        { event: () => {} } as never
    ] as const

const fakeCtx = (
    framework: 'narranexus' | 'openclaw',
    channelSource?: ChannelSource
): ApiChatAdapterContext => ({
    userId: 'u-1',
    agentId: 'a-1',
    runtimeId: 'rt-1',
    sessionId: 's-1',
    messageId: 'm-1',
    framework,
    runtimeKind: 'sprites',
    runnerDaemonId: 'dh_runner',
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    openclawPermissionMode: null,
    frameworkSessionRef: 'fsr-1',
    history: [],
    channelSource
})

const userMessage = (): ChatMessage => ({
    id: 'msg-1',
    sessionId: 's-1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-06-01T00:00:00.000Z'
})

// Shaped like what channel-bridge actually assembles for an agent-managed
// turn, so the wire assertions below describe a real inbound rather than a
// convenient subset.
const larkSource = (): ChannelSource => ({
    provider: 'lark',
    chatId: 'oc_room1',
    chatType: 'group',
    senderId: 'ou_sender1',
    senderName: 'Alice',
    messageId: 'om_msg1',
    threadId: null,
    replyToMessageId: null,
    isMention: true,
    replyToken: null,
    mirrored: false
})

const runnerTransport = (
    adapter: NarraNexusChatAdapter,
    onStart: (payload: Record<string, unknown>) => void,
    error?: string
): void => {
    const target = adapter as unknown as Record<string, unknown>
    target.daemonSupportsTurnRpc = async () => true
    target.daemonRegistry = {
        streamRpc: (args: { payload: Record<string, unknown>; onEvent?: (kind: string, data: string) => void }) => {
            onStart(args.payload)
            return {
                refId: 'm-1',
                result: error ? Promise.reject(new Error(error)) : Promise.resolve({ stopReason: 'done' }),
                cancel() {}
            }
        }
    }
}

const captureCompletionsBody = async (
    adapter: NarraNexusChatAdapter,
    ctx: ApiChatAdapterContext,
    message = userMessage()
): Promise<Record<string, unknown>> => {
    const bodies: Record<string, unknown>[] = []
    runnerTransport(adapter, payload => {
        assert.equal(payload.url, 'http://127.0.0.1:8000/v1/chat/completions')
        bodies.push(payload.body as Record<string, unknown>)
    })
    const events = []
    for await (const event of adapter.sendMessage(ctx, message)) events.push(event)
    assert.equal(events.at(-1)?.type, 'done')
    assert.equal(bodies.length, 1)
    return bodies[0]
}

test('narranexus turn with a lark channelSource carries channel_provider + channel_context', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', larkSource())
    )
    assert.equal(
        body.channel_provider,
        'lark',
        'channel_provider is what maps to a WorkingSource and flips the agent out of OWNER CHAT'
    )
    assert.deepEqual(
        body.channel_context,
        {
            room_id: 'oc_room1',
            sender_id: 'ou_sender1',
            sender_name: 'Alice',
            source_message_id: 'om_msg1',
            chat_type: 'group',
            is_mention: true
        },
        'channel_context carries the four ChannelTag keys plus the routing facts NarraNexus needs to pick a reply command'
    )
    for (const key of ['model', 'stream', 'stream_options', 'messages'])
        assert.ok(key in body, `standard field ${key} must survive unchanged`)
})

test('the gateway adapter marks the owned structured pool exhaustion', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    runnerTransport(adapter, () => {}, 'openclaw gateway 503 Service Unavailable: {"error":{"message":"No available accounts: no available accounts"}}')
    const events: EmittedChatEvent[] = []
    for await (const event of adapter.sendMessage(fakeCtx('narranexus'), userMessage())) events.push(event)
    const error = events.find(event => event.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
})

// Every field past the four base keys is optional on the wire. A source that
// simply lacks one must omit the key rather than send null: NarraNexus reads
// presence, and a null thread_id/reply_token would name a target that is not
// there.
test('optional channel_context keys are omitted rather than sent as null', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', {
            provider: 'lark',
            chatId: 'oc_room1',
            chatType: 'private',
            senderId: 'ou_sender1'
        })
    )
    assert.deepEqual(body.channel_context, {
        room_id: 'oc_room1',
        sender_id: 'ou_sender1',
        sender_name: null,
        source_message_id: null,
        chat_type: 'private'
    })
})

// A group message the agent was not @-mentioned in still reaches NarraNexus for
// silent memory ingest, and is_mention=false is the only thing keeping it
// silent. Dropping the key would read as "mentioned" and make the agent speak.
test('is_mention travels as a real boolean, false included', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', { ...larkSource(), isMention: false })
    )
    assert.equal(
        (body.channel_context as Record<string, unknown>).is_mention,
        false
    )
})

test('threaded lark/slack replies carry thread_id', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', { ...larkSource(), threadId: 'omt_thread1' })
    )
    assert.equal(
        (body.channel_context as Record<string, unknown>).thread_id,
        'omt_thread1'
    )
})

test('narranexus turn without a channelSource keeps the body to the four standard keys', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(adapter, fakeCtx('narranexus'))
    assert.deepEqual(
        Object.keys(body).sort(),
        ['messages', 'model', 'stream', 'stream_options'],
        'without agentManagedReply the wire body must stay byte-compatible so NarraNexus keeps OWNER CHAT and Manyfold keeps delivering'
    )
})

test('weixin channelSource maps to the wechat provider name', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', {
            ...larkSource(),
            provider: 'weixin',
            senderName: null,
            messageId: null
        })
    )
    assert.equal(
        body.channel_provider,
        'wechat',
        'NarraNexus knows "wechat", not the Manyfold id "weixin" — an unmapped name would fall back to OWNER CHAT while delivery is suppressed'
    )
    assert.deepEqual(body.channel_context, {
        room_id: 'oc_room1',
        sender_id: 'ou_sender1',
        sender_name: null,
        source_message_id: null,
        chat_type: 'group',
        is_mention: true
    })
})

// iLink has no addressable user handle, so wechat_send cannot deliver without
// the context_token that came in with the peer's message. It is a reply
// credential, so it rides only on a channel that already opted into
// agentManagedReply — which is exactly when a channelSource exists.
test('wechat carries the iLink context_token as reply_token', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', {
            ...larkSource(),
            provider: 'weixin',
            chatType: 'private',
            replyToken: 'ctx-token-1'
        })
    )
    assert.equal(
        (body.channel_context as Record<string, unknown>).reply_token,
        'ctx-token-1'
    )
})

test('a user-built matrix channel stays a plain MANYFOLD turn', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', { ...larkSource(), provider: 'matrix' })
    )
    assert.ok(
        !('channel_provider' in body) && !('channel_context' in body),
        'matrix is a generic connector: naming it narramessenger would fail authorize closed and reject the channel'
    )
})

// The same Manyfold provider means two different things depending on where the
// row came from — only a row the sync mapper created from one of our own
// bindings is NarraMessenger.
test('a mirrored matrix channel resolves to narramessenger', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', {
            ...larkSource(),
            provider: 'matrix',
            chatId: '!room:matrix.netmind.chat',
            mirrored: true
        })
    )
    assert.equal(body.channel_provider, 'narramessenger')
    assert.equal(
        (body.channel_context as Record<string, unknown>).room_id,
        '!room:matrix.netmind.chat'
    )
})

// The channel fields ride only on a gateway adapter that names the channel
// itself: the transport's default is the unchanged four-field body.
test('a gateway adapter that does not name the channel adds no channel fields', () => {
    class PlainGatewayAdapter extends GatewayHttpChatAdapter {
        readonly framework = 'openclaw'
        getCapabilities(): never {
            return {} as never
        }
    }
    const [db, crypto, pricing, chatRepo, drivers, telemetry] =
        adapterArgs('openclaw')
    const plain = new PlainGatewayAdapter(
        db,
        crypto,
        pricing,
        chatRepo,
        drivers,
        telemetry
    ) as unknown as {
        channelBodyFields(
            ctx: ApiChatAdapterContext,
            message: ReturnType<typeof userMessage>
        ): Record<string, unknown>
    }
    assert.deepEqual(
        plain.channelBodyFields(
            fakeCtx('openclaw', larkSource()),
            userMessage()
        ),
        {}
    )
})

test('manyfoldProviderToNarraNexusChannelProvider maps exactly the providers NarraNexus handles', () => {
    const expectations: Array<[ChannelProviderName, string | null]> = [
        ['lark', 'lark'],
        ['slack', 'slack'],
        ['telegram', 'telegram'],
        ['discord', 'discord'],
        ['weixin', 'wechat'],
        ['matrix', null],
        ['fake', null]
    ]
    for (const [input, expected] of expectations)
        assert.equal(
            manyfoldProviderToNarraNexusChannelProvider(input),
            expected,
            `${input} must map to ${String(expected)} — the map mirrors NarraNexus's _PROVIDER_WORKING_SOURCE`
        )
})

test('only matrix reads differently once the row is a NarraNexus mirror', () => {
    assert.equal(
        manyfoldProviderToNarraNexusChannelProvider('matrix', {
            mirrored: true
        }),
        'narramessenger'
    )
    assert.equal(
        manyfoldProviderToNarraNexusChannelProvider('fake', { mirrored: true }),
        null,
        'mirrored is not a blanket override — it only disambiguates matrix'
    )
    assert.equal(
        manyfoldProviderToNarraNexusChannelProvider('lark', { mirrored: true }),
        'lark'
    )
})

// The bytes already went to the workspace through the NarraNexus write
// endpoint; this ref is what lets NarraNexus re-enter its own upload store by
// path instead of parsing the prose the prompt also carries.
test('workspace attachments ride along as structured refs', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(adapter, fakeCtx('narranexus', larkSource()), {
        ...userMessage(),
        contentBlocks: [{ type: 'text', text: 'look at this' }, {
            type: 'attachment', name: 'cat.png', path: 'chat-attachments/s-1/uuid/cat.png',
            rootId: 'workspace', contentType: 'image/png', size: 8870
        }]
    })
    assert.deepEqual(
        (body.channel_context as Record<string, unknown>).attachments,
        [
            {
                name: 'cat.png',
                mime: 'image/png',
                size: 8870,
                path: 'chat-attachments/s-1/uuid/cat.png'
            }
        ]
    )
})

test('a turn with no attachments omits the attachments key', async () => {
    const adapter = new NarraNexusChatAdapter(...adapterArgs('narranexus'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('narranexus', larkSource())
    )
    assert.ok(
        !('attachments' in (body.channel_context as Record<string, unknown>))
    )
})
