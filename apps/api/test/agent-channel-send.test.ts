import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, HttpException } from '@nestjs/common'
import type { ChannelDeliveryRow, ChannelRow } from '@manyfold/db'
import { ChannelBridgeService } from '../src/modules/channels/channel-bridge.service'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import { ChannelSendRateLimitService } from '../src/modules/channels/channel-send-rate-limit.service'
import { AgentSelfChannelsController } from '../src/modules/channels/agent-self-channels.controller'
import { FakeChannelProvider } from '../src/modules/channels/providers/fake.provider'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'

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

interface SendHarness {
    bridge: ChannelBridgeService
    fakeProvider: FakeChannelProvider
    deliveries: ChannelDeliveryRow[]
    readCalls: Array<Array<{ relPath: string; name: string }>>
}

const makeSendHarness = (
    opts: {
        workspaceFiles?: Array<{
            name: string
            relPath: string
            contentType: string
            bytes: Buffer
        }>
        // sendAgentScoped requires a live session for the scope; false
        // simulates an archived/deleted conversation.
        activeSession?: boolean
    } = {}
): SendHarness => {
    const deliveries: ChannelDeliveryRow[] = []
    const fakeProvider = new FakeChannelProvider()
    const readCalls: Array<Array<{ relPath: string; name: string }>> = []
    const apiFiles = {
        readWorkspaceFiles: async (
            _agentId: string,
            refs: Array<{ relPath: string; name: string }>
        ) => {
            readCalls.push(refs)
            return (opts.workspaceFiles ?? []).filter((file) =>
                refs.some((ref) => ref.relPath === file.relPath)
            )
        }
    }
    const repo = {
        insertDelivery: async (
            row: Omit<ChannelDeliveryRow, 'id' | 'attemptCount' | 'updatedAt'>
        ): Promise<ChannelDeliveryRow> => {
            const inserted: ChannelDeliveryRow = {
                attemptCount: 0,
                ...row,
                id: BigInt(deliveries.length + 1),
                updatedAt: row.createdAt
            } as ChannelDeliveryRow
            deliveries.push(inserted)
            return { ...inserted }
        },
        updateDelivery: async (
            id: bigint,
            patch: Partial<ChannelDeliveryRow>
        ): Promise<void> => {
            const row = deliveries.find((d) => d.id === id)
            if (row) Object.assign(row, patch, { updatedAt: new Date() })
        },
        getById: async (id: string): Promise<ChannelRow | null> =>
            id === baseChannel.id ? baseChannel : null,
        listDueOutboundDeliveries: async (): Promise<ChannelDeliveryRow[]> =>
            deliveries.filter(
                (d) =>
                    d.direction === 'outbound' &&
                    (d.status === 'queued' || d.status === 'failed') &&
                    d.nextAttemptAt !== null
            ),
        claimOutboundDelivery: async (
            id: bigint
        ): Promise<ChannelDeliveryRow | null> => {
            const row = deliveries.find((d) => d.id === id)
            if (!row) return null
            row.status = 'processing'
            return { ...row }
        },
        findActiveSession: async (channelId: string, scopeKey: string) =>
            opts.activeSession === false
                ? null
                : { id: 'chs-1', channelId, scopeKey, isActive: true }
    }
    const providers = {
        get: (name: string) => {
            if (name !== 'fake') throw new Error(`unknown provider ${name}`)
            return fakeProvider
        }
    }
    const bridge = new ChannelBridgeService(
        repo as never,
        {} as never,
        {} as never,
        providers as never,
        { decrypt: () => '{}' } as never,
        { event: () => undefined, error: () => undefined } as never,
        {} as never,
        apiFiles as never
    )
    return { bridge, fakeProvider, deliveries, readCalls }
}

test('sendAgentDirect delivers inline and records the sent delivery', async () => {
    const harness = makeSendHarness()
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'user', userId: 'ou_member' },
        'daily report time'
    )

    assert.equal(result.status, 'sent')
    assert.ok(result.providerMessageId)
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    assert.equal(row.direction, 'outbound')
    assert.equal(row.status, 'sent')
    assert.equal(row.providerMessageId, result.providerMessageId)
    assert.equal(row.scopeKey, 'agent-send:user:ou_member')
    assert.deepEqual(row.eventJson, {
        text: 'daily report time',
        target: { kind: 'user', userId: 'ou_member' }
    })

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.length, 1)
    assert.equal(captures[0]?.kind, 'direct')
})

test('sendAgentDirect leaves a retryable row when the provider send fails', async () => {
    const harness = makeSendHarness()
    harness.fakeProvider.sendDirectResult = () => {
        throw new Error('provider down')
    }
    const before = Date.now()
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'chat', chatId: 'oc_x' },
        'hello'
    )

    assert.equal(result.status, 'queued')
    assert.equal(result.providerMessageId, null)
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    assert.equal(row.status, 'failed')
    assert.equal(row.attemptCount, 1)
    assert.equal(row.errorMessage, 'provider down')
    const nextAt = row.nextAttemptAt?.getTime() ?? 0
    assert.ok(nextAt >= before + 30_000, 'first retry backoff applied')
})

test('sendAgentDirect rejects providers without sendDirect before inserting', async () => {
    const harness = makeSendHarness()
    ;(harness.fakeProvider as unknown as { sendDirect?: unknown }).sendDirect =
        undefined

    await assert.rejects(
        harness.bridge.sendAgentDirect(
            baseChannel,
            { kind: 'chat', chatId: 'oc_x' },
            'hello'
        ),
        BadRequestException
    )
    assert.equal(harness.deliveries.length, 0)
})

test('outbound sweep retries agent-send rows via sendDirect, not sendText', async () => {
    const harness = makeSendHarness()
    harness.fakeProvider.sendDirectResult = () => {
        throw new Error('first attempt fails')
    }
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'reply', messageId: 'om_q' },
        'answer'
    )
    assert.equal(result.status, 'queued')
    harness.fakeProvider.drainOutbound('chn-1')
    harness.fakeProvider.sendDirectResult = null
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    row.nextAttemptAt = new Date(Date.now() - 1000)

    const delivered = await harness.bridge.sweepOutboundDeliveries()

    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    assert.ok(row.providerMessageId)
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.length, 1)
    assert.equal(captures[0]?.kind, 'direct')
    assert.deepEqual((captures[0] as { target: unknown }).target, {
        kind: 'reply',
        messageId: 'om_q'
    })
})

test('outbound sweep deads agent-send rows when the provider lost sendDirect', async () => {
    const harness = makeSendHarness()
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'chat', chatId: 'oc_x' },
        'hello'
    )
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    row.status = 'failed'
    row.nextAttemptAt = new Date(Date.now() - 1000)
    ;(harness.fakeProvider as unknown as { sendDirect?: unknown }).sendDirect =
        undefined

    const delivered = await harness.bridge.sweepOutboundDeliveries()

    assert.equal(delivered, 0)
    assert.equal(row.status, 'dead')
    assert.equal(row.errorMessage, 'provider_unsupported')
})

// Scope-addressed agent sends (automation delivery into an existing
// conversation): same durable-row contract as sendAgentDirect but routed via
// sendText, which providers without sendDirect (Discord/Slack) implement.
const scopeKey = 'fake:chat:c1:user:u1'

test('sendAgentScoped delivers inline via sendText into the real scope', async () => {
    const harness = makeSendHarness()
    const result = await harness.bridge.sendAgentScoped(
        baseChannel,
        scopeKey,
        'daily report time'
    )

    assert.equal(result.status, 'sent')
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    assert.equal(row.status, 'sent')
    assert.equal(row.scopeKey, scopeKey)
    // No stored target: the sweep must route retries through
    // sendText(scopeKey), not sendDirect.
    assert.deepEqual(row.eventJson, { text: 'daily report time' })

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures.length, 1)
    assert.equal(captures[0]?.kind, 'final')
    assert.equal((captures[0] as { scopeKey: string }).scopeKey, scopeKey)
})

test('sendAgentScoped refuses scopes without a live conversation', async () => {
    const harness = makeSendHarness({ activeSession: false })

    await assert.rejects(
        harness.bridge.sendAgentScoped(baseChannel, scopeKey, 'hello'),
        /no active conversation/
    )
    assert.equal(harness.deliveries.length, 0)
})

test('outbound sweep retries scoped rows via sendText', async () => {
    const harness = makeSendHarness()
    harness.fakeProvider.sendTextResult = () => {
        throw new Error('provider down')
    }
    const result = await harness.bridge.sendAgentScoped(
        baseChannel,
        scopeKey,
        'hello'
    )
    assert.equal(result.status, 'queued')
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    assert.equal(row.status, 'failed')
    harness.fakeProvider.sendTextResult = null
    row.nextAttemptAt = new Date(Date.now() - 1000)

    const delivered = await harness.bridge.sweepOutboundDeliveries()

    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    const retry = captures[captures.length - 1]
    assert.equal(retry?.kind, 'final')
    assert.equal((retry as { scopeKey: string }).scopeKey, scopeKey)
})

test('sendAgentScoped dead-letters permanent provider rejections', async () => {
    const harness = makeSendHarness()
    harness.fakeProvider.sendTextResult = () => {
        throw new ChannelSendError('forbidden', 'bot was kicked')
    }
    const result = await harness.bridge.sendAgentScoped(
        baseChannel,
        scopeKey,
        'hello'
    )

    assert.equal(result.status, 'failed')
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.equal(row?.status, 'dead')
    assert.equal(row?.nextAttemptAt, null)
})

const runtimePrincipal: AuthPrincipal = {
    kind: 'agent-runtime',
    userId: 'user-1',
    agentId: 'agent-1',
    runtimeTokenId: 'rtk_1'
} as unknown as AuthPrincipal

const makeController = (overrides: {
    loadOwned?: () => Promise<ChannelRow>
    sendAgentDirect?: () => Promise<{
        deliveryId: bigint
        status: 'sent' | 'queued'
        providerMessageId: string | null
    }>
}): AgentSelfChannelsController =>
    new AgentSelfChannelsController(
        {
            loadOwned: overrides.loadOwned ?? (async () => ({ ...baseChannel }))
        } as never,
        { isEnabled: () => true } as never,
        {
            sendAgentDirect:
                overrides.sendAgentDirect ??
                (async () => ({
                    deliveryId: 7n,
                    status: 'sent' as const,
                    providerMessageId: 'om_sent'
                }))
        } as never,
        new ChannelSendRateLimitService()
    )

test('agent send endpoint maps the bridge result and stringifies deliveryId', async () => {
    const controller = makeController({})
    const result = await controller.send(runtimePrincipal, 'chn-1', {
        text: 'hi',
        userId: 'ou_member'
    })
    assert.deepEqual(result, {
        deliveryId: '7',
        status: 'sent',
        providerMessageId: 'om_sent'
    })
})

test('agent send endpoint requires exactly one target', async () => {
    const controller = makeController({})
    await assert.rejects(
        controller.send(runtimePrincipal, 'chn-1', { text: 'hi' }),
        /exactly one/
    )
    await assert.rejects(
        controller.send(runtimePrincipal, 'chn-1', {
            text: 'hi',
            chatId: 'oc_x',
            userId: 'ou_y'
        }),
        /exactly one/
    )
})

test('agent send endpoint rejects non-active channels', async () => {
    const controller = makeController({
        loadOwned: async () => ({ ...baseChannel, status: 'paused' })
    })
    await assert.rejects(
        controller.send(runtimePrincipal, 'chn-1', {
            text: 'hi',
            chatId: 'oc_x'
        }),
        /channel is paused/
    )
})

test('agent send endpoint rate limits per caller and channel', async () => {
    const controller = makeController({})
    for (let i = 0; i < 30; i += 1)
        await controller.send(runtimePrincipal, 'chn-1', {
            text: `hi ${i}`,
            chatId: 'oc_x'
        })
    await assert.rejects(
        controller.send(runtimePrincipal, 'chn-1', {
            text: 'one too many',
            chatId: 'oc_x'
        }),
        (err: unknown) =>
            err instanceof HttpException && err.getStatus() === 429
    )
})

const workspacePdf = {
    name: 'weekly.pdf',
    relPath: 'reports/weekly.pdf',
    contentType: 'application/pdf',
    bytes: Buffer.from('pdf-bytes')
}

test('sendAgentDirect sends text first, then files as their own delivery', async () => {
    const harness = makeSendHarness({ workspaceFiles: [workspacePdf] })
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'chat', chatId: 'oc_x' },
        'numbers attached',
        [{ relPath: 'reports/weekly.pdf', name: 'weekly.pdf' }]
    )

    assert.equal(result.status, 'sent')
    assert.equal(result.files?.status, 'sent')
    assert.notEqual(result.deliveryId, result.files?.deliveryId)

    const rows = harness.deliveries.filter((d) => d.direction === 'outbound')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[1]?.eventJson, {
        target: { kind: 'chat', chatId: 'oc_x' },
        files: [{ relPath: 'reports/weekly.pdf', name: 'weekly.pdf' }]
    })

    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.deepEqual(
        captures.map((c) => c.kind),
        ['direct', 'direct-attachments'],
        'text lands before the attachment'
    )
})

test('sendAgentDirect supports files-only sends via the top-level result', async () => {
    const harness = makeSendHarness({ workspaceFiles: [workspacePdf] })
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'user', userId: 'ou_y' },
        null,
        [{ relPath: 'reports/weekly.pdf', name: 'weekly.pdf' }]
    )

    assert.equal(result.status, 'sent')
    assert.equal(result.files, undefined)
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.deepEqual(
        captures.map((c) => c.kind),
        ['direct-attachments']
    )
})

test('sendAgentDirect dead-letters a file send whose paths resolve to nothing', async () => {
    const harness = makeSendHarness({ workspaceFiles: [] })
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'chat', chatId: 'oc_x' },
        null,
        [{ relPath: 'missing.pdf', name: 'missing.pdf' }]
    )

    assert.equal(result.status, 'failed')
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.equal(row?.status, 'dead')
    assert.match(row?.errorMessage ?? '', /no readable files/)
})

test('sendAgentDirect rejects file sends the provider cannot deliver', async () => {
    const harness = makeSendHarness({ workspaceFiles: [workspacePdf] })
    ;(
        harness.fakeProvider as unknown as { sendDirectAttachments?: unknown }
    ).sendDirectAttachments = undefined

    await assert.rejects(
        harness.bridge.sendAgentDirect(
            baseChannel,
            { kind: 'chat', chatId: 'oc_x' },
            null,
            [{ relPath: 'reports/weekly.pdf', name: 'weekly.pdf' }]
        ),
        /do not support agent file send/
    )
    assert.equal(harness.deliveries.length, 0)
})

test('outbound sweep retries a failed file delivery by re-reading the workspace', async () => {
    const harness = makeSendHarness({ workspaceFiles: [workspacePdf] })
    harness.fakeProvider.sendDirectAttachmentsResult = () => {
        throw new Error('upload flaked')
    }
    const result = await harness.bridge.sendAgentDirect(
        baseChannel,
        { kind: 'chat', chatId: 'oc_x' },
        null,
        [{ relPath: 'reports/weekly.pdf', name: 'weekly.pdf' }]
    )
    assert.equal(result.status, 'queued')
    harness.fakeProvider.drainOutbound('chn-1')
    harness.fakeProvider.sendDirectAttachmentsResult = null
    const row = harness.deliveries.find((d) => d.id === result.deliveryId)
    assert.ok(row)
    row.nextAttemptAt = new Date(Date.now() - 1000)
    const readsBefore = harness.readCalls.length

    const delivered = await harness.bridge.sweepOutboundDeliveries()

    assert.equal(delivered, 1)
    assert.equal(row.status, 'sent')
    assert.ok(
        harness.readCalls.length > readsBefore,
        'retry re-reads current workspace bytes'
    )
    const captures = harness.fakeProvider.drainOutbound('chn-1')
    assert.equal(captures[0]?.kind, 'direct-attachments')
})

test('agent send endpoint requires text or files', async () => {
    const controller = makeController({})
    await assert.rejects(
        controller.send(runtimePrincipal, 'chn-1', { chatId: 'oc_x' }),
        /text or files/
    )
})
