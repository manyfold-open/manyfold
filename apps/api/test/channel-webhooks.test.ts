import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelDeliveryRow, ChannelRow } from '@manyfold/db'
import { ChannelWebhooksController } from '../src/modules/channels/channel-webhooks.controller'
import { ChannelProviderRegistry } from '../src/modules/channels/channel-provider-registry.service'
import { FakeChannelProvider } from '../src/modules/channels/providers/fake.provider'
import type { NormalizedInboundEvent } from '../src/modules/channels/channel-provider'

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

test('webhook rejects paused channels before bridge dispatch', async () => {
    const harness = makeHarness({ ...baseChannel, status: 'paused' })

    await assert.rejects(
        () =>
            harness.controller.receive(
                'fake',
                baseChannel.id,
                {},
                { text: 'hi', chatId: 'chat-1', senderId: 'user-1' },
                {} as never
            ),
        /channel is paused/
    )
    assert.equal(harness.bridgeCalls.length, 0)
})

test('webhook rejects draft channels for non-verification events', async () => {
    const harness = makeHarness({ ...baseChannel, status: 'draft' })

    await assert.rejects(
        () =>
            harness.controller.receive(
                'fake',
                baseChannel.id,
                {},
                { text: 'hi', chatId: 'chat-1', senderId: 'user-1' },
                {} as never
            ),
        /channel is draft/
    )
    assert.equal(harness.bridgeCalls.length, 0)
})

test('webhook records inbound delivery before bridge dispatch', async () => {
    const harness = makeHarness(baseChannel)

    const result = await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        {
            eventId: 'evt-webhook-1',
            text: 'hi',
            chatId: 'chat-1',
            senderId: 'user-1'
        },
        {} as never
    )

    assert.deepEqual(result, { ok: true })
    assert.equal(harness.deliveries.length, 1)
    assert.equal(harness.deliveries[0]?.status, 'queued')
    assert.equal(harness.deliveries[0]?.providerEventId, 'evt-webhook-1')
    assert.equal(harness.bridgeCalls.length, 1)
    assert.equal(harness.bridgeCalls[0]?.providerEventId, 'evt-webhook-1')
})

test('webhook duplicate provider event does not dispatch twice', async () => {
    const harness = makeHarness(baseChannel)
    const body = {
        eventId: 'evt-webhook-duplicate',
        text: 'hi',
        chatId: 'chat-1',
        senderId: 'user-1'
    }

    await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        body,
        {} as never
    )
    const second = await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        body,
        {} as never
    )

    assert.deepEqual(second, { ok: true, duplicate: true })
    assert.equal(harness.deliveries.length, 1)
    assert.equal(harness.bridgeCalls.length, 1)
})

test('webhook returns the provider ack body (empty slash 200) and dedupes it', async () => {
    const harness = makeHarness(baseChannel)
    const body = {
        eventId: 'evt-slash-1',
        text: '/new',
        chatId: 'chat-1',
        senderId: 'user-1',
        commandInvocation: true,
        ackResponse: ''
    }

    const first = await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        body,
        {} as never
    )
    const second = await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        body,
        {} as never
    )

    assert.equal(first, '')
    assert.equal(second, '')
    assert.equal(harness.bridgeCalls.length, 1)
})

test('silent unsupported events record no delivery row; non-silent record one', async () => {
    const harness = makeHarness(baseChannel)

    const silent = await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        { unsupported: 'assistant_thread_started', unsupportedSilent: true },
        {} as never
    )
    assert.deepEqual(silent, { ok: true, skipped: 'assistant_thread_started' })
    assert.equal(harness.insertedRows.length, 0)
    assert.equal(harness.bridgeCalls.length, 0)

    const loud = await harness.controller.receive(
        'fake',
        baseChannel.id,
        {},
        { unsupported: 'message_changed' },
        {} as never
    )
    assert.deepEqual(loud, { ok: true, skipped: 'message_changed' })
    assert.equal(harness.insertedRows.length, 1)
})

const makeHarness = (
    channel: ChannelRow,
    opts: { credentials?: { secret: string } | null } = {}
) => {
    const fakeProvider = new FakeChannelProvider()
    const providers = {
        get: () => fakeProvider
    } as unknown as ChannelProviderRegistry
    const bridgeCalls: NormalizedInboundEvent[] = []
    const deliveries: ChannelDeliveryRow[] = []
    const insertedRows: unknown[] = []

    const controller = new ChannelWebhooksController(
        {
            markConnected: async () => {}
        } as never,
        {
            isEnabled: () => true
        } as never,
        {
            buildContext: (row: ChannelRow) => ({
                channel: row,
                config: fakeProvider.validateConfig(row.configJson),
                credentials: opts.credentials ?? null
            }),
            handleInbound: async (
                _row: ChannelRow,
                event: NormalizedInboundEvent
            ) => {
                bridgeCalls.push(event)
            }
        } as never,
        providers,
        {
            getById: async (id: string) => (id === channel.id ? channel : null),
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
                if (existing) return { delivery: existing, created: false }
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
                    nextAttemptAt: null,
                    sendAttemptStartedAt: null,
                    turnMessageId: null,
                    createdAt: row.createdAt,
                    updatedAt: row.createdAt
                }
                deliveries.push(inserted)
                return { delivery: inserted, created: true }
            },
            insertDelivery: async (row: unknown) => {
                insertedRows.push(row)
                return row
            }
        } as never,
        {
            event: () => {}
        } as never
    )

    return { controller, bridgeCalls, deliveries, insertedRows }
}

test('signature failures record at most one delivery row per throttle window', async () => {
    const harness = makeHarness(baseChannel, {
        credentials: { secret: 'expected' }
    })
    const badRequest = () =>
        harness.controller.receive(
            'fake',
            baseChannel.id,
            { 'x-fake-secret': 'wrong' },
            { text: 'hi', chatId: 'chat-1', senderId: 'user-1' },
            {} as never
        )

    for (let i = 0; i < 3; i++)
        await assert.rejects(badRequest, /signature_mismatch/)

    assert.equal(
        harness.insertedRows.length,
        1,
        'a retry flood must not amplify into unbounded delivery rows'
    )
    assert.equal(harness.bridgeCalls.length, 0)
})
