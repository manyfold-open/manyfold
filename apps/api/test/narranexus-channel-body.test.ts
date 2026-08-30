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
import { NarraNexusChatAdapter } from '../src/modules/narranexus/narranexus-chat.adapter'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'

// channel_provider/channel_context on the /v1/chat/completions body is what
// flips NarraNexus from OWNER CHAT ("do NOT call im +messages-send") into
// channel mode where the agent delivers through its own channel tools. With
// agentManagedReply on, Manyfold suppresses its own outbound — so a body that
// silently loses these fields makes the group reply vanish entirely. These
// tests pin the wire contract through the real adapter chain
// (NarraNexusChatAdapter -> OpenclawAdapter -> sendOpenAiCompat).

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
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
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

const sseResponse = (frames: string[]) => {
    const encoder = new TextEncoder()
    let next = 0
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
            getReader: () => ({
                read: async () =>
                    next < frames.length
                        ? { value: encoder.encode(frames[next++]), done: false }
                        : { value: undefined, done: true }
            })
        }
    }
}

// Runs a full send with an immediately-healthy gateway and returns the parsed
// /v1/chat/completions POST body.
const captureCompletionsBody = async (
    adapter: NarraNexusChatAdapter | OpenclawAdapter,
    ctx: ApiChatAdapterContext
): Promise<Record<string, unknown>> => {
    const bodies: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (
        _input: unknown,
        init?: { method?: string; body?: string }
    ) => {
        if ((init?.method ?? 'GET') === 'HEAD') return { ok: true, status: 200 }
        bodies.push(init?.body ?? '')
        return sseResponse([
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
            'data: [DONE]\n\n'
        ])
    }) as never
    try {
        const events = []
        for await (const ev of adapter.sendMessage(ctx, userMessage()))
            events.push(ev)
        assert.equal(
            events.at(-1)?.type,
            'done',
            'the send must stream to done — body capture is only meaningful for a completed turn'
        )
    } finally {
        globalThis.fetch = orig
    }
    assert.equal(bodies.length, 1, 'exactly one completions POST expected')
    return JSON.parse(bodies[0]) as Record<string, unknown>
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

test('the OpenClaw gateway adapter marks the owned structured pool exhaustion', async () => {
    const adapter = new OpenclawAdapter(...adapterArgs('openclaw'))
    const orig = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: { method?: string }) => {
        if ((init?.method ?? 'GET') === 'HEAD') return { ok: true, status: 200 }
        return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            body: null,
            text: async () =>
                JSON.stringify({
                    error: {
                        message: 'No available accounts: no available accounts'
                    }
                })
        }
    }) as never
    try {
        const events: EmittedChatEvent[] = []
        for await (const event of adapter.sendMessage(
            fakeCtx('openclaw'),
            userMessage()
        ))
            events.push(event)
        const error = events.find((event) => event.type === 'error')
        assert.ok(error && error.type === 'error')
        assert.equal(error.managedChannelFailure, 'account_pool_empty')
        assert.equal(error.error.code, 'openclaw_upstream')
    } finally {
        globalThis.fetch = orig
    }
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

test('plain openclaw adapter never emits channel fields even with a channelSource', async () => {
    const adapter = new OpenclawAdapter(...adapterArgs('openclaw'))
    const body = await captureCompletionsBody(
        adapter,
        fakeCtx('openclaw', larkSource())
    )
    assert.deepEqual(
        Object.keys(body).sort(),
        ['messages', 'model', 'stream', 'stream_options'],
        'the framework gate keeps non-narranexus openai-compat gateways on the unchanged wire shape'
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
    const bodies: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (
        _input: unknown,
        init?: { method?: string; body?: string }
    ) => {
        if ((init?.method ?? 'GET') === 'HEAD') return { ok: true, status: 200 }
        bodies.push(init?.body ?? '')
        return sseResponse([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            'data: [DONE]\n\n'
        ])
    }) as never
    try {
        const withFile: ChatMessage = {
            ...userMessage(),
            contentBlocks: [
                { type: 'text', text: 'look at this' },
                {
                    type: 'attachment',
                    name: 'cat.png',
                    path: 'chat-attachments/s-1/uuid/cat.png',
                    rootId: 'workspace',
                    contentType: 'image/png',
                    size: 8870
                }
            ]
        }
        for await (const _ of adapter.sendMessage(
            fakeCtx('narranexus', larkSource()),
            withFile
        ));
    } finally {
        globalThis.fetch = orig
    }
    const body = JSON.parse(bodies[0]) as Record<string, unknown>
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
