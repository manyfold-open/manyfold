import { CHAT_UPLOAD_MAX_FILE_BYTES } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
    MockAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    type Dispatcher
} from 'undici'
import type {
    ChannelDeliveryRow,
    ChannelRow,
    ChannelSessionRow
} from '@manyfold/db'
import {
    ChannelBridgeService,
    buildReplyHud
} from '../src/modules/channels/channel-bridge.service'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import { InflightTurnConflictError } from '../src/modules/chat/chat.service'
import { ChannelProviderRegistry } from '../src/modules/channels/channel-provider-registry.service'
import { ChannelSessionRouter } from '../src/modules/channels/channel-session-router.service'
import { FakeChannelProvider } from '../src/modules/channels/providers/fake.provider'
import type { OutboundCapture } from '../src/modules/channels/providers/fake.provider'
import {
    ChatSseBroadcaster,
    type EmittedStreamEvent
} from '../src/modules/chat/sse-broadcaster'
import type { NormalizedInboundEvent } from '../src/modules/channels/channel-provider'
import {
    CHANNEL_CONTEXT_HEADER,
    buildChannelContextBlock
} from '../src/modules/channels/channel-context-projection'

const baseChannel: ChannelRow = {
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'fake',
    label: 'test channel',
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

const inboundEvent = (
    overrides: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent => ({
    providerEventId: 'evt-1',
    chatId: 'chat-1',
    chatType: 'private',
    senderId: 'user-remote',
    senderName: 'Remote User',
    text: 'hello bot',
    threadId: null,
    isMention: false,
    raw: {},
    ...overrides
})

// Every channel turn now leads with the context projection block; peel it off
// so assertions about the conversational text stay exact.
const stripContextBlock = (text: string | null | undefined): string => {
    assert.ok(
        text?.startsWith(`${CHANNEL_CONTEXT_HEADER}\n`),
        `expected a channel context block, got: ${String(text).slice(0, 80)}`
    )
    assert.ok(text)
    const sep = text.indexOf('\n\n')
    return sep === -1 ? '' : text.slice(sep + 2)
}

test('bridge round-trips inbound → ChatService → broadcaster → outbound delivery', async () => {
    const harness = makeHarness()
    const inbound = inboundEvent()

    const promise = harness.bridge.handleInbound(baseChannel, inbound)
    await harness.flushAdapter('hello, world!')
    await promise

    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        'hello bot'
    )

    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    const outboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'outbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'accepted')
    assert.equal(outboundDeliveries.length, 1)
    assert.equal(outboundDeliveries[0]?.status, 'sent')
    assert.equal(outboundDeliveries[0]?.summaryText, 'hello, world!')

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const previewKinds = captures.map((c) => c.kind)
    assert.ok(
        previewKinds.includes('preview-start') &&
            previewKinds.includes('preview-finish'),
        `expected preview lifecycle, got ${previewKinds.join(',')}`
    )
})

test('bridge prepends the channel context block built from the inbound event', async () => {
    const harness = makeHarness()
    const inbound = inboundEvent({
        chatType: 'group',
        chatId: 'group-1',
        isMention: true,
        messageId: 'msg-9',
        replyToMessageId: 'msg-8',
        threadId: 'th-1'
    })

    const promise = harness.bridge.handleInbound(baseChannel, inbound)
    await harness.flushAdapter('answer')
    await promise

    const delivery = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.ok(delivery)
    const expectedBlock = buildChannelContextBlock({
        channel: baseChannel,
        event: inbound,
        session: {
            id: 'chs-any',
            channelId: baseChannel.id,
            chatSessionId: 'sess-1',
            scopeKey: 'fake:group-1:thread:th-1',
            scopeName: null,
            remoteUserId: inbound.senderId,
            remoteThreadId: inbound.threadId ?? null,
            displayName: null,
            isActive: true,
            archivedAt: null,
            lastInboundAt: null,
            lastOutboundAt: null,
            createdAt: delivery.createdAt,
            updatedAt: delivery.createdAt
        },
        receivedAt: delivery.createdAt
    })
    assert.equal(
        harness.sendMessageCalls[0]?.text,
        `${expectedBlock}\n\nhello bot`
    )
    assert.ok(expectedBlock.includes('provider: fake'))
    assert.ok(expectedBlock.includes('message_id: msg-9'))
    assert.ok(expectedBlock.includes('reply_to_message_id: msg-8'))
    assert.ok(expectedBlock.includes('thread_id: th-1'))
})

test('contextProjection=false suppresses the channel context block', async () => {
    const harness = makeHarness()
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, contextProjection: false }
    }

    const promise = harness.bridge.handleInbound(channel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(harness.sendMessageCalls[0]?.text, 'hello bot')
})

// agentManagedReply hands the reply to the agent's own channel tools: the
// bridge must forward the structured source (so the agent knows which room
// and sender to answer) and post NOTHING itself — no preview, no final text,
// and no durable reply expectation the reconcile sweep could deliver later.
test('agentManagedReply forwards channelSource and suppresses Manyfold delivery', async () => {
    const harness = makeHarness()
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, agentManagedReply: true }
    }
    const inbound = inboundEvent({
        chatType: 'group',
        chatId: 'group-1',
        isMention: true,
        messageId: 'msg-9',
        replyToMessageId: 'msg-8',
        threadId: 'th-1'
    })

    const promise = harness.bridge.handleInbound(channel, inbound)
    await harness.flushAdapter('agent sent its own reply')
    await promise

    assert.equal(harness.sendMessageCalls.length, 1, 'the turn still runs')
    assert.deepEqual(
        harness.sendMessageCalls[0]?.channelSource,
        {
            provider: 'fake',
            chatId: 'group-1',
            chatType: 'group',
            senderId: 'user-remote',
            senderName: 'Remote User',
            messageId: 'msg-9',
            threadId: 'th-1',
            replyToMessageId: 'msg-8',
            isMention: true,
            replyToken: null,
            mirrored: false
        },
        'the adapter needs the structured source to name the room and sender'
    )
    const inboundRow = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(
        inboundRow?.status,
        'accepted',
        'the inbound still settles normally'
    )
    assert.equal(
        harness.deliveries.filter((d) => d.direction === 'outbound').length,
        0,
        'no reply-expectation row: neither inline finalize nor reconcilePendingReplies may post'
    )
    assert.equal(
        harness.fakeProvider.drainOutbound('chn-1').length,
        0,
        'zero provider sends from Manyfold — the agent owns the outbound'
    )
})

test('without agentManagedReply the turn carries no channelSource', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        harness.sendMessageCalls[0]?.channelSource,
        undefined,
        'default-off channels keep the wire body unchanged so NarraNexus stays in owner-chat mode'
    )
})

test('agentManagedReply still drains a queued inbound after the suppressed turn settles', async () => {
    const harness = makeHarness({ queueScenario: true })
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, agentManagedReply: true }
    }
    // The drain path reloads the channel via repo.getById, so the flag must
    // be visible there too or the replayed turn would silently deliver.
    harness.channelHolder.current = channel

    const pA = harness.bridge.handleInbound(
        channel,
        inboundEvent({ providerEventId: 'evt-a', text: 'first' })
    )
    for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
        await flushMicrotasks()
    const pB = harness.bridge.handleInbound(
        channel,
        inboundEvent({ providerEventId: 'evt-b', text: 'second' })
    )
    await pB

    await harness.flushAdapter('first reply')
    await pA
    for (let i = 0; i < 30 && harness.sendMessageCalls.length < 2; i += 1)
        await flushMicrotasks()

    assert.equal(
        harness.sendMessageCalls.length,
        2,
        'suppression must not break the finalize tail that drains the queue'
    )
    await harness.flushAdapter('second reply')

    assert.ok(
        harness.sendMessageCalls.every((c) => c.channelSource !== undefined),
        'the drained turn is rebuilt from the stored event and must carry the source again'
    )
    assert.equal(
        harness.deliveries.filter((d) => d.direction === 'outbound').length,
        0,
        'neither turn may leave a reply expectation'
    )
    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(
        finals.length,
        1,
        'only the queue-notice housekeeping posts from Manyfold in agent-managed mode'
    )
    assert.match(
        (finals[0] as { text: string }).text,
        /Queued/,
        'the one Manyfold send is flow-control, never the agent reply'
    )
})

test('bridge sends outbound when the chat stream completes before sendMessage returns', async () => {
    const harness = makeHarness({ completeBeforeReturn: true })
    const inbound = inboundEvent({ providerEventId: 'evt-fast' })

    await withTimeout(harness.bridge.handleInbound(baseChannel, inbound), 500)

    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    const outboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'outbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'accepted')
    assert.equal(outboundDeliveries.length, 1)
    assert.equal(outboundDeliveries[0]?.status, 'sent')
    assert.equal(outboundDeliveries[0]?.summaryText, 'fast response')
})

test('bridge queues the message when the session has an inflight turn', async () => {
    const harness = makeHarness({ inflight: true })
    const before = Date.now()

    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ text: 'second message' })
    )

    assert.equal(harness.sendMessageCalls.length, 0)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'queued')
    assert.equal(inboundDeliveries[0]?.errorMessage, 'inflight_turn')
    // Busy bounces must not burn the real-failure retry budget.
    assert.equal(inboundDeliveries[0]?.attemptCount, 0)
    const nextAt = inboundDeliveries[0]?.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= before + 15_000, 'requeued with ~15s backoff')

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /Queued/)
})

test('bridge queues a concurrent inbound and runs only one turn', async () => {
    const harness = makeHarness({ dynamicInflight: true })

    const p1 = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-a', text: 'first' })
    )
    const p2 = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-b', text: 'second' })
    )
    await harness.flushAdapter('only response')
    await Promise.all([p1, p2])
    await flushMicrotasks()
    await flushMicrotasks()

    assert.equal(harness.sendMessageCalls.length, 1)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    const accepted = inboundDeliveries.filter((d) => d.status === 'accepted')
    const queued = inboundDeliveries.filter(
        (d) => d.status === 'queued' && d.errorMessage === 'inflight_turn'
    )
    assert.equal(accepted.length, 1)
    assert.equal(queued.length, 1)
})

test('a requeued inbound is not re-acked on replay', async () => {
    const harness = makeHarness({ inflight: true })
    const row = seedInboundDelivery(harness, {
        status: 'queued',
        errorMessage: 'inflight_turn',
        scopeKey: 'fake:chat-1:user-remote',
        attemptCount: 0,
        nextAttemptAt: new Date(Date.now() - 1000)
    })

    const replayed = await harness.bridge.replayRecoverableInboundEvents()

    assert.equal(replayed, 1)
    assert.equal(row.status, 'queued')
    assert.equal(row.errorMessage, 'inflight_turn')
    assert.equal(harness.sendMessageCalls.length, 0)
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.filter((c) => c.kind === 'final').length, 0)
})

test('bridge drops the message when the inflight queue is full', async () => {
    const harness = makeHarness({ inflight: true })
    for (let i = 0; i < 5; i += 1)
        seedInboundDelivery(harness, {
            status: 'queued',
            errorMessage: 'inflight_turn',
            scopeKey: 'fake:chat-1:user-remote'
        })

    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-over', text: 'overflow' })
    )

    const over = harness.deliveries.find(
        (d) => d.providerEventId === 'evt-over'
    )
    assert.equal(over?.status, 'dropped')
    assert.equal(over?.errorMessage, 'inflight_queue_full')
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /Queue is full/)
})

test('finalizing a turn drains the next queued message as its own turn', async () => {
    const harness = makeHarness({ queueScenario: true })

    const pA = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-a', text: 'first' })
    )
    for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
        await flushMicrotasks()
    const pB = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-b', text: 'second' })
    )
    await pB

    const bQueued = harness.deliveries.find(
        (d) => d.providerEventId === 'evt-b'
    )
    assert.equal(bQueued?.status, 'queued')
    assert.equal(bQueued?.errorMessage, 'inflight_turn')

    await harness.flushAdapter('answer to first')
    await pA
    for (let i = 0; i < 30 && harness.sendMessageCalls.length < 2; i += 1)
        await flushMicrotasks()

    assert.equal(harness.sendMessageCalls.length, 2)
    assert.equal(stripContextBlock(harness.sendMessageCalls[0]?.text), 'first')
    // The drained turn is rebuilt from the stored event, so it must carry its
    // own context block too.
    assert.equal(stripContextBlock(harness.sendMessageCalls[1]?.text), 'second')

    await harness.flushAdapter('answer to second')
    const bAfter = harness.deliveries.find((d) => d.providerEventId === 'evt-b')
    assert.equal(bAfter?.status, 'accepted')
})

test('a suspended turn does not drain the queue', async () => {
    const harness = makeHarness({ queueScenario: true })

    const pA = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-a', text: 'first' })
    )
    for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
        await flushMicrotasks()
    const pB = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-b', text: 'second' })
    )
    await pB

    await harness.flushAdapterSuspended()
    await withTimeout(pA, 500)
    await flushMicrotasks()

    assert.equal(harness.sendMessageCalls.length, 1)
    const bRow = harness.deliveries.find((d) => d.providerEventId === 'evt-b')
    assert.equal(bRow?.status, 'queued')
    assert.equal(bRow?.errorMessage, 'inflight_turn')
})

test('bridge surfaces cancellation as "[response cancelled]" and dropped delivery', async () => {
    const harness = makeHarness()
    const inbound = inboundEvent({ text: 'cancel me' })

    const promise = harness.bridge.handleInbound(baseChannel, inbound)
    await harness.flushAdapterCancelled()
    await promise

    const outbound = harness.deliveries.filter(
        (d) => d.direction === 'outbound'
    )
    assert.equal(outbound.length, 1)
    assert.equal(outbound[0]?.status, 'dropped')

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'preview-finish')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /response cancelled/i)
})

test('bridge keeps the partial text with a stopped marker on cancel', async () => {
    const harness = makeHarness()
    const inbound = inboundEvent({ text: 'stop me midway' })

    const promise = harness.bridge.handleInbound(baseChannel, inbound)
    await harness.flushAdapterCancelledWithPartial('partial answer so far')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'dropped')
    assert.match(outbound?.summaryText ?? '', /⏹ stopped/)

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'preview-finish')
    assert.equal(finals.length, 1)
    const finalText = (finals[0] as { text: string }).text
    assert.match(finalText, /partial answer so far/)
    assert.match(finalText, /⏹ stopped/)
})

test('bridge ignores non-mention messages in groups when mentionOnly is true', async () => {
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, mentionOnly: true }
    }
    const harness = makeHarness()
    const inbound = inboundEvent({
        chatType: 'group',
        chatId: 'group-1',
        isMention: false
    })

    await harness.bridge.handleInbound(channel, inbound)

    assert.equal(harness.sendMessageCalls.length, 0)
    assert.equal(harness.deliveries.length, 1)
    assert.equal(harness.deliveries[0]?.status, 'dropped')
    assert.equal(harness.deliveries[0]?.errorMessage, 'mention_required')
})

test('bridge dispatches a known slash command in a group without a mention', async () => {
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, mentionOnly: true }
    }
    const harness = makeHarness()
    harness.slashHook.tryParse = (text: string) =>
        text.trim().startsWith('/list')
            ? { command: 'list', args: [], rest: '' }
            : null
    harness.slashHook.dispatch = async () => ({
        replyText: 'Sessions in this chat (0 total):',
        sideEffect: 'noop',
        command: 'list'
    })
    const inbound = inboundEvent({
        chatType: 'group',
        chatId: 'group-1',
        isMention: false,
        text: '/list'
    })

    await harness.bridge.handleInbound(channel, inbound)

    assert.equal(harness.sendMessageCalls.length, 0)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'accepted')
    assert.equal(inboundDeliveries[0]?.errorMessage, 'slash:/list')
})

test('bridge still drops unknown slash text in a group without a mention', async () => {
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, mentionOnly: true }
    }
    const harness = makeHarness()
    harness.slashHook.tryParse = () => null
    const inbound = inboundEvent({
        chatType: 'group',
        chatId: 'group-1',
        isMention: false,
        text: '/foo bar'
    })

    await harness.bridge.handleInbound(channel, inbound)

    assert.equal(harness.sendMessageCalls.length, 0)
    assert.equal(harness.deliveries.length, 1)
    assert.equal(harness.deliveries[0]?.status, 'dropped')
    assert.equal(harness.deliveries[0]?.errorMessage, 'mention_required')
})

test('bridge dispatches a slash command and never calls chat.sendMessage', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = (text: string) =>
        text.trim().startsWith('/list')
            ? { command: 'list', args: [], rest: '' }
            : null
    harness.slashHook.dispatch = async () => ({
        replyText: 'Sessions in this chat (0 total):',
        sideEffect: 'noop',
        command: 'list'
    })
    const inbound = inboundEvent({
        providerEventId: 'evt-slash',
        text: '/list'
    })

    await harness.bridge.handleInbound(baseChannel, inbound)

    assert.equal(harness.sendMessageCalls.length, 0)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'accepted')
    assert.equal(inboundDeliveries[0]?.errorMessage, 'slash:/list')

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /Sessions in this chat/)
})

test('bridge replies to a native command invocation with the invocation as interactionRef', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = (text: string) =>
        text.trim().startsWith('/stop')
            ? { command: 'stop', args: [], rest: '' }
            : null
    harness.slashHook.dispatch = async () => ({
        replyText: 'No response in progress.',
        sideEffect: 'noop',
        command: 'stop'
    })

    // A native invocation (Linear's stop signal, a Slack slash command).
    // Providers key follow-on behavior off the ref — Linear upgrades this
    // reply to the stop confirmation — so losing it is a behavior change,
    // not cosmetics.
    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({
            providerEventId: 'evt-stop-signal',
            text: '/stop',
            commandInvocation: true
        })
    )
    // The same command typed as chat text is not an invocation and must not
    // carry a ref.
    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-stop-typed', text: '/stop' })
    )

    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final') as {
        interactionRef?: string | null
        nonConversational?: boolean
    }[]
    assert.equal(finals.length, 2)
    assert.equal(finals[0]?.interactionRef, 'evt-stop-signal')
    assert.equal(finals[0]?.nonConversational, true)
    assert.equal(finals[1]?.interactionRef, null)
})

test('bridge drops an inbound event when the provider actor policy rejects the sender', async () => {
    const harness = makeHarness()
    harness.fakeProvider.actorPolicy = {
        allowed: false,
        reason: 'sender_not_allowed',
        operator: false
    }
    const inbound = inboundEvent({ providerEventId: 'evt-denied' })

    await harness.bridge.handleInbound(baseChannel, inbound)

    assert.equal(harness.sendMessageCalls.length, 0)
    assert.equal(harness.deliveries.length, 1)
    assert.equal(harness.deliveries[0]?.status, 'dropped')
    assert.equal(
        harness.deliveries[0]?.errorMessage,
        'sender_not_allowed:user-remote'
    )
    assert.equal(harness.fakeProvider.drainOutbound('chn-1').length, 0)
})

test('bridge forwards the operator verdict into slash dispatch', async () => {
    const harness = makeHarness()
    harness.fakeProvider.actorPolicy = { allowed: true, operator: false }
    let seenOperator: unknown = 'unset'
    harness.slashHook.tryParse = () => ({
        command: 'list',
        args: [],
        rest: ''
    })
    harness.slashHook.dispatch = async (_parsed, ctx) => {
        seenOperator = (ctx as { operator?: unknown }).operator
        return {
            replyText: 'ok',
            sideEffect: 'noop',
            command: 'list'
        }
    }
    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ text: '/list' })
    )
    assert.equal(seenOperator, false)
})

test('bridge records a denied agent command as dropped and still replies', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = (text: string) =>
        text.trim().startsWith('/model')
            ? { command: 'model', args: ['x'], rest: 'x' }
            : null
    harness.slashHook.dispatch = async () => ({
        replyText: 'operators only — set one in the web app',
        denied: true,
        sideEffect: 'noop',
        command: 'model'
    })

    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-model', text: '/model x' })
    )

    assert.equal(harness.sendMessageCalls.length, 0)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'dropped')
    assert.equal(
        inboundDeliveries[0]?.errorMessage,
        'operator_required:/model:user-remote'
    )
    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /operators only/)
})

test('bridge answers an unknown native command with help and drops it', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = () => null
    const inbound = inboundEvent({
        providerEventId: 'evt-unknown-cmd',
        text: '/frobnicate now',
        commandInvocation: true
    })

    await harness.bridge.handleInbound(baseChannel, inbound)

    assert.equal(harness.sendMessageCalls.length, 0)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'dropped')
    assert.equal(inboundDeliveries[0]?.errorMessage, 'unknown_command')
    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /Unknown command/)
    assert.match((finals[0] as { text: string }).text, /\/help/)
})

test('actor rejection precedes unknown-command help', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = () => null
    harness.fakeProvider.actorPolicy = {
        allowed: false,
        reason: 'sender_not_allowed',
        operator: false
    }
    const inbound = inboundEvent({
        providerEventId: 'evt-cmd-denied',
        text: '/frobnicate',
        commandInvocation: true
    })

    await harness.bridge.handleInbound(baseChannel, inbound)

    assert.equal(harness.deliveries.length, 1)
    assert.equal(harness.deliveries[0]?.status, 'dropped')
    assert.equal(
        harness.deliveries[0]?.errorMessage,
        'sender_not_allowed:user-remote'
    )
    assert.equal(harness.fakeProvider.drainOutbound('chn-1').length, 0)
})

test('bridge handleInboundAction with scopeKey mismatch is rejected', async () => {
    const harness = makeHarness()
    let dispatched = false
    harness.slashHook.dispatchAction = async () => {
        dispatched = true
        return { replyText: '', sideEffect: 'noop', command: '' }
    }

    await harness.bridge.handleInboundAction(baseChannel, {
        providerEventId: 'evt-action-bad',
        chatId: 'chat-1',
        chatType: 'private',
        senderId: 'user-remote',
        senderName: null,
        threadId: null,
        action: 'act:/switch-session',
        targetChannelSessionId: 'chs_xxx',
        targetPage: null,
        scopeKey: 'fake:chat-9:user-elsewhere',
        raw: {}
    })

    assert.equal(dispatched, false)
})

test('bridge handleInboundAction dispatches when scopeKey matches', async () => {
    const harness = makeHarness()
    let received: string | null = null
    harness.slashHook.dispatchAction = async (action: unknown) => {
        received = (action as { action: string }).action
        return {
            replyText: 'switched',
            sideEffect: 'session_switched',
            command: 'switch'
        }
    }

    await harness.bridge.handleInboundAction(baseChannel, {
        providerEventId: 'evt-action-ok',
        chatId: 'chat-1',
        chatType: 'private',
        senderId: 'user-remote',
        senderName: null,
        threadId: null,
        action: 'act:/switch-session',
        targetChannelSessionId: 'chs_xxx',
        targetPage: null,
        scopeKey: 'fake:chat-1:user-remote',
        raw: {}
    })

    assert.equal(received, 'act:/switch-session')
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /switched/)
})

test('bridge sends command-view when provider supports it', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = (text: string) =>
        text.trim().startsWith('/list')
            ? { command: 'list', args: [], rest: '' }
            : null
    harness.slashHook.dispatch = async () => ({
        replyText: 'list fallback text',
        view: {
            kind: 'session_list',
            text: 'list fallback text',
            items: [],
            page: { current: 1, total: 1 }
        },
        sideEffect: 'noop',
        command: 'list'
    })
    const inbound = inboundEvent({
        providerEventId: 'evt-card-list',
        text: '/list'
    })

    await harness.bridge.handleInbound(baseChannel, inbound)

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const views = captures.filter((c) => c.kind === 'command-view')
    assert.equal(views.length, 1)
})

test('bridge falls through to agent when slash dispatcher returns null', async () => {
    const harness = makeHarness()
    harness.slashHook.tryParse = () => null
    const inbound = inboundEvent({
        providerEventId: 'evt-plain',
        text: 'hello'
    })

    const promise = harness.bridge.handleInbound(baseChannel, inbound)
    await harness.flushAdapter('hi')
    await promise

    assert.equal(harness.sendMessageCalls.length, 1)
})

test('bridge ignores duplicate provider event ids after durable intake', async () => {
    const harness = makeHarness()
    const inbound = inboundEvent({ providerEventId: 'evt-duplicate' })

    const first = harness.bridge.handleInbound(baseChannel, inbound)
    await harness.flushAdapter('first response')
    await first
    await harness.bridge.handleInbound(baseChannel, inbound)

    assert.equal(harness.sendMessageCalls.length, 1)
    const inboundDeliveries = harness.deliveries.filter(
        (d) => d.direction === 'inbound'
    )
    assert.equal(inboundDeliveries.length, 1)
    assert.equal(inboundDeliveries[0]?.status, 'accepted')
})

test('session router cleans up orphan chat session after insert race', async () => {
    const existing: ChannelSessionRow = {
        id: 'chs-existing',
        channelId: baseChannel.id,
        chatSessionId: 'chat-session-existing',
        scopeKey: 'fake:chat-1:user-remote',
        scopeName: 'Remote User',
        remoteUserId: 'user-remote',
        remoteThreadId: null,
        displayName: null,
        isActive: true,
        archivedAt: null,
        lastInboundAt: new Date(),
        lastOutboundAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
    }
    let findCalls = 0
    const deleted: Array<{
        userId: string
        agentId: string
        sessionId: string
        force: boolean
    }> = []
    const repo = {
        findActiveSession: async () => {
            findCalls += 1
            return findCalls === 1 ? null : existing
        },
        insertSession: async () => {
            throw new Error('duplicate key')
        }
    }
    const chat = {
        createSession: async () => ({
            id: 'chat-session-orphan',
            userId: baseChannel.userId,
            agentId: baseChannel.agentId,
            title: null,
            frameworkSessionRef: null,
            createdAt: new Date(),
            updatedAt: new Date()
        }),
        deleteSession: async (
            userId: string,
            agentId: string,
            sessionId: string,
            force: boolean
        ) => {
            deleted.push({ userId, agentId, sessionId, force })
        }
    }
    const router = new ChannelSessionRouter(repo as never, chat as never)

    const resolved = await router.resolveActive(
        baseChannel,
        existing.scopeKey,
        existing.scopeName,
        { senderId: 'user-remote', threadId: null }
    )

    assert.equal(resolved.chatSessionId, existing.chatSessionId)
    assert.equal(resolved.isNew, false)
    assert.deepEqual(deleted, [
        {
            userId: baseChannel.userId,
            agentId: baseChannel.agentId,
            sessionId: 'chat-session-orphan',
            force: true
        }
    ])
})

const seedInboundDelivery = (
    harness: Harness,
    overrides: Partial<ChannelDeliveryRow> = {}
): ChannelDeliveryRow => {
    const seq = harness.deliveries.length + 1
    const row: ChannelDeliveryRow = {
        id: BigInt(seq),
        channelId: baseChannel.id,
        chatSessionId: null,
        chatMessageId: null,
        direction: 'inbound',
        scopeKey: 'pending',
        providerEventId: `evt-seed-${seq}`,
        providerMessageId: null,
        eventJson: inboundEvent({
            providerEventId: `evt-seed-${seq}`
        }) as unknown as Record<string, unknown>,
        summaryText: 'hello bot',
        status: 'failed',
        errorMessage: 'boom',
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() - 1000),
        sendAttemptStartedAt: null,
        turnMessageId: null,
        createdAt: new Date(),
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
        ...overrides
    }
    harness.deliveries.push(row)
    return row
}

test('bridge drops deterministic failures and never replays them', async () => {
    const harness = makeHarness({
        sendMessageError: new BadRequestException(
            'text, attachments, or context refs are required'
        )
    })

    await assert.rejects(
        harness.bridge.handleInbound(baseChannel, inboundEvent()),
        /required/
    )

    const delivery = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(delivery?.status, 'dropped')
    assert.match(delivery?.errorMessage ?? '', /required/)
    assert.equal(harness.sendMessageAttempts.count, 1)

    const replayed = await harness.bridge.replayRecoverableInboundEvents()
    assert.equal(replayed, 0)
    assert.equal(harness.sendMessageAttempts.count, 1)
})

test('bridge marks transient failure failed with attempt count and backoff', async () => {
    const harness = makeHarness({ sendMessageError: new Error('boom') })
    const before = Date.now()

    await assert.rejects(
        harness.bridge.handleInbound(baseChannel, inboundEvent()),
        /boom/
    )

    const delivery = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(delivery?.status, 'failed')
    assert.equal(delivery?.attemptCount, 1)
    const nextAt = delivery?.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= before + 60_000, 'backoff at least 60s')
    assert.ok(nextAt <= Date.now() + 61_000, 'backoff about 60s')
})

test('bridge marks event dead after max attempts', async () => {
    const harness = makeHarness({ sendMessageError: new Error('boom') })
    const seeded = seedInboundDelivery(harness, { attemptCount: 4 })

    const replayed = await harness.bridge.replayRecoverableInboundEvents()
    assert.equal(replayed, 1)
    assert.equal(seeded.status, 'dead')
    assert.equal(seeded.attemptCount, 5)

    const replayedAgain = await harness.bridge.replayRecoverableInboundEvents()
    assert.equal(replayedAgain, 0)
})

test('replay skips events whose nextAttemptAt is in the future', async () => {
    const harness = makeHarness({ sendMessageError: new Error('boom') })
    const due = seedInboundDelivery(harness)
    const future = seedInboundDelivery(harness, {
        nextAttemptAt: new Date(Date.now() + 60_000)
    })

    const replayed = await harness.bridge.replayRecoverableInboundEvents()
    assert.equal(replayed, 1)
    assert.equal(due.attemptCount, 2)
    assert.equal(future.attemptCount, 1)
    assert.equal(future.status, 'failed')
})

test('replay is reentrancy-guarded', async () => {
    const harness = makeHarness({ sendMessageError: new Error('boom') })
    seedInboundDelivery(harness)

    const [first, second] = await Promise.all([
        harness.bridge.replayRecoverableInboundEvents(),
        harness.bridge.replayRecoverableInboundEvents()
    ])
    assert.equal(first, 1)
    assert.equal(second, 0)
})

const seedOutboundDelivery = (
    harness: Harness,
    overrides: Partial<ChannelDeliveryRow> = {}
): ChannelDeliveryRow => {
    const seq = harness.deliveries.length + 1
    const row: ChannelDeliveryRow = {
        id: BigInt(seq),
        channelId: baseChannel.id,
        chatSessionId: 'chat-session-1',
        chatMessageId: `msg-${seq}`,
        direction: 'outbound',
        scopeKey: 'fake:chat-1:user-remote',
        providerEventId: null,
        providerMessageId: null,
        eventJson: { text: 'retry me' },
        summaryText: 'retry me',
        status: 'failed',
        errorMessage: 'send failed',
        attemptCount: 1,
        sendAttemptStartedAt: null,
        turnMessageId: null,
        nextAttemptAt: new Date(Date.now() - 1000),
        createdAt: new Date(),
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
        ...overrides
    }
    harness.deliveries.push(row)
    return row
}

test('finalizeSuccess enqueues full text then marks sent', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('full final text')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
    assert.deepEqual(outbound?.eventJson, {
        text: 'full final text',
        terminal: 'final'
    })
    assert.equal(outbound?.attemptCount, 1)
    assert.equal(outbound?.nextAttemptAt, null)
    assert.ok(outbound?.providerMessageId)
})

test('reply target reaches sendPreviewStart in preview mode', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ replyTargetId: 'TRIG-1' })
    )
    await harness.flushAdapter('done')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const previewStart = captures.find((c) => c.kind === 'preview-start')
    assert.equal(
        (previewStart as { replyToProviderMessageId?: string | null })
            ?.replyToProviderMessageId,
        'TRIG-1'
    )
})

test('reply target reaches sendText when preview is disabled', async () => {
    const harness = makeHarness()
    const finalModeChannel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, progressMode: 'final' }
    }

    const promise = harness.bridge.handleInbound(
        finalModeChannel,
        inboundEvent({ replyTargetId: 'TRIG-2' })
    )
    await harness.flushAdapter('done')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const final = captures.find((c) => c.kind === 'final')
    assert.equal(
        (final as { replyToProviderMessageId?: string | null })
            ?.replyToProviderMessageId,
        'TRIG-2'
    )
})

test('fresh final mode deletes the preview and posts a new message', async () => {
    const harness = makeHarness()
    const freshChannel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, finalMessageMode: 'fresh' }
    }

    const promise = harness.bridge.handleInbound(freshChannel, inboundEvent())
    await harness.flushAdapter('final answer')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const deleted = captures.find((c) => c.kind === 'delete')
    const previewStart = captures.find((c) => c.kind === 'preview-start')
    const final = captures.find((c) => c.kind === 'final')
    assert.ok(deleted, 'preview should be deleted')
    assert.equal(
        (deleted as { id: string }).id,
        (previewStart as { id: string }).id
    )
    assert.ok(final, 'final should be sent as a fresh message')
    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
    assert.equal(outbound?.providerMessageId, (final as { id: string }).id)
})

test('fresh final mode falls back to edit when delete fails', async () => {
    const harness = makeHarness()
    harness.fakeProvider.deleteMessage = async () => {
        throw new Error('cannot delete')
    }
    const freshChannel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, finalMessageMode: 'fresh' }
    }

    const promise = harness.bridge.handleInbound(freshChannel, inboundEvent())
    await harness.flushAdapter('final answer')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.ok(captures.some((c) => c.kind === 'preview-finish'))
    assert.equal(captures.filter((c) => c.kind === 'final').length, 0)
    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
})

test('edit final mode (default) keeps editing the preview in place', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('final answer')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.filter((c) => c.kind === 'delete').length, 0)
    assert.ok(captures.some((c) => c.kind === 'preview-finish'))
})

test('outbound send failure leaves a retryable failed row', async () => {
    const harness = makeHarness()
    harness.fakeProvider.sendPreviewStart = async () => {
        throw new Error('no preview')
    }
    harness.fakeProvider.sendText = async () => {
        throw new Error('provider down')
    }
    const before = Date.now()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('final text')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'failed')
    assert.equal(outbound?.attemptCount, 1)
    assert.deepEqual(outbound?.eventJson, {
        text: 'final text',
        terminal: 'final'
    })
    const nextAt = outbound?.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= before + 30_000, 'backoff at least 30s')
    assert.ok(nextAt <= Date.now() + 31_000, 'backoff about 30s')
})

test('sweep re-sends due failed outbound and marks sent', async () => {
    const harness = makeHarness()
    const row = seedOutboundDelivery(harness)

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    assert.equal(row.attemptCount, 2)
    assert.ok(row.providerMessageId)

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.equal((finals[0] as { text: string }).text, 'retry me')
})

test('sweep ignores legacy outbound rows without nextAttemptAt', async () => {
    const harness = makeHarness()
    const row = seedOutboundDelivery(harness, { nextAttemptAt: null })

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 0)
    assert.equal(row.status, 'failed')
    assert.equal(row.attemptCount, 1)
})

test('sweep marks outbound dead after max attempts', async () => {
    const harness = makeHarness()
    harness.fakeProvider.sendText = async () => {
        throw new Error('still down')
    }
    const row = seedOutboundDelivery(harness, { attemptCount: 4 })

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 0)
    assert.equal(row.status, 'dead')
    assert.equal(row.attemptCount, 5)
    assert.equal(row.nextAttemptAt, null)
})

test('sweep defers without burning attempts when channel is inactive', async () => {
    const harness = makeHarness()
    harness.channelHolder.current = { ...baseChannel, status: 'paused' }
    const row = seedOutboundDelivery(harness)

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 0)
    assert.equal(row.status, 'failed')
    assert.equal(row.attemptCount, 1)
    assert.equal(row.errorMessage, 'channel_inactive')
    const nextAt = row.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= Date.now() + 800_000, 'deferred well into the future')
})

test('sweep recovers stale processing outbound rows', async () => {
    const harness = makeHarness()
    const row = seedOutboundDelivery(harness, { status: 'processing' })

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
})

interface MakeHarnessOptions {
    inflight?: boolean
    completeBeforeReturn?: boolean
    dynamicInflight?: boolean
    queueScenario?: boolean
    sendMessageError?: Error
}

interface SendMessageCall {
    userId: string
    agentId: string
    sessionId: string
    text: string
    attachments: unknown[]
    uploads: unknown[]
    assistantMessageId: string
    channelSource?: unknown
}

interface IngestCall {
    sessionId: string
    files: Array<{ name: string; contentType: string; bytes: Buffer }>
}

interface Harness {
    bridge: ChannelBridgeService
    fakeProvider: FakeChannelProvider
    sendMessageCalls: SendMessageCall[]
    sendMessageAttempts: { count: number }
    ingestCalls: IngestCall[]
    appendedAttachments: Array<{ messageId: string; blocks: unknown[] }>
    apiFilesHook: {
        supportsAttachments: () => Promise<boolean>
        readWorkspaceFiles: (
            agentId: string,
            refs: Array<{ relPath: string; name: string }>
        ) => Promise<
            Array<{
                name: string
                relPath: string
                contentType: string
                bytes: Buffer
            }>
        >
    }
    deliveries: ChannelDeliveryRow[]
    channelHolder: { current: ChannelRow }
    turnOutcomes: Map<
        string,
        | { state: 'missing' }
        | { state: 'running' }
        | { state: 'done'; text: string }
        | { state: 'error'; errorMessage: string; cancelled: boolean }
    >
    flushAdapter: (text: string) => Promise<void>
    flushAdapterWith: (events: Array<Record<string, unknown>>) => Promise<void>
    // Fire a raw event at the turn observer, including after it has settled.
    emitToObserver: (event: Record<string, unknown>) => void
    pumpTokens: (texts: string[]) => Promise<void>
    flushAdapterSuspended: () => Promise<void>
    flushAdapterCancelled: () => Promise<void>
    flushAdapterCancelledWithPartial: (text: string) => Promise<void>
    slashHook: {
        tryParse: (
            text: string
        ) => { command: string; args: string[]; rest: string } | null
        dispatch: (
            parsed: unknown,
            ctx: unknown
        ) => Promise<{
            replyText: string
            view?: unknown
            sideEffect: string
            command: string
        }>
        dispatchAction: (
            action: unknown,
            ctx: unknown
        ) => Promise<{
            replyText: string
            view?: unknown
            sideEffect: string
            command: string
        }>
    }
}

const makeHarness = (opts: MakeHarnessOptions = {}): Harness => {
    let nextStreamEventId = 1n
    const broadcasterRepo = {
        insertStreamEvent: async (row: {
            sessionId: string
            messageId: string
            seq: number
            eventType: EmittedStreamEvent['type']
            payloadJson: Record<string, unknown>
            createdAt: Date
        }) => {
            const id = nextStreamEventId
            nextStreamEventId += 1n
            return { id, ...row }
        },
        listStreamEventsSince: async () => [],
        latestInflightMessageId: async () => null
    }
    const broadcasterBus = {
        onMessage: () => undefined,
        onListenEstablished: () => undefined,
        notify: () => undefined
    }
    const broadcaster = new ChatSseBroadcaster(
        broadcasterRepo as never,
        broadcasterBus as never
    )

    const sendMessageCalls: SendMessageCall[] = []
    const sendMessageAttempts = { count: 0 }
    let inflightClaimed = false
    // queueScenario models the real per-turn lock: a turn holds it until its
    // terminal is flushed, so a second inbound during the turn conflicts and
    // gets queued, then the post-finalize drain replays it.
    let inflightActive = false
    let pendingMessageId = ''
    let pendingObserver:
        | ((event: {
              type: string
              text?: string
              finalMessageId?: string
              error?: { code: string; message: string; retryable: boolean }
          }) => void)
        | null = null
    const adapterReady: { resolve: () => void } = { resolve: () => {} }
    const adapterReadyPromise = new Promise<void>((resolve) => {
        adapterReady.resolve = resolve
    })

    const turnOutcomes = new Map<
        string,
        | { state: 'missing' }
        | { state: 'running' }
        | { state: 'done'; text: string }
        | { state: 'error'; errorMessage: string; cancelled: boolean }
    >()
    const chat = {
        hasInflightTurn: async () =>
            opts.queueScenario === true
                ? inflightActive
                : opts.inflight === true,
        getTurnOutcome: async (messageId: string) =>
            turnOutcomes.get(messageId) ?? { state: 'running' },
        sendMessage: async (
            userId: string,
            agentId: string,
            sessionId: string,
            text: string,
            attachments?: unknown,
            _modelOverride?: unknown,
            _modelConfigSource?: unknown,
            _modelConfig?: unknown,
            _saveAsDefault?: unknown,
            _claudeCodePermissionMode?: unknown,
            _codexPermissionMode?: unknown,
            observer?: typeof pendingObserver,
            _contextRefs?: unknown,
            uploads?: unknown,
            sendOpts?: {
                assistantMessageId?: string
                channelSource?: unknown
            }
        ) => {
            sendMessageAttempts.count += 1
            if (opts.sendMessageError) throw opts.sendMessageError
            // Simulate the atomic per-session turn claim: reject a concurrent turn.
            if (opts.inflight === true) throw new InflightTurnConflictError()
            if (opts.dynamicInflight === true) {
                if (inflightClaimed) throw new InflightTurnConflictError()
                inflightClaimed = true
            }
            if (opts.queueScenario === true) {
                if (inflightActive) throw new InflightTurnConflictError()
                inflightActive = true
            }
            const assistantMessageId =
                sendOpts?.assistantMessageId ??
                `msg-${sendMessageCalls.length + 1}`
            sendMessageCalls.push({
                userId,
                agentId,
                sessionId,
                text,
                attachments: Array.isArray(attachments) ? attachments : [],
                uploads: Array.isArray(uploads) ? uploads : [],
                assistantMessageId,
                channelSource: sendOpts?.channelSource
            })
            broadcaster.beginStream(sessionId, assistantMessageId)
            pendingMessageId = assistantMessageId
            pendingObserver = observer ?? null
            adapterReady.resolve()
            if (opts.completeBeforeReturn) {
                pendingObserver?.({
                    type: 'token',
                    text: 'fast response'
                })
                pendingObserver?.({
                    type: 'done',
                    finalMessageId: assistantMessageId
                })
                await broadcaster.emit(assistantMessageId, {
                    type: 'token',
                    payload: { type: 'token', text: 'fast response' }
                })
                await broadcaster.emit(assistantMessageId, {
                    type: 'done',
                    payload: {
                        type: 'done',
                        finalMessageId: assistantMessageId
                    }
                })
            }
            return {
                userMessage: {
                    id: `user-msg-${sendMessageCalls.length}`,
                    sessionId,
                    role: 'user',
                    contentBlocks: [],
                    createdAt: new Date().toISOString(),
                    usage: null
                },
                assistantMessageId
            }
        },
        createSession: async (
            userId: string,
            agentId: string,
            title?: string
        ) => ({
            id: `chat-session-${Math.random().toString(36).slice(2, 8)}`,
            userId,
            agentId,
            title: title ?? null,
            frameworkSessionRef: null,
            createdAt: new Date(),
            updatedAt: new Date()
        }),
        appendAssistantAttachments: async (
            messageId: string,
            blocks: unknown[]
        ) => {
            appendedAttachments.push({ messageId, blocks })
        }
    }

    const channelSessions = new Map<string, ChannelSessionRow>()
    const deliveries: ChannelDeliveryRow[] = []

    const channelHolder = { current: baseChannel }
    const repo = {
        getById: async (id: string) =>
            id === channelHolder.current.id ? channelHolder.current : null,
        findActiveSession: async (channelId: string, scopeKey: string) => {
            return channelSessions.get(`${channelId}:${scopeKey}`) ?? null
        },
        insertSession: async (row: ChannelSessionRow) => {
            const key = `${row.channelId}:${row.scopeKey}`
            channelSessions.set(key, row)
            return row
        },
        touchSessionInbound: async () => {},
        touchSessionOutbound: async () => {},
        insertInboundEvent: async (row: {
            channelId: string
            providerEventId: string | null
            eventJson: Record<string, unknown>
            summaryText: string | null
            createdAt: Date
        }) => {
            const existing = row.providerEventId
                ? deliveries.find(
                      (d) =>
                          d.direction === 'inbound' &&
                          d.channelId === row.channelId &&
                          d.providerEventId === row.providerEventId
                  )
                : null
            // Return a snapshot: the real repo's claimInboundEvent returns a
            // fresh row, so handleInbound's `inbound.delivery` keeps its
            // pre-claim errorMessage (the "already queued" signal).
            if (existing) return { delivery: { ...existing }, created: false }
            const inserted: ChannelDeliveryRow = {
                id: BigInt(deliveries.length + 1),
                channelId: row.channelId,
                chatSessionId: null,
                chatMessageId: null,
                direction: 'inbound',
                scopeKey: 'pending',
                providerEventId: row.providerEventId,
                providerMessageId: row.providerEventId,
                eventJson: row.eventJson,
                summaryText: row.summaryText,
                status: 'queued',
                errorMessage: null,
                attemptCount: 0,
                sendAttemptStartedAt: null,
                turnMessageId: null,
                nextAttemptAt: null,
                createdAt: row.createdAt,
                updatedAt: row.createdAt
            }
            deliveries.push(inserted)
            return { delivery: { ...inserted }, created: true }
        },
        countQueuedInboundForScope: async (
            channelId: string,
            scopeKey: string
        ) => queuedInboundForScope(deliveries, channelId, scopeKey).length,
        collectQueuedInboundForScope: async (
            channelId: string,
            scopeKey: string,
            compose: (rows: ChannelDeliveryRow[]) => {
                carrierId: bigint
                mergedIds: bigint[]
                eventJson: Record<string, unknown>
                summaryText: string
            } | null
        ) => {
            const rows = queuedInboundForScope(
                deliveries,
                channelId,
                scopeKey
            ).sort(
                (a, b) =>
                    a.createdAt.getTime() - b.createdAt.getTime() ||
                    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            )
            if (rows.length === 0) return null
            const composed = compose(rows.map((r) => ({ ...r })))
            if (!composed) return rows[0] ? { ...rows[0] } : null
            const carrier = deliveries.find((d) => d.id === composed.carrierId)
            if (carrier) {
                carrier.eventJson = composed.eventJson
                carrier.summaryText = composed.summaryText
                carrier.updatedAt = new Date()
            }
            for (const id of composed.mergedIds) {
                const merged = deliveries.find((d) => d.id === id)
                if (!merged) continue
                merged.status = 'accepted'
                merged.errorMessage = `merged_into:${composed.carrierId}`
                merged.updatedAt = new Date()
            }
            return carrier ? { ...carrier } : null
        },
        nextQueuedInboundForScope: async (
            channelId: string,
            scopeKey: string
        ) => {
            const matching = queuedInboundForScope(
                deliveries,
                channelId,
                scopeKey
            ).sort(
                (a, b) =>
                    a.createdAt.getTime() - b.createdAt.getTime() ||
                    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            )
            return matching[0] ? { ...matching[0] } : null
        },
        dropQueuedInboundForScope: async (
            channelId: string,
            scopeKey: string
        ) => {
            const matching = queuedInboundForScope(
                deliveries,
                channelId,
                scopeKey
            )
            for (const d of matching) {
                d.status = 'dropped'
                d.errorMessage = 'stopped_by_user'
                d.updatedAt = new Date()
            }
            return matching.length
        },
        claimInboundEvent: async (id: bigint) => {
            const existing = deliveries.find((d) => d.id === id)
            if (
                !existing ||
                existing.direction !== 'inbound' ||
                (existing.status !== 'queued' && existing.status !== 'failed')
            )
                return null
            existing.status = 'processing'
            existing.errorMessage = null
            existing.attemptCount += 1
            existing.updatedAt = new Date()
            return existing
        },
        listRecoverableInboundEvents: async (staleBefore: Date) => {
            const now = new Date()
            return deliveries
                .filter(
                    (d) =>
                        d.direction === 'inbound' &&
                        (d.status === 'queued' ||
                            d.status === 'failed' ||
                            (d.status === 'processing' &&
                                d.updatedAt < staleBefore)) &&
                        (d.nextAttemptAt === null || d.nextAttemptAt <= now)
                )
                .map((d) => ({ ...d }))
        },
        listDueOutboundDeliveries: async (staleBefore: Date) => {
            const now = new Date()
            return deliveries.filter(
                (d) =>
                    d.direction === 'outbound' &&
                    d.nextAttemptAt !== null &&
                    d.nextAttemptAt <= now &&
                    (d.status === 'queued' ||
                        d.status === 'failed' ||
                        (d.status === 'processing' &&
                            d.updatedAt < staleBefore))
            )
        },
        claimOutboundDelivery: async (id: bigint, staleBefore: Date) => {
            const existing = deliveries.find((d) => d.id === id)
            if (
                !existing ||
                existing.direction !== 'outbound' ||
                !(
                    existing.status === 'queued' ||
                    existing.status === 'failed' ||
                    (existing.status === 'processing' &&
                        existing.updatedAt < staleBefore)
                )
            )
                return null
            existing.status = 'processing'
            existing.updatedAt = new Date()
            return existing
        },
        updateDelivery: async (
            id: bigint,
            patch: Partial<Omit<ChannelDeliveryRow, 'id'>>
        ) => {
            const existing = deliveries.find((d) => d.id === id)
            if (!existing) return null
            Object.assign(existing, patch)
            existing.updatedAt = new Date()
            return existing
        },
        findOutboundByChatMessageId: async (
            channelId: string,
            chatMessageId: string
        ) =>
            deliveries.find(
                (d) =>
                    d.direction === 'outbound' &&
                    d.channelId === channelId &&
                    d.chatMessageId === chatMessageId
            ) ?? null,
        resolvePendingDelivery: async (
            id: bigint,
            patch: Partial<Omit<ChannelDeliveryRow, 'id'>>
        ) => {
            const existing = deliveries.find(
                (d) =>
                    d.id === id &&
                    d.direction === 'outbound' &&
                    d.status === 'pending'
            )
            if (!existing) return null
            Object.assign(existing, patch)
            existing.updatedAt = new Date()
            return existing
        },
        listStalePendingOutbound: async (olderThan: Date) =>
            deliveries.filter(
                (d) =>
                    d.direction === 'outbound' &&
                    d.status === 'pending' &&
                    d.updatedAt < olderThan
            ),
        insertDelivery: async (
            row: Omit<
                ChannelDeliveryRow,
                | 'id'
                | 'eventJson'
                | 'updatedAt'
                | 'attemptCount'
                | 'nextAttemptAt'
            > &
                Partial<
                    Pick<
                        ChannelDeliveryRow,
                        | 'eventJson'
                        | 'updatedAt'
                        | 'attemptCount'
                        | 'nextAttemptAt'
                    >
                >
        ) => {
            const inserted: ChannelDeliveryRow = {
                id: BigInt(deliveries.length + 1),
                eventJson: row.eventJson ?? null,
                updatedAt: row.updatedAt ?? new Date(),
                attemptCount: row.attemptCount ?? 0,
                nextAttemptAt: row.nextAttemptAt ?? null,
                ...row
            }
            deliveries.push(inserted)
            return inserted
        }
    }

    const fakeProvider = new FakeChannelProvider()
    const providers = {
        get: () => fakeProvider
    } as unknown as ChannelProviderRegistry

    const ingestCalls: IngestCall[] = []
    const appendedAttachments: Array<{
        messageId: string
        blocks: unknown[]
    }> = []
    const apiFilesHook: {
        supportsAttachments: () => Promise<boolean>
        readWorkspaceFiles: (
            agentId: string,
            refs: Array<{ relPath: string; name: string }>
        ) => Promise<
            Array<{
                name: string
                relPath: string
                contentType: string
                bytes: Buffer
            }>
        >
        ingest?: (
            input: IngestCall & { userId: string; agentId: string }
        ) => Promise<never>
    } = {
        supportsAttachments: async () => true,
        readWorkspaceFiles: async () => []
    }
    const apiFiles = {
        supportsAttachments: () => apiFilesHook.supportsAttachments(),
        readWorkspaceFiles: (
            agentId: string,
            refs: Array<{ relPath: string; name: string }>
        ) => apiFilesHook.readWorkspaceFiles(agentId, refs),
        ingest: async (
            input: IngestCall & { userId: string; agentId: string }
        ) => {
            ingestCalls.push({ sessionId: input.sessionId, files: input.files })
            if (apiFilesHook.ingest) return apiFilesHook.ingest(input)
            return {
                attachments: input.files.map((f) => ({
                    path: `chat-attachments/${input.sessionId}/batch/${f.name}`,
                    rootId: 'workspace',
                    name: f.name,
                    contentType: f.contentType,
                    size: f.bytes.length
                })),
                uploads: []
            }
        }
    }

    const router = new ChannelSessionRouter(repo as never, chat as never)
    const crypto = {
        encrypt: () => ({ ciphertext: '', keyVersion: 1 }),
        decrypt: () => '{}'
    }
    const telemetry = {
        event: () => {},
        error: () => {}
    }

    const slashHook: {
        tryParse: (
            text: string
        ) => { command: string; args: string[]; rest: string } | null
        dispatch: (
            parsed: unknown,
            ctx: unknown
        ) => Promise<{
            replyText: string
            view?: unknown
            denied?: boolean
            sideEffect: string
            command: string
        }>
        dispatchAction: (
            action: unknown,
            ctx: unknown
        ) => Promise<{
            replyText: string
            view?: unknown
            denied?: boolean
            sideEffect: string
            command: string
        }>
    } = {
        tryParse: () => null,
        dispatch: async () => ({
            replyText: '',
            sideEffect: 'noop',
            command: ''
        }),
        dispatchAction: async () => ({
            replyText: '',
            sideEffect: 'noop',
            command: ''
        })
    }
    const slash = {
        tryParse: (text: string) => slashHook.tryParse(text),
        dispatch: (parsed: unknown, ctx: unknown) =>
            slashHook.dispatch(parsed, ctx),
        dispatchAction: (action: unknown, ctx: unknown) =>
            slashHook.dispatchAction(action, ctx)
    }

    const bridge = new ChannelBridgeService(
        repo as never,
        router,
        chat as never,
        providers,
        crypto as never,
        telemetry as never,
        slash as never,
        apiFiles as never
    )

    const releaseInflight = (): void => {
        if (opts.queueScenario === true) inflightActive = false
    }

    const flushAdapter = async (text: string): Promise<void> => {
        await adapterReadyPromise
        await flushMicrotasks()
        const messageId = pendingMessageId
        const observer = pendingObserver
        observer?.({ type: 'token', text })
        await broadcaster.emit(messageId, {
            type: 'token',
            payload: { type: 'token', text }
        })
        releaseInflight()
        observer?.({ type: 'done', finalMessageId: messageId })
        await broadcaster.emit(messageId, {
            type: 'done',
            payload: { type: 'done', finalMessageId: messageId }
        })
        await flushMicrotasks()
    }

    const flushAdapterWith = async (
        events: Array<Record<string, unknown>>
    ): Promise<void> => {
        await adapterReadyPromise
        await flushMicrotasks()
        const messageId = pendingMessageId
        const observer = pendingObserver
        for (const event of events) observer?.(event as never)
        await flushMicrotasks()
        releaseInflight()
        observer?.({ type: 'done', finalMessageId: messageId })
        await broadcaster.emit(messageId, {
            type: 'done',
            payload: { type: 'done', finalMessageId: messageId }
        })
        await flushMicrotasks()
    }

    // Emit tokens with microtask gaps so each preview flush settles before
    // the next token (deterministic strike/throttle behavior); the turn stays
    // open — finish with flushAdapter.
    const pumpTokens = async (texts: string[]): Promise<void> => {
        await adapterReadyPromise
        await flushMicrotasks()
        for (const text of texts) {
            pendingObserver?.({ type: 'token', text })
            await flushMicrotasks()
        }
    }

    const flushAdapterSuspended = async (): Promise<void> => {
        await adapterReadyPromise
        await flushMicrotasks()
        releaseInflight()
        pendingObserver?.({ type: 'suspended' })
        await flushMicrotasks()
    }

    const flushAdapterCancelled = async (): Promise<void> => {
        await adapterReadyPromise
        await flushMicrotasks()
        releaseInflight()
        pendingObserver?.({
            type: 'error',
            error: {
                code: 'cancelled',
                message: 'cancelled by user',
                retryable: false
            }
        })
        await broadcaster.emit(pendingMessageId, {
            type: 'error',
            payload: {
                type: 'error',
                error: {
                    code: 'cancelled',
                    message: 'cancelled by user',
                    retryable: false
                }
            }
        })
        await flushMicrotasks()
    }

    const flushAdapterCancelledWithPartial = async (
        text: string
    ): Promise<void> => {
        await adapterReadyPromise
        await flushMicrotasks()
        const messageId = pendingMessageId
        const observer = pendingObserver
        observer?.({ type: 'token', text })
        await broadcaster.emit(messageId, {
            type: 'token',
            payload: { type: 'token', text }
        })
        releaseInflight()
        observer?.({
            type: 'error',
            error: {
                code: 'cancelled_by_user',
                message: 'cancelled by user',
                retryable: false
            }
        })
        await broadcaster.emit(messageId, {
            type: 'error',
            payload: {
                type: 'error',
                error: {
                    code: 'cancelled_by_user',
                    message: 'cancelled by user',
                    retryable: false
                }
            }
        })
        await flushMicrotasks()
    }

    return {
        bridge,
        fakeProvider,
        sendMessageCalls,
        sendMessageAttempts,
        ingestCalls,
        appendedAttachments,
        apiFilesHook,
        deliveries,
        channelHolder,
        turnOutcomes,
        flushAdapter,
        flushAdapterWith,
        pumpTokens,
        flushAdapterSuspended,
        flushAdapterCancelled,
        flushAdapterCancelledWithPartial,
        emitToObserver: (event: Record<string, unknown>): void => {
            pendingObserver?.(event as never)
        },
        slashHook
    }
}

const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1)
        await new Promise((resolve) => setImmediate(resolve))
}

const queuedInboundForScope = (
    deliveries: ChannelDeliveryRow[],
    channelId: string,
    scopeKey: string
): ChannelDeliveryRow[] =>
    deliveries.filter(
        (d) =>
            d.direction === 'inbound' &&
            d.channelId === channelId &&
            d.status === 'queued' &&
            d.errorMessage === 'inflight_turn' &&
            d.scopeKey === scopeKey
    )

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | null = null
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`timed out after ${ms}ms`)),
                    ms
                )
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const seedPendingOutbound = (
    harness: Harness,
    overrides: Partial<ChannelDeliveryRow> = {}
): ChannelDeliveryRow => {
    const seq = harness.deliveries.length + 1
    const row: ChannelDeliveryRow = {
        id: BigInt(seq),
        channelId: baseChannel.id,
        chatSessionId: 'chat-session-1',
        chatMessageId: `msg-pending-${seq}`,
        direction: 'outbound',
        scopeKey: 'fake:chat-1:user-remote',
        providerEventId: null,
        providerMessageId: null,
        eventJson: null,
        summaryText: null,
        status: 'pending',
        errorMessage: null,
        attemptCount: 0,
        sendAttemptStartedAt: null,
        turnMessageId: null,
        nextAttemptAt: null,
        createdAt: new Date(Date.now() - 10 * 60_000),
        updatedAt: new Date(Date.now() - 10 * 60_000),
        ...overrides
    }
    harness.deliveries.push(row)
    return row
}

test('handleInbound records a pending reply expectation before the turn runs', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
    assert.equal(
        outbound?.chatMessageId,
        harness.sendMessageCalls[0]?.assistantMessageId,
        'reply expectation is keyed to the assistant message'
    )
    assert.equal(
        harness.deliveries.filter((d) => d.direction === 'outbound').length,
        1,
        'finalize resolves the pending row instead of inserting a second one'
    )
})

test('suspended turn releases the wait and leaves the pending row for reconcile', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapterSuspended()
    await withTimeout(promise, 500)

    const pending = harness.deliveries.find(
        (d) => d.direction === 'outbound' && d.status === 'pending'
    )
    assert.ok(pending, 'reply expectation survives the suspend')

    // Daemon posts back later; the resumed turn terminates without an
    // observer. Reconcile picks the reply up from persisted turn state.
    harness.turnOutcomes.set(pending.chatMessageId ?? '', {
        state: 'done',
        text: 'late answer from the daemon'
    })
    pending.updatedAt = new Date(Date.now() - 10 * 60_000)

    const reconciled = await harness.bridge.reconcilePendingReplies()
    assert.equal(reconciled, 1)
    assert.equal(pending.status, 'queued')

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(pending.status, 'sent')

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.equal(
        (finals[0] as { text: string }).text,
        'late answer from the daemon'
    )
})

test('replay pump is not wedged by a turn that suspends', async () => {
    const harness = makeHarness()
    seedInboundDelivery(harness)

    const replayPromise = harness.bridge.replayRecoverableInboundEvents()
    await harness.flushAdapterSuspended()
    const replayed = await withTimeout(replayPromise, 500)

    assert.equal(replayed, 1)
    assert.equal(
        await harness.bridge.replayRecoverableInboundEvents(),
        0,
        'pump is free for the next tick'
    )
})

test('reconcile delivers a crash-orphaned done turn from persisted state', async () => {
    const harness = makeHarness()
    const row = seedPendingOutbound(harness)
    harness.turnOutcomes.set(row.chatMessageId ?? '', {
        state: 'done',
        text: 'recovered reply'
    })

    const reconciled = await harness.bridge.reconcilePendingReplies()
    assert.equal(reconciled, 1)
    assert.equal(row.status, 'queued')
    assert.deepEqual(row.eventJson, {
        text: 'recovered reply',
        terminal: 'final'
    })

    await harness.bridge.sweepOutboundDeliveries()
    assert.equal(row.status, 'sent')
})

test('reconcile turns an errored turn into a failure note', async () => {
    const harness = makeHarness()
    const row = seedPendingOutbound(harness)
    harness.turnOutcomes.set(row.chatMessageId ?? '', {
        state: 'error',
        errorMessage: 'sprite exploded',
        cancelled: false
    })

    const reconciled = await harness.bridge.reconcilePendingReplies()
    assert.equal(reconciled, 1)
    assert.equal(row.status, 'queued')
    assert.match(
        (row.eventJson as { text: string }).text,
        /agent failed: sprite exploded/
    )
    assert.equal(row.errorMessage, 'sprite exploded')
})

test('reconcile leaves a live turn alone until the max hold elapses', async () => {
    const harness = makeHarness()
    const running = seedPendingOutbound(harness)
    harness.turnOutcomes.set(running.chatMessageId ?? '', {
        state: 'running'
    })

    const reconciled = await harness.bridge.reconcilePendingReplies()
    assert.equal(reconciled, 0)
    assert.equal(running.status, 'pending')

    running.updatedAt = new Date(Date.now() - 4 * 60 * 60_000)
    const second = await harness.bridge.reconcilePendingReplies()
    assert.equal(second, 1)
    assert.equal(running.status, 'queued')
    assert.match(
        (running.eventJson as { text: string }).text,
        /turn did not complete/
    )
    assert.equal(running.errorMessage, 'turn_never_terminated')
})

test('reconcile marks rows dead when the assistant message is gone', async () => {
    const harness = makeHarness()
    const row = seedPendingOutbound(harness)
    harness.turnOutcomes.set(row.chatMessageId ?? '', { state: 'missing' })

    const reconciled = await harness.bridge.reconcilePendingReplies()
    assert.equal(reconciled, 0)
    assert.equal(row.status, 'dead')
    assert.equal(row.errorMessage, 'assistant_message_missing')
})

test('finalize skips the send when reconcile already took the reply over', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await new Promise((resolve) => setImmediate(resolve))

    // Reconcile wins the race: the pending row is resolved before the
    // adapter terminal arrives, so the inline finalize must not double-send.
    const pending = harness.deliveries.find(
        (d) => d.direction === 'outbound' && d.status === 'pending'
    )
    assert.ok(pending)
    pending.status = 'queued'
    pending.eventJson = { text: 'reconciled first' }

    await harness.flushAdapter('inline text')
    await promise

    assert.equal(pending.status, 'queued', 'inline finalize lost the CAS')
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finals = captures.filter(
        (c) => c.kind === 'final' || c.kind === 'preview-finish'
    )
    assert.equal(finals.length, 0, 'no duplicate inline send')
})

// A literal public IP keeps assertPublicHttpUrl happy without DNS while the
// MockAgent intercepts the actual fetch.
const CDN = 'http://93.184.216.34'

const cdnAttachment = (overrides: Record<string, unknown> = {}) => ({
    url: `${CDN}/pic.png`,
    name: 'pic.png',
    contentType: 'image/png',
    size: 8,
    ...overrides
})

const withCdnMock = async (
    setup: (pool: ReturnType<MockAgent['get']>) => void,
    run: () => Promise<void>
): Promise<void> => {
    const previous: Dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    try {
        setup(agent.get(CDN))
        await run()
    } finally {
        setGlobalDispatcher(previous)
    }
}

test('bridge downloads inbound attachments and passes ingested files to sendMessage', async () => {
    const harness = makeHarness()
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, Buffer.from('imgbytes'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({ attachments: [cdnAttachment()] })
            )
            await harness.flushAdapter('described the image')
            await promise
        }
    )

    assert.equal(harness.ingestCalls.length, 1)
    assert.equal(harness.ingestCalls[0]?.files.length, 1)
    assert.equal(harness.ingestCalls[0]?.files[0]?.name, 'pic.png')
    assert.equal(harness.ingestCalls[0]?.files[0]?.bytes.toString(), 'imgbytes')
    const call = harness.sendMessageCalls[0]
    assert.equal(call?.attachments.length, 1)
    assert.match((call?.attachments[0] as { path: string }).path, /pic\.png$/)
    assert.deepEqual(call?.uploads, [])
})

test('bridge accepts attachment-only inbound messages', async () => {
    const harness = makeHarness()
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, Buffer.from('imgbytes'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({ text: '', attachments: [cdnAttachment()] })
            )
            await harness.flushAdapter('a photo of a cat')
            await promise
        }
    )

    const call = harness.sendMessageCalls[0]
    // Attachment-only turns still carry origin context: the text is exactly
    // the block, with no dangling separator.
    assert.equal(stripContextBlock(call?.text), '')
    assert.equal(call?.attachments.length, 1)
    const accepted = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(accepted?.status, 'accepted')
})

test('bridge skips oversized attachments without downloading', async () => {
    const harness = makeHarness()
    let fetched = false
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, () => {
                    fetched = true
                    return Buffer.from('x')
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({
                    text: 'look at this',
                    attachments: [cdnAttachment({ size: 26 * 1024 * 1024 })]
                })
            )
            await harness.flushAdapter('cannot see it')
            await promise
        }
    )

    assert.equal(fetched, false)
    assert.equal(harness.ingestCalls.length, 0)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
})

test('bridge skips failed downloads and continues text-only', async () => {
    const harness = makeHarness()
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(404, 'gone'),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({
                    text: 'see attached',
                    attachments: [cdnAttachment()]
                })
            )
            await harness.flushAdapter('ok')
            await promise
        }
    )

    assert.equal(harness.ingestCalls.length, 0)
    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
})

test('bridge degrades to text-only when the framework lacks attachment support', async () => {
    const harness = makeHarness()
    harness.apiFilesHook.supportsAttachments = async () => false
    let fetched = false
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, () => {
                    fetched = true
                    return Buffer.from('x')
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({
                    text: 'process this file',
                    attachments: [cdnAttachment()]
                })
            )
            await harness.flushAdapter('done without file')
            await promise
        }
    )

    assert.equal(fetched, false)
    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const notice = captures.find(
        (c) =>
            c.kind === 'final' && c.text.includes('continuing with text only')
    )
    assert.ok(
        notice?.kind === 'final',
        'expected a degrade notice to the channel'
    )
    // A capability gap is about the agent, not this attempt: the copy must
    // name the agent and must not suggest retrying (#577).
    assert.match(notice!.text, /does not support file attachments/)
    assert.doesNotMatch(notice!.text, /try sending/)
})

test('bridge sends a retryable notice when ingest fails, not the capability copy', async () => {
    const harness = makeHarness()
    ;(
        harness.apiFilesHook as typeof harness.apiFilesHook & {
            ingest: (input: unknown) => Promise<never>
        }
    ).ingest = async () => {
        throw new Error('narranexus files/write failed (status 502)')
    }
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, Buffer.from('imgbytes'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({
                    text: 'process this file',
                    attachments: [cdnAttachment()]
                })
            )
            await harness.flushAdapter('done without file')
            await promise
        }
    )

    assert.equal(harness.ingestCalls.length, 1)
    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const notice = captures.find(
        (c) =>
            c.kind === 'final' && c.text.includes('continuing with text only')
    )
    assert.ok(
        notice?.kind === 'final',
        'expected a degrade notice to the channel'
    )
    // A transient ingest failure says nothing about the agent's abilities:
    // the copy must invite a retry and must not blame the agent (#577).
    assert.match(notice!.text, /try sending them again/)
    assert.doesNotMatch(notice!.text, /for this agent|does not support/)
})

test('bridge drops attachment-only messages when nothing survives', async () => {
    const harness = makeHarness()
    harness.apiFilesHook.supportsAttachments = async () => false

    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ text: '', attachments: [cdnAttachment()] })
    )

    assert.equal(harness.sendMessageCalls.length, 0)
    const dropped = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(dropped?.status, 'dropped')
    assert.equal(dropped?.errorMessage, 'attachments_unavailable')
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const notice = captures.find(
        (c) => c.kind === 'final' && c.text.includes('nothing to send')
    )
    assert.ok(notice?.kind === 'final', 'expected a drop notice to the channel')
    assert.match(notice!.text, /does not support file attachments/)
})

test('bridge prefers provider.downloadAttachment over the anonymous URL fetch', async () => {
    const harness = makeHarness()
    let hookCalls = 0
    let seenMax = 0
    harness.fakeProvider.downloadAttachment = async (_ctx, att, opts) => {
        hookCalls += 1
        seenMax = opts.maxBytes
        return {
            name: att.name,
            contentType: att.contentType ?? 'image/png',
            bytes: Buffer.from('hookbytes')
        }
    }
    let fetched = false
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, () => {
                    fetched = true
                    return Buffer.from('urlbytes')
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({ text: 'hi', attachments: [cdnAttachment()] })
            )
            await harness.flushAdapter('ok')
            await promise
        }
    )

    assert.equal(hookCalls, 1)
    assert.equal(seenMax, CHAT_UPLOAD_MAX_FILE_BYTES)
    assert.equal(fetched, false)
    assert.equal(
        harness.ingestCalls[0]?.files[0]?.bytes.toString(),
        'hookbytes'
    )
})

test('bridge filters attachments before the download hook and degrades a throwing one', async () => {
    const harness = makeHarness()
    const hookNames: string[] = []
    harness.fakeProvider.downloadAttachment = async (_ctx, att) => {
        hookNames.push(att.name)
        if (att.name === 'boom.png') throw new Error('download exploded')
        return {
            name: att.name,
            contentType: 'image/png',
            bytes: Buffer.from('ok')
        }
    }
    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({
            text: 'files',
            attachments: [
                cdnAttachment({ url: `${CDN}/a.png`, name: 'a.png' }),
                cdnAttachment({
                    url: `${CDN}/big.png`,
                    name: 'big.png',
                    size: 26 * 1024 * 1024
                }),
                cdnAttachment({
                    url: `${CDN}/x.exe`,
                    name: 'x.exe',
                    contentType: 'application/x-msdownload'
                }),
                cdnAttachment({ url: `${CDN}/boom.png`, name: 'boom.png' })
            ]
        })
    )
    await harness.flushAdapter('done')
    await promise

    // Oversized + unsupported are filtered before the hook; only the two valid
    // ones reach it, and the thrower degrades to skip just that file.
    assert.deepEqual(hookNames.sort(), ['a.png', 'boom.png'])
    assert.equal(harness.ingestCalls[0]?.files.length, 1)
    assert.equal(harness.ingestCalls[0]?.files[0]?.name, 'a.png')
    assert.equal(harness.sendMessageCalls.length, 1)
})

test('replay round-trips attachment descriptors through eventJson', async () => {
    const harness = makeHarness()
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, Buffer.from('imgbytes'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            seedInboundDelivery(harness, {
                providerEventId: 'evt-replay-att',
                eventJson: inboundEvent({
                    providerEventId: 'evt-replay-att',
                    attachments: [cdnAttachment()]
                }) as unknown as Record<string, unknown>
            })
            const promise = harness.bridge.replayRecoverableInboundEvents()
            await harness.flushAdapter('replayed with file')
            const replayed = await promise
            assert.equal(replayed, 1)
        }
    )

    assert.equal(harness.ingestCalls.length, 1)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 1)
})

test('replay drops malformed stored attachment descriptors', async () => {
    const harness = makeHarness()
    seedInboundDelivery(harness, {
        providerEventId: 'evt-replay-bad',
        eventJson: {
            ...(inboundEvent({
                providerEventId: 'evt-replay-bad'
            }) as unknown as Record<string, unknown>),
            attachments: [{ bogus: true }, 'junk']
        }
    })

    const promise = harness.bridge.replayRecoverableInboundEvents()
    await harness.flushAdapter('replayed without files')
    const replayed = await promise

    assert.equal(replayed, 1)
    assert.equal(harness.ingestCalls.length, 0)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
})

test('group attachment-only without mention drops before any download', async () => {
    const harness = makeHarness()
    let fetched = false
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, () => {
                    fetched = true
                    return Buffer.from('x')
                }),
        async () => {
            await harness.bridge.handleInbound(
                baseChannel,
                inboundEvent({
                    chatType: 'group',
                    isMention: false,
                    text: '',
                    attachments: [cdnAttachment()]
                })
            )
        }
    )

    assert.equal(fetched, false)
    assert.equal(harness.sendMessageCalls.length, 0)
    const dropped = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(dropped?.errorMessage, 'mention_required')
})

const activityChannel: ChannelRow = {
    ...baseChannel,
    configJson: { note: null, progressMode: 'activity' }
}

test('activity mode folds tool calls into the preview and keeps the final clean', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        activityChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        {
            type: 'tool_call',
            toolCallId: 't1',
            toolName: 'Bash',
            args: { cmd: 'ls -la' }
        },
        { type: 'token', text: 'final answer' }
    ])
    await promise

    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const updates = captures.filter((c) => c.kind === 'preview-update')
    assert.ok(
        updates.some((u) => 'text' in u && u.text.includes('⚙ Bash')),
        'expected a preview update carrying the tool line'
    )
    const finish = captures.find((c) => c.kind === 'preview-finish')
    assert.ok(finish && 'text' in finish)
    assert.equal(finish.text, 'final answer')
})

test('activity mode renders thinking as an evolving line', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        activityChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        { type: 'thinking', text: 'let me check the logs' },
        { type: 'token', text: 'done checking' }
    ])
    await promise

    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const updates = captures.filter((c) => c.kind === 'preview-update')
    assert.ok(
        updates.some(
            (u) => 'text' in u && u.text.includes('💭 let me check the logs')
        )
    )
})

test('preview mode ignores tool events (regression)', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapterWith([
        {
            type: 'tool_call',
            toolCallId: 't1',
            toolName: 'Bash',
            args: {}
        },
        { type: 'token', text: 'plain answer' }
    ])
    await promise

    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    for (const capture of captures) {
        if ('text' in capture) assert.ok(!capture.text.includes('⚙'))
    }
})

const hudChannel: ChannelRow = {
    ...baseChannel,
    configJson: { note: null, replyHud: true }
}

test('buildReplyHud formats stats and skips missing fields', () => {
    assert.equal(
        buildReplyHud({
            model: 'claude-sonnet-5',
            inputTokens: 1000,
            outputTokens: 500,
            costUsd: 0.042,
            durationMs: 38000,
            toolCalls: 3
        }),
        '⎿ claude-sonnet-5 · 1.5k tok · $0.042 · 38.0s · 3 tools'
    )
    assert.equal(
        buildReplyHud({
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null,
            durationMs: null,
            toolCalls: 0
        }),
        ''
    )
})

test('replyHud appends a usage footer to the reply and the outbox row', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(hudChannel, inboundEvent())
    await harness.flushAdapterWith([
        { type: 'token', text: 'the answer' },
        {
            type: 'usage',
            usage: {
                model: 'claude-sonnet-5',
                inputTokens: 1000,
                outputTokens: 500,
                costUsd: 0.02,
                totalMs: 12000
            }
        }
    ])
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finish = captures.find((c) => c.kind === 'preview-finish')
    assert.ok(finish && 'text' in finish)
    assert.match(
        finish.text,
        /the answer\n\n⎿ claude-sonnet-5 · 1.5k tok · \$0.020 · 12.0s/
    )
    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.match(
        (outbound?.eventJson as { text: string }).text,
        /⎿ claude-sonnet-5/
    )
})

test('replyHud off leaves the reply clean', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapterWith([
        { type: 'token', text: 'the answer' },
        {
            type: 'usage',
            usage: {
                model: 'claude-sonnet-5',
                inputTokens: 1000,
                outputTokens: 500,
                costUsd: 0.02,
                totalMs: 12000
            }
        }
    ])
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const finish = captures.find((c) => c.kind === 'preview-finish')
    assert.ok(finish && 'text' in finish)
    assert.doesNotMatch(finish.text, /⎿/)
})

test('outbound files: agent-linked workspace file is attached and persisted', async () => {
    const harness = makeHarness()
    harness.apiFilesHook.readWorkspaceFiles = async (_agentId, refs) => {
        assert.deepEqual(refs, [{ relPath: 'sine.png', name: 'sine.png' }])
        return [
            {
                name: 'sine.png',
                relPath: 'sine.png',
                contentType: 'image/png',
                bytes: Buffer.from('PNGDATA')
            }
        ]
    }

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('Here is the plot: [chart](sine.png)')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const attach = captures.find((c) => c.kind === 'attachments')
    assert.ok(attach && 'files' in attach)
    assert.deepEqual(attach.files, [
        { name: 'sine.png', contentType: 'image/png', size: 7 }
    ])
    assert.equal(harness.appendedAttachments.length, 1)
    assert.equal(harness.appendedAttachments[0]?.blocks.length, 1)
    assert.deepEqual(harness.appendedAttachments[0]?.blocks[0], {
        type: 'attachment',
        name: 'sine.png',
        path: 'sine.png',
        rootId: 'workspace',
        contentType: 'image/png',
        size: 7
    })
})

test('outbound files: disabled channel does not attach', async () => {
    const harness = makeHarness()
    let readCalled = false
    harness.apiFilesHook.readWorkspaceFiles = async () => {
        readCalled = true
        return []
    }
    const noFilesChannel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, outboundFiles: false }
    }

    const promise = harness.bridge.handleInbound(noFilesChannel, inboundEvent())
    await harness.flushAdapter('Here is the plot: [chart](sine.png)')
    await promise

    assert.equal(readCalled, false)
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.filter((c) => c.kind === 'attachments').length, 0)
    assert.equal(harness.appendedAttachments.length, 0)
})

test('outbound files: no readable files degrades to text only', async () => {
    const harness = makeHarness()
    harness.apiFilesHook.readWorkspaceFiles = async () => []

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('Here is the plot: [chart](sine.png)')
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.filter((c) => c.kind === 'attachments').length, 0)
    assert.equal(harness.appendedAttachments.length, 0)
    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
})

test('sender name enrichment feeds the context block and scope name', async () => {
    const harness = makeHarness()
    harness.fakeProvider.resolveSenderName = async (_ctx, event) =>
        event.senderId === 'user-remote' ? 'Resolved Remote' : null

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ senderName: null })
    )
    await harness.flushAdapter('answer')
    await promise

    const text = harness.sendMessageCalls[0]?.text ?? ''
    assert.match(text, /sender_name: "Resolved Remote" \(untrusted\)/)
})

test('sender name enrichment failure proceeds unnamed', async () => {
    const harness = makeHarness()
    harness.fakeProvider.resolveSenderName = async () => {
        throw new Error('contact scope missing')
    }

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ senderName: null })
    )
    await harness.flushAdapter('answer')
    await promise

    const text = harness.sendMessageCalls[0]?.text ?? ''
    assert.equal(stripContextBlock(text), 'hello bot')
    assert.doesNotMatch(text, /sender_name:/)
})

test('reply context block lands between context block and user text', async () => {
    const harness = makeHarness()
    harness.fakeProvider.fetchReplyContext = async (_ctx, event) =>
        event.replyToMessageId ? '[Replying to "user"]: "earlier text"' : null

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ replyToMessageId: 'pm-q1' })
    )
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        '[Replying to "user"]: "earlier text"\n\nhello bot'
    )
})

test('reply context failure leaves the turn text unchanged', async () => {
    const harness = makeHarness()
    harness.fakeProvider.fetchReplyContext = async () => {
        throw new Error('boom')
    }

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ replyToMessageId: 'pm-q1' })
    )
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        'hello bot'
    )
})

test('typing starts after acceptance and stops on done', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ messageId: 'pm-typing-1' })
    )
    await harness.flushAdapter('answer')
    await promise

    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const kinds = captures.map((c) => c.kind)
    const startIdx = kinds.indexOf('typing-start')
    const previewIdx = kinds.indexOf('preview-start')
    assert.notEqual(startIdx, -1, 'typing-start missing')
    assert.notEqual(kinds.indexOf('typing-stop'), -1, 'typing-stop missing')
    assert.ok(
        previewIdx === -1 || startIdx < previewIdx,
        'typing should start before the preview'
    )
    const start = captures[startIdx] as {
        triggerProviderMessageId?: string | null
    }
    assert.equal(start.triggerProviderMessageId, 'pm-typing-1')
})

test('typing stops on error and suspended terminals', async () => {
    const errored = makeHarness()
    const erroredPromise = errored.bridge.handleInbound(
        baseChannel,
        inboundEvent()
    )
    await errored.flushAdapterCancelled()
    await erroredPromise
    const erroredKinds = errored.fakeProvider
        .drainOutbound(baseChannel.id)
        .map((c) => c.kind)
    assert.ok(erroredKinds.includes('typing-stop'))

    const suspended = makeHarness()
    const suspendedPromise = suspended.bridge.handleInbound(
        baseChannel,
        inboundEvent()
    )
    await suspended.flushAdapterSuspended()
    await suspendedPromise
    const suspendedKinds = suspended.fakeProvider
        .drainOutbound(baseChannel.id)
        .map((c) => c.kind)
    assert.ok(suspendedKinds.includes('typing-stop'))
})

test('queued and slash paths never trigger typing', async () => {
    const queued = makeHarness({ inflight: true })
    await queued.bridge.handleInbound(baseChannel, inboundEvent())
    const queuedKinds = queued.fakeProvider
        .drainOutbound(baseChannel.id)
        .map((c) => c.kind)
    assert.ok(!queuedKinds.includes('typing-start'))

    const slash = makeHarness()
    slash.slashHook.tryParse = (text) =>
        text.startsWith('/help')
            ? { command: 'help', args: [], rest: '' }
            : null
    slash.slashHook.dispatch = async () => ({
        replyText: 'help text',
        sideEffect: 'none',
        command: 'help'
    })
    await slash.bridge.handleInbound(
        baseChannel,
        inboundEvent({ text: '/help' })
    )
    const slashKinds = slash.fakeProvider
        .drainOutbound(baseChannel.id)
        .map((c) => c.kind)
    assert.ok(!slashKinds.includes('typing-start'))
})

// --- history backfill ---

const groupMention = (
    overrides: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent =>
    inboundEvent({
        chatType: 'group',
        chatId: 'group-1',
        isMention: true,
        text: 'hello bot',
        ...overrides
    })

test('bridge prepends history backfill to the group turn text', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult =
        '[Recent channel messages]\n[alice] earlier'
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, historyBackfillLimit: 250 }
    }

    const promise = harness.bridge.handleInbound(channel, groupMention())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        '[Recent channel messages]\n[alice] earlier\n\n[New message]\nhello bot'
    )
    assert.equal(harness.fakeProvider.historyFetches.length, 1)
    // 250 is clamped to the single-page maximum.
    assert.equal(harness.fakeProvider.historyFetches[0]?.limit, 100)
})

test('contextProjection=false suppresses the block but keeps history backfill', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult =
        '[Recent channel messages]\n[alice] earlier'
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, contextProjection: false }
    }

    const promise = harness.bridge.handleInbound(channel, groupMention())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        harness.sendMessageCalls[0]?.text,
        '[Recent channel messages]\n[alice] earlier\n\n[New message]\nhello bot'
    )
})

test('bridge skips backfill when historyBackfill is disabled', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult =
        '[Recent channel messages]\n[x] y'
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, historyBackfill: false }
    }

    const promise = harness.bridge.handleInbound(channel, groupMention())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        'hello bot'
    )
    assert.equal(harness.fakeProvider.historyFetches.length, 0)
})

test('bridge does not backfill private chats', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult =
        '[Recent channel messages]\n[x] y'

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        'hello bot'
    )
    assert.equal(harness.fakeProvider.historyFetches.length, 0)
})

test('bridge does not backfill slash commands', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult =
        '[Recent channel messages]\n[x] y'
    harness.slashHook.tryParse = (text: string) =>
        text.trim().startsWith('/list')
            ? { command: 'list', args: [], rest: '' }
            : null
    harness.slashHook.dispatch = async () => ({
        replyText: 'ok',
        sideEffect: 'noop',
        command: 'list'
    })

    await harness.bridge.handleInbound(
        baseChannel,
        groupMention({ text: '/list' })
    )

    assert.equal(harness.sendMessageCalls.length, 0)
    assert.equal(harness.fakeProvider.historyFetches.length, 0)
})

test('bridge proceeds with the original text when backfill throws', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = () => {
        throw new Error('boom')
    }

    const promise = harness.bridge.handleInbound(baseChannel, groupMention())
    await harness.flushAdapter('answer')
    await promise

    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        'hello bot'
    )
    assert.equal(harness.fakeProvider.historyFetches.length, 1)
})

test('bridge backfills each queued turn independently', async () => {
    const harness = makeHarness({ queueScenario: true })
    harness.fakeProvider.historyContextResult = '[ctx]'

    const pA = harness.bridge.handleInbound(
        baseChannel,
        groupMention({ providerEventId: 'evt-a', text: 'first' })
    )
    for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
        await flushMicrotasks()
    const pB = harness.bridge.handleInbound(
        baseChannel,
        groupMention({ providerEventId: 'evt-b', text: 'second' })
    )
    await pB

    await harness.flushAdapter('answer to first')
    await pA
    for (let i = 0; i < 30 && harness.sendMessageCalls.length < 2; i += 1)
        await flushMicrotasks()
    await harness.flushAdapter('answer to second')

    assert.equal(harness.sendMessageCalls.length, 2)
    assert.equal(
        stripContextBlock(harness.sendMessageCalls[0]?.text),
        '[ctx]\n\n[New message]\nfirst'
    )
    assert.equal(
        stripContextBlock(harness.sendMessageCalls[1]?.text),
        '[ctx]\n\n[New message]\nsecond'
    )
    assert.equal(harness.fakeProvider.historyFetches.length, 2)
})

test('bridge invokes backfill on replayed events and preserves threadFresh', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = '[ctx]'
    seedInboundDelivery(harness, {
        providerEventId: 'evt-replay-bf',
        eventJson: groupMention({
            providerEventId: 'evt-replay-bf',
            threadId: 'thread-9',
            threadFresh: true
        }) as unknown as Record<string, unknown>
    })

    const promise = harness.bridge.replayRecoverableInboundEvents()
    await harness.flushAdapter('replayed')
    const replayed = await promise

    assert.equal(replayed, 1)
    assert.equal(harness.fakeProvider.historyFetches.length, 1)
    assert.equal(harness.fakeProvider.historyFetches[0]?.threadFresh, true)
})

// --- history backfill attachments (issue #545) ---

const histAttachment = (overrides: Record<string, unknown> = {}) => ({
    url: `${CDN}/hist.png`,
    name: 'hist.png',
    contentType: 'image/png',
    size: 8,
    authorName: 'zack',
    providerMessageId: '123',
    ...overrides
})

const HIST_LABEL = '[historical attachment from zack, message 123: hist.png]'

test('bridge materializes history backfill attachments into the turn', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n[zack] look at this\n${HIST_LABEL}`,
        attachments: [histAttachment()]
    }

    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/hist.png', method: 'GET' })
                .reply(200, Buffer.from('histbytes'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention()
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.equal(harness.ingestCalls.length, 1)
    assert.equal(harness.ingestCalls[0]?.files.length, 1)
    assert.equal(harness.ingestCalls[0]?.files[0]?.name, 'hist.png')
    assert.equal(
        harness.ingestCalls[0]?.files[0]?.bytes.toString(),
        'histbytes'
    )
    const call = harness.sendMessageCalls[0]
    assert.equal(call?.attachments.length, 1)
    const text = stripContextBlock(call?.text)
    assert.ok(text.includes(HIST_LABEL))
    assert.doesNotMatch(text, /unavailable/)
    assert.match(text, /\[New message\]\nhello bot/)
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    assert.ok(
        !captures.some((c) => c.kind === 'final' && c.text.startsWith('⚠')),
        'no user-facing notice when only history attachments are in play'
    )
})

test('bridge places triggering attachments ahead of history attachments', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n${HIST_LABEL}`,
        attachments: [histAttachment()]
    }

    await withCdnMock(
        (pool) => {
            pool.intercept({ path: '/pic.png', method: 'GET' }).reply(
                200,
                Buffer.from('trigger'),
                { headers: { 'content-type': 'image/png' } }
            )
            pool.intercept({ path: '/hist.png', method: 'GET' }).reply(
                200,
                Buffer.from('hist'),
                { headers: { 'content-type': 'image/png' } }
            )
        },
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention({ attachments: [cdnAttachment()] })
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.deepEqual(
        harness.ingestCalls[0]?.files.map((f) => f.name),
        ['pic.png', 'hist.png']
    )
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 2)
})

test('bridge caps history attachments at four slots and marks the overflow unavailable', async () => {
    const harness = makeHarness()
    const atts = [1, 2, 3, 4, 5].map((i) =>
        histAttachment({
            url: `${CDN}/h${i}.png`,
            name: `h${i}.png`,
            providerMessageId: String(i)
        })
    )
    const labels = atts.map(
        (a) =>
            `[historical attachment from zack, message ${a.providerMessageId}: ${a.name}]`
    )
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n${labels.join('\n')}`,
        attachments: atts
    }

    await withCdnMock(
        (pool) => {
            for (let i = 1; i <= 5; i += 1)
                pool.intercept({ path: `/h${i}.png`, method: 'GET' }).reply(
                    200,
                    Buffer.from('x'),
                    { headers: { 'content-type': 'image/png' } }
                )
        },
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention()
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.deepEqual(
        harness.ingestCalls[0]?.files.map((f) => f.name),
        ['h1.png', 'h2.png', 'h3.png', 'h4.png']
    )
    const text = stripContextBlock(harness.sendMessageCalls[0]?.text)
    for (let i = 1; i <= 4; i += 1)
        assert.doesNotMatch(text, new RegExp(`h${i}\\.png — unavailable`))
    assert.match(
        text,
        /\[historical attachment from zack, message 5: h5\.png — unavailable\]/
    )
})

test('bridge dedupes a history attachment already on the triggering message', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n[historical attachment from zack, message 123: pic.png]`,
        attachments: [
            histAttachment({ url: `${CDN}/pic.png`, name: 'pic.png' })
        ]
    }

    await withCdnMock(
        // Single non-persistent intercept: a second download attempt for the
        // same URL would fail and flip the label to unavailable.
        (pool) =>
            pool
                .intercept({ path: '/pic.png', method: 'GET' })
                .reply(200, Buffer.from('img'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention({ attachments: [cdnAttachment()] })
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.equal(harness.ingestCalls[0]?.files.length, 1)
    const text = stripContextBlock(harness.sendMessageCalls[0]?.text)
    assert.doesNotMatch(text, /unavailable/)
})

test('bridge keeps the turn and labels the file unavailable when a history download fails', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n[zack] context\n${HIST_LABEL}`,
        attachments: [histAttachment()]
    }

    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/hist.png', method: 'GET' })
                .reply(404, 'gone'),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention()
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
    const text = stripContextBlock(harness.sendMessageCalls[0]?.text)
    assert.match(
        text,
        /\[historical attachment from zack, message 123: hist\.png — unavailable\]/
    )
    assert.match(text, /\[zack\] context/)
    assert.match(text, /\[New message\]\nhello bot/)
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    assert.ok(
        !captures.some((c) => c.kind === 'final' && c.text.startsWith('⚠')),
        'a history-only failure must not message the user'
    )
    const inbound = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(inbound?.status, 'accepted')
})

test('bridge marks history attachments unavailable without a notice when the framework lacks support', async () => {
    const harness = makeHarness()
    harness.apiFilesHook.supportsAttachments = async () => false
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n${HIST_LABEL}`,
        attachments: [histAttachment()]
    }

    let fetched = false
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/hist.png', method: 'GET' })
                .reply(200, () => {
                    fetched = true
                    return Buffer.from('x')
                }),
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention()
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.equal(fetched, false)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 0)
    const text = stripContextBlock(harness.sendMessageCalls[0]?.text)
    assert.match(text, /hist\.png — unavailable\]/)
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    assert.ok(
        !captures.some((c) => c.kind === 'final' && c.text.startsWith('⚠')),
        'the capability notice is reserved for the triggering message'
    )
})

test('bridge still notifies when the triggering attachment fails but history materialized', async () => {
    const harness = makeHarness()
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n${HIST_LABEL}`,
        attachments: [histAttachment()]
    }

    await withCdnMock(
        (pool) => {
            pool.intercept({ path: '/pic.png', method: 'GET' }).reply(
                404,
                'gone'
            )
            pool.intercept({ path: '/hist.png', method: 'GET' }).reply(
                200,
                Buffer.from('hist'),
                { headers: { 'content-type': 'image/png' } }
            )
        },
        async () => {
            const promise = harness.bridge.handleInbound(
                baseChannel,
                groupMention({ attachments: [cdnAttachment()] })
            )
            await harness.flushAdapter('answer')
            await promise
        }
    )

    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 1)
    const captures = harness.fakeProvider.drainOutbound(baseChannel.id)
    const notice = captures.find(
        (c) => c.kind === 'final' && c.text.includes('could not be processed')
    )
    assert.ok(
        notice?.kind === 'final',
        'expected a notice about the triggering attachment'
    )
    // "text only" would misstate the turn: the history attachment made it in.
    assert.match(notice!.text, /continuing without them/)
    const text = stripContextBlock(harness.sendMessageCalls[0]?.text)
    assert.doesNotMatch(text, /unavailable/)
})

test('bridge defers history attachment downloads for queued turns to the drain', async () => {
    const harness = makeHarness({ queueScenario: true })
    harness.fakeProvider.historyContextResult = {
        text: `[Recent channel messages]\n${HIST_LABEL}`,
        attachments: [histAttachment()]
    }

    let fetches = 0
    let fetchesWhenQueued = -1
    await withCdnMock(
        (pool) =>
            pool
                .intercept({ path: '/hist.png', method: 'GET' })
                .reply(
                    200,
                    () => {
                        fetches += 1
                        return Buffer.from('hist')
                    },
                    { headers: { 'content-type': 'image/png' } }
                )
                .persist(),
        async () => {
            const pA = harness.bridge.handleInbound(
                baseChannel,
                groupMention({ providerEventId: 'evt-a', text: 'first' })
            )
            for (
                let i = 0;
                i < 10 && harness.sendMessageCalls.length < 1;
                i += 1
            )
                await flushMicrotasks()
            const pB = harness.bridge.handleInbound(
                baseChannel,
                groupMention({ providerEventId: 'evt-b', text: 'second' })
            )
            await pB
            fetchesWhenQueued = fetches

            await harness.flushAdapter('answer to first')
            await pA
            for (
                let i = 0;
                i < 30 && harness.sendMessageCalls.length < 2;
                i += 1
            )
                await flushMicrotasks()
            await harness.flushAdapter('answer to second')
        }
    )

    // The queued attempt must not download history attachments; the drain's
    // re-run fetches fresh history and materializes then.
    assert.equal(fetchesWhenQueued, 1)
    assert.equal(fetches, 2)
    assert.equal(harness.sendMessageCalls.length, 2)
    assert.equal(harness.sendMessageCalls[0]?.attachments.length, 1)
    assert.equal(harness.sendMessageCalls[1]?.attachments.length, 1)
})

test('bridge marks slash and queue replies non-conversational', async () => {
    const harness = makeHarness({ queueScenario: true })

    const pA = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-a', text: 'first' })
    )
    for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
        await flushMicrotasks()
    const pB = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-b', text: 'second' })
    )
    await pB

    const queuedNotice = harness.fakeProvider
        .drainOutbound(baseChannel.id)
        .find((c) => c.kind === 'final')
    assert.equal(
        (queuedNotice as { nonConversational?: boolean }).nonConversational,
        true
    )

    await harness.flushAdapter('answer to first')
    await pA
})

test('permanent send errors dead-letter immediately instead of retrying', async () => {
    const harness = makeHarness()
    harness.fakeProvider.sendPreviewStart = async () => {
        throw new Error('no preview')
    }
    harness.fakeProvider.sendText = async () => {
        throw new ChannelSendError('forbidden', 'bot was blocked by the user')
    }

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('final text')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'dead')
    assert.equal(outbound?.nextAttemptAt, null)
    assert.match(outbound?.errorMessage ?? '', /blocked/)
})

test('rate-limited send failures reschedule with the platform retry hint', async () => {
    const harness = makeHarness()
    harness.fakeProvider.sendPreviewStart = async () => {
        throw new Error('no preview')
    }
    harness.fakeProvider.sendText = async () => {
        throw new ChannelSendError('rate_limited', 'slow down', {
            retryAfterMs: 120_000
        })
    }
    const before = Date.now()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('final text')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'failed')
    const nextAt = outbound?.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= before + 119_000, 'waits the platform-requested time')
    assert.ok(nextAt <= Date.now() + 121_000, 'not longer than requested')
})

test('sweep dead-letters a permanent failure with attempts remaining', async () => {
    const harness = makeHarness()
    harness.fakeProvider.sendText = async () => {
        throw new ChannelSendError('not_found', 'chat not found')
    }
    const row = seedOutboundDelivery(harness)

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 0)
    assert.equal(row.status, 'dead')
    assert.equal(row.attemptCount, 2)
    assert.equal(row.nextAttemptAt, null)
})

test('sweep honors retry_after when rescheduling a rate-limited retry', async () => {
    const harness = makeHarness()
    harness.fakeProvider.sendText = async () => {
        throw new ChannelSendError('rate_limited', 'flood', {
            retryAfterMs: 300_000
        })
    }
    const before = Date.now()
    const row = seedOutboundDelivery(harness)

    await harness.bridge.sweepOutboundDeliveries()
    assert.equal(row.status, 'failed')
    const nextAt = row.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= before + 299_000)
    assert.ok(nextAt <= Date.now() + 301_000)
})

test('sweep reconciles an interrupted send instead of duplicating it', async () => {
    const harness = makeHarness()
    ;(
        harness.fakeProvider as FakeChannelProvider & {
            reconcileSend: NonNullable<
                import('../src/modules/channels/channel-provider').ChannelProvider['reconcileSend']
            >
        }
    ).reconcileSend = async () => ({
        outcome: 'sent' as const,
        providerMessageId: 'R1'
    })
    const row = seedOutboundDelivery(harness, {
        status: 'queued',
        sendAttemptStartedAt: new Date(Date.now() - 60_000)
    })

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    assert.equal(row.providerMessageId, 'R1')
    assert.equal(row.sendAttemptStartedAt, null)
    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(finals.length, 0, 'reconciled rows are never re-sent')
})

test('sweep re-sends when reconcile says the interrupted send never landed', async () => {
    const harness = makeHarness()
    ;(
        harness.fakeProvider as FakeChannelProvider & {
            reconcileSend: NonNullable<
                import('../src/modules/channels/channel-provider').ChannelProvider['reconcileSend']
            >
        }
    ).reconcileSend = async () => ({
        outcome: 'not_sent' as const
    })
    const row = seedOutboundDelivery(harness, {
        status: 'queued',
        sendAttemptStartedAt: new Date(Date.now() - 60_000)
    })

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    assert.equal(row.sendAttemptStartedAt, null)
    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
})

test('sweep retries an interrupted send when the provider cannot reconcile', async () => {
    const harness = makeHarness()
    const row = seedOutboundDelivery(harness, {
        status: 'queued',
        sendAttemptStartedAt: new Date(Date.now() - 60_000)
    })

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    assert.equal(row.sendAttemptStartedAt, null)
    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1, 'duplicate-risk retry still delivers')
})

test('inline finalize clears the send-attempt marker once the send lands', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
    assert.equal(outbound?.sendAttemptStartedAt, null)
})

test('the planned turn id is persisted before the turn and keyed end to end', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    const inbound = harness.deliveries.find((d) => d.direction === 'inbound')
    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.ok(inbound?.turnMessageId, 'planned id recorded on the inbound row')
    assert.equal(
        inbound?.turnMessageId,
        harness.sendMessageCalls[0]?.assistantMessageId,
        'the turn runs under the pre-recorded id'
    )
    assert.equal(outbound?.chatMessageId, inbound?.turnMessageId)
})

test('losing the turn slot clears the planned turn id', async () => {
    const harness = makeHarness({ inflight: true })

    await harness.bridge.handleInbound(baseChannel, inboundEvent())

    const inbound = harness.deliveries.find((d) => d.direction === 'inbound')
    assert.equal(inbound?.status, 'queued')
    assert.equal(inbound?.turnMessageId, null)
})

const seedAdoptableInbound = (
    harness: Harness,
    turnMessageId: string
): ChannelDeliveryRow => {
    const event = inboundEvent({ providerEventId: 'evt-crash' })
    const row: ChannelDeliveryRow = {
        id: BigInt(harness.deliveries.length + 1),
        channelId: baseChannel.id,
        chatSessionId: 'sess-1',
        chatMessageId: null,
        direction: 'inbound',
        scopeKey: 'fake:chat-1:user-remote',
        providerEventId: event.providerEventId,
        providerMessageId: event.providerEventId,
        eventJson: event as unknown as Record<string, unknown>,
        summaryText: event.text,
        status: 'queued',
        errorMessage: null,
        attemptCount: 1,
        sendAttemptStartedAt: null,
        turnMessageId,
        nextAttemptAt: null,
        createdAt: new Date(Date.now() - 6 * 60_000),
        updatedAt: new Date(Date.now() - 6 * 60_000),
        ...{}
    }
    harness.deliveries.push(row)
    return row
}

test('a replayed inbound whose turn already exists adopts it instead of re-running', async () => {
    const harness = makeHarness()
    harness.turnOutcomes.set('turn-crashed', {
        state: 'done',
        text: 'late answer'
    })
    const row = seedAdoptableInbound(harness, 'turn-crashed')

    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-crash' }),
        { delivery: row, created: true }
    )

    assert.equal(
        harness.sendMessageCalls.length,
        0,
        'no second turn for the same message'
    )
    assert.equal(row.status, 'accepted')
    assert.equal(row.errorMessage, 'turn_adopted')
    const pending = harness.deliveries.find(
        (d) => d.direction === 'outbound' && d.chatMessageId === 'turn-crashed'
    )
    assert.equal(pending?.status, 'pending')
})

test('adoption reuses an existing reply expectation instead of adding one', async () => {
    const harness = makeHarness()
    harness.turnOutcomes.set('turn-crashed', { state: 'running' })
    seedOutboundDelivery(harness, {
        chatMessageId: 'turn-crashed',
        status: 'sent',
        nextAttemptAt: null
    })
    const row = seedAdoptableInbound(harness, 'turn-crashed')

    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-crash' }),
        { delivery: row, created: true }
    )

    assert.equal(row.status, 'accepted')
    assert.equal(
        harness.deliveries.filter(
            (d) =>
                d.direction === 'outbound' && d.chatMessageId === 'turn-crashed'
        ).length,
        1,
        'no duplicate reply-expectation row'
    )
})

test('adoption under agentManagedReply settles the row without a reply expectation', async () => {
    const harness = makeHarness()
    const channel: ChannelRow = {
        ...baseChannel,
        configJson: { note: null, agentManagedReply: true }
    }
    harness.turnOutcomes.set('turn-crashed', {
        state: 'done',
        text: 'late answer'
    })
    const row = seedAdoptableInbound(harness, 'turn-crashed')

    await harness.bridge.handleInbound(
        channel,
        inboundEvent({ providerEventId: 'evt-crash' }),
        { delivery: row, created: true }
    )

    assert.equal(harness.sendMessageCalls.length, 0)
    assert.equal(row.status, 'accepted')
    assert.equal(row.errorMessage, 'turn_adopted')
    assert.equal(
        harness.deliveries.filter((d) => d.direction === 'outbound').length,
        0,
        'crash-replay adoption must not resurrect the Manyfold delivery the flag suppressed'
    )
})

test('a recorded turn id whose turn never materialized falls through to a fresh turn', async () => {
    const harness = makeHarness()
    harness.turnOutcomes.set('turn-ghost', { state: 'missing' })
    const row = seedAdoptableInbound(harness, 'turn-ghost')

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-crash' }),
        { delivery: row, created: true }
    )
    await harness.flushAdapter('fresh answer')
    await promise

    assert.equal(harness.sendMessageCalls.length, 1)
    assert.equal(row.status, 'accepted')
    assert.notEqual(row.turnMessageId, 'turn-ghost')
})

test('drain collects queued messages into one turn with a merged prompt', async () => {
    const harness = makeHarness({ queueScenario: true })

    const pA = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-a', text: 'first' })
    )
    for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
        await flushMicrotasks()
    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-b', text: 'second' })
    )
    await harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ providerEventId: 'evt-c', text: 'third' })
    )

    await harness.flushAdapter('answer to first')
    await pA
    for (let i = 0; i < 30 && harness.sendMessageCalls.length < 2; i += 1)
        await flushMicrotasks()

    assert.equal(
        harness.sendMessageCalls.length,
        2,
        'both queued messages run as ONE merged turn'
    )
    const mergedText = stripContextBlock(harness.sendMessageCalls[1]?.text)
    assert.match(
        mergedText,
        /^\[2 messages arrived while a turn was running — answering together\]/
    )
    assert.match(mergedText, /1\. second\n2\. third/)

    const bRow = harness.deliveries.find((d) => d.providerEventId === 'evt-b')
    assert.equal(bRow?.status, 'accepted')
    assert.match(bRow?.errorMessage ?? '', /^merged_into:/)

    await harness.flushAdapter('answer to merged')
    const cRow = harness.deliveries.find((d) => d.providerEventId === 'evt-c')
    assert.equal(cRow?.status, 'accepted')
})

test('MF_CHANNEL_QUEUE_COLLECT=0 restores one turn per queued message', async () => {
    const original = process.env.MF_CHANNEL_QUEUE_COLLECT
    process.env.MF_CHANNEL_QUEUE_COLLECT = '0'
    try {
        const harness = makeHarness({ queueScenario: true })

        const pA = harness.bridge.handleInbound(
            baseChannel,
            inboundEvent({ providerEventId: 'evt-a', text: 'first' })
        )
        for (let i = 0; i < 10 && harness.sendMessageCalls.length < 1; i += 1)
            await flushMicrotasks()
        await harness.bridge.handleInbound(
            baseChannel,
            inboundEvent({ providerEventId: 'evt-b', text: 'second' })
        )
        await harness.bridge.handleInbound(
            baseChannel,
            inboundEvent({ providerEventId: 'evt-c', text: 'third' })
        )

        await harness.flushAdapter('answer to first')
        await pA
        for (let i = 0; i < 30 && harness.sendMessageCalls.length < 2; i += 1)
            await flushMicrotasks()

        assert.equal(harness.sendMessageCalls.length, 2)
        assert.equal(
            stripContextBlock(harness.sendMessageCalls[1]?.text),
            'second',
            'sequential mode replays messages one at a time'
        )
    } finally {
        if (original === undefined) delete process.env.MF_CHANNEL_QUEUE_COLLECT
        else process.env.MF_CHANNEL_QUEUE_COLLECT = original
    }
})

test('provider-declared preview interval overrides the bridge default', async () => {
    const harness = makeHarness()
    harness.fakeProvider.previewUpdateMinIntervalMs = 0
    try {
        const promise = harness.bridge.handleInbound(
            baseChannel,
            inboundEvent()
        )
        await harness.pumpTokens(['one ', 'two ', 'three '])
        await harness.flushAdapter('one two three done')
        await promise

        const updates = harness.fakeProvider
            .drainOutbound('chn-1')
            .filter((c) => c.kind === 'preview-update')
        assert.ok(
            updates.length >= 3,
            `zero interval flushes every token, got ${updates.length}`
        )
    } finally {
        harness.fakeProvider.previewUpdateMinIntervalMs = undefined
    }
})

test('three consecutive preview failures disable updates for the turn', async () => {
    const harness = makeHarness()
    harness.fakeProvider.previewUpdateMinIntervalMs = 0
    let attempts = 0
    harness.fakeProvider.updatePreview = async () => {
        attempts += 1
        throw new Error('edit rejected')
    }
    try {
        const promise = harness.bridge.handleInbound(
            baseChannel,
            inboundEvent()
        )
        await harness.pumpTokens(['a', 'b', 'c', 'd', 'e'])
        await harness.flushAdapter('abcde')
        await promise

        assert.equal(attempts, 3, 'updates stop after the strike limit')
        const captures = harness.fakeProvider.drainOutbound('chn-1')
        assert.ok(
            captures.some((c) => c.kind === 'preview-finish'),
            'the final reply still lands on the preview'
        )
        const outbound = harness.deliveries.find(
            (d) => d.direction === 'outbound'
        )
        assert.equal(outbound?.status, 'sent')
    } finally {
        harness.fakeProvider.previewUpdateMinIntervalMs = undefined
    }
})

test('ack reactions mark the triggering message working then done', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ messageId: 'pm-1' })
    )
    await harness.flushAdapter('answer')
    await promise
    await flushMicrotasks()

    const reactions = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'reaction')
    assert.deepEqual(
        reactions.map((r) => (r as { state: string }).state),
        ['working', 'done']
    )
    assert.equal((reactions[0] as { id: string }).id, 'pm-1')
})

test('a failed turn flips the ack reaction to failed', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        baseChannel,
        inboundEvent({ messageId: 'pm-2' })
    )
    await harness.flushAdapterWith([
        {
            type: 'error',
            error: { code: 'boom', message: 'agent exploded', retryable: false }
        }
    ])
    await promise
    await flushMicrotasks()

    const states = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'reaction')
        .map((r) => (r as { state: string }).state)
    assert.deepEqual(states, ['working', 'failed'])
})

test('MF_CHANNEL_ACK_REACTIONS=0 disables reactions; missing messageId skips them', async () => {
    const original = process.env.MF_CHANNEL_ACK_REACTIONS
    process.env.MF_CHANNEL_ACK_REACTIONS = '0'
    try {
        const harness = makeHarness()
        const promise = harness.bridge.handleInbound(
            baseChannel,
            inboundEvent({ messageId: 'pm-3' })
        )
        await harness.flushAdapter('answer')
        await promise
        assert.equal(
            harness.fakeProvider
                .drainOutbound('chn-1')
                .filter((c) => c.kind === 'reaction').length,
            0
        )
    } finally {
        if (original === undefined) delete process.env.MF_CHANNEL_ACK_REACTIONS
        else process.env.MF_CHANNEL_ACK_REACTIONS = original
    }

    const bare = makeHarness()
    const promise = bare.bridge.handleInbound(baseChannel, inboundEvent())
    await bare.flushAdapter('answer')
    await promise
    assert.equal(
        bare.fakeProvider
            .drainOutbound('chn-1')
            .filter((c) => c.kind === 'reaction').length,
        0,
        'no provider message id — nothing to react to'
    )
})

// Terminal disposition: Linear derives its session state from the activity type
// it receives, so a reply that concludes a turn must say how the turn ended.
// Providers that ignore the hint must see byte-identical behavior.
const finalModeChannel: ChannelRow = {
    ...baseChannel,
    configJson: { note: null, progressMode: 'final' }
}

const terminalOf = (capture: unknown): unknown =>
    (capture as { terminal?: unknown }).terminal

test('successful terminal carries terminal=final to the provider', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        finalModeChannel,
        inboundEvent()
    )
    await harness.flushAdapter('all done')
    await promise

    const final = harness.fakeProvider
        .drainOutbound('chn-1')
        .find((c) => c.kind === 'final')
    assert.equal(terminalOf(final), 'final')
    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(
        (outbound?.eventJson as { terminal?: unknown })?.terminal,
        'final',
        'persisted so a swept retry keeps the disposition'
    )
})

test('failed terminal carries terminal=error to the provider', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        finalModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        { type: 'error', error: { message: 'sprite exploded' } }
    ])
    await promise

    const final = harness.fakeProvider
        .drainOutbound('chn-1')
        .find((c) => c.kind === 'final')
    assert.match((final as { text: string }).text, /agent failed/)
    assert.equal(terminalOf(final), 'error')
})

test('cancelled terminal carries terminal=cancelled to the provider', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        finalModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterCancelled()
    await promise

    const final = harness.fakeProvider
        .drainOutbound('chn-1')
        .find((c) => c.kind === 'final')
    assert.match((final as { text: string }).text, /response cancelled/i)
    assert.equal(
        terminalOf(final),
        'cancelled',
        'a stop confirmation is not a failure'
    )
})

test('sweep retry replays the persisted terminal', async () => {
    const harness = makeHarness()
    seedOutboundDelivery(harness, {
        eventJson: { text: 'retry me', terminal: 'final' }
    })

    await harness.bridge.sweepOutboundDeliveries()

    const final = harness.fakeProvider
        .drainOutbound('chn-1')
        .find((c) => c.kind === 'final')
    assert.equal(terminalOf(final), 'final')
})

test('sweep retry of a legacy row without terminal still delivers', async () => {
    const harness = makeHarness()
    const row = seedOutboundDelivery(harness)

    const delivered = await harness.bridge.sweepOutboundDeliveries()
    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')

    const final = harness.fakeProvider
        .drainOutbound('chn-1')
        .find((c) => c.kind === 'final')
    assert.equal(terminalOf(final), null, 'absent hint, not a crash')
})

test('reconcile persists the terminal it derived from the turn outcome', async () => {
    const cancelled = makeHarness()
    const cancelledRow = seedPendingOutbound(cancelled)
    cancelled.turnOutcomes.set(cancelledRow.chatMessageId ?? '', {
        state: 'error',
        errorMessage: 'cancelled by user',
        cancelled: true
    })
    assert.equal(await cancelled.bridge.reconcilePendingReplies(), 1)
    assert.equal(
        (cancelledRow.eventJson as { terminal?: unknown })?.terminal,
        'cancelled'
    )

    const failed = makeHarness()
    const failedRow = seedPendingOutbound(failed)
    failed.turnOutcomes.set(failedRow.chatMessageId ?? '', {
        state: 'error',
        errorMessage: 'sprite exploded',
        cancelled: false
    })
    assert.equal(await failed.bridge.reconcilePendingReplies(), 1)
    assert.equal(
        (failedRow.eventJson as { terminal?: unknown })?.terminal,
        'error'
    )
})

test('non-terminal sends carry no terminal hint', async () => {
    const harness = makeHarness({ inflight: true })

    await harness.bridge.handleInbound(
        finalModeChannel,
        inboundEvent({ text: 'queue me' })
    )

    const finals = harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'final')
    assert.equal(finals.length, 1)
    assert.match((finals[0] as { text: string }).text, /Queued/)
    assert.equal(
        terminalOf(finals[0]),
        null,
        'a queue notice must not terminalize the platform conversation'
    )
})

// Turn event tap: providers whose platform renders progress as structured
// entities (Linear's action activities, its session plan) get the raw turn
// events instead of an edited preview message. A provider without the hook must
// be completely unaffected.
const activityModeChannel: ChannelRow = {
    ...baseChannel,
    configJson: { note: null, progressMode: 'activity' }
}

const turnEventsOf = (harness: Harness): OutboundCapture[] =>
    harness.fakeProvider
        .drainOutbound('chn-1')
        .filter((c) => c.kind === 'turn-event')

test('a provider without the turn tap sees no change', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(
        activityModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        { type: 'thinking', text: 'pondering' },
        { type: 'tool_call', toolCallId: 't1', toolName: 'Bash', args: {} },
        { type: 'tool_result', toolCallId: 't1', result: 'ok' }
    ])
    await promise

    const kinds = harness.fakeProvider.drainOutbound('chn-1').map((c) => c.kind)
    assert.ok(!kinds.includes('turn-event'))
    assert.ok(
        kinds.includes('preview-finish'),
        'the turn still delivers exactly as before'
    )
})

test('the turn tap receives progress events in order with session ids', async () => {
    const harness = makeHarness()
    harness.fakeProvider.enableTurnEventCapture()

    const promise = harness.bridge.handleInbound(
        activityModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        { type: 'thinking', text: 'pondering' },
        {
            type: 'tool_call',
            toolCallId: 't1',
            toolName: 'Bash',
            args: { cmd: 'ls' }
        },
        { type: 'tool_result', toolCallId: 't1', result: 'ok' }
    ])
    await promise

    const captures = turnEventsOf(harness)
    assert.deepEqual(
        captures.map((c) => (c as { event: { type: string } }).event.type),
        ['thinking', 'tool_call', 'tool_result'],
        'tool_result has no branch of its own in the observer — it must still arrive'
    )
    const first = captures[0] as {
        chatSessionId: string
        channelSessionId: string
        scopeKey: string
    }
    // The ids must be the turn's own, so a provider can deep-link the session.
    assert.equal(
        first.chatSessionId,
        harness.deliveries.find((d) => d.direction === 'outbound')
            ?.chatSessionId
    )
    assert.ok(first.channelSessionId)
    assert.equal(first.scopeKey, 'fake:chat-1:user-remote')
})

test('the turn tap stays silent in final progress mode', async () => {
    const harness = makeHarness()
    harness.fakeProvider.enableTurnEventCapture()

    const promise = harness.bridge.handleInbound(
        finalModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([{ type: 'thinking', text: 'pondering' }])
    await promise

    assert.equal(turnEventsOf(harness).length, 0)
})

test('the terminal reply waits for a queued projection', async () => {
    const harness = makeHarness()
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    harness.fakeProvider.enableTurnEventCapture({ gate: () => gate })

    const promise = harness.bridge.handleInbound(
        activityModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        { type: 'tool_call', toolCallId: 't1', toolName: 'Bash', args: {} }
    ])

    // The projection is still in flight, so the reply must not have landed: on
    // Linear an action arriving after the response reopens a closed session.
    assert.equal(
        harness.deliveries.find((d) => d.direction === 'outbound')?.status,
        'pending'
    )
    const releaseGate = release as (() => void) | null
    releaseGate?.()
    await promise

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const tapIdx = captures.findIndex((c) => c.kind === 'turn-event')
    const finishIdx = captures.findIndex((c) => c.kind === 'preview-finish')
    assert.ok(tapIdx !== -1 && finishIdx !== -1)
    assert.ok(tapIdx < finishIdx, 'projection first, then the reply')
})

test('a failing projection never costs the reply', async () => {
    const harness = makeHarness()
    harness.fakeProvider.onTurnEvent = async () => {
        throw new Error('linear rejected the activity')
    }

    const promise = harness.bridge.handleInbound(
        activityModeChannel,
        inboundEvent()
    )
    await harness.flushAdapterWith([
        { type: 'tool_call', toolCallId: 't1', toolName: 'Bash', args: {} }
    ])
    await promise

    const outbound = harness.deliveries.find((d) => d.direction === 'outbound')
    assert.equal(outbound?.status, 'sent')
})

test('the turn tap ignores events after the turn is settled', async () => {
    const harness = makeHarness()
    harness.fakeProvider.enableTurnEventCapture()

    const promise = harness.bridge.handleInbound(
        activityModeChannel,
        inboundEvent()
    )
    await harness.flushAdapter('done')
    await promise
    harness.fakeProvider.drainOutbound('chn-1')

    harness.emitToObserver({
        type: 'tool_call',
        toolCallId: 'late',
        toolName: 'Bash',
        args: {}
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(turnEventsOf(harness).length, 0)
})

test('startTyping learns the chat session for a session deep link', async () => {
    const harness = makeHarness()

    const promise = harness.bridge.handleInbound(baseChannel, inboundEvent())
    await harness.flushAdapter('answer')
    await promise

    const typing = harness.fakeProvider
        .drainOutbound('chn-1')
        .find((c) => c.kind === 'typing-start')
    assert.equal(
        (typing as { chatSessionId?: string | null }).chatSessionId,
        harness.deliveries.find((d) => d.direction === 'outbound')
            ?.chatSessionId
    )
})
