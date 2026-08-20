import type {
    CreateChannelBody,
    LarkChannelConfig
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ChannelDeliveryRow,
    ChannelRow,
    NewChannelRow
} from '@manyfold/db'
import { ChannelsService } from '../src/modules/channels/channels.service'
import { LarkChannelProvider } from '../src/modules/channels/providers/lark.provider'

test('ChannelsService.create activates and starts Lark websocket channels', async () => {
    let row: ChannelRow | null = null
    const reloads: ChannelRow[] = []
    let reservedUserId: string | null = null

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'agent-1', name: 'Agent One' }]
                })
            })
        })
    }

    const repo = {
        insert: async (input: NewChannelRow) => {
            row = input as ChannelRow
            return row
        },
        getById: async (id: string) => (row?.id === id ? row : null),
        getOwned: async (id: string, userId: string) =>
            row?.id === id && row.userId === userId ? row : null,
        update: async (id: string, patch: Partial<NewChannelRow>) => {
            if (!row || row.id !== id) return null
            row = { ...row, ...patch, updatedAt: new Date() } as ChannelRow
            return row
        },
        listDeliveries: async (): Promise<ChannelDeliveryRow[]> => []
    }

    const provider = new LarkChannelProvider({
        get: () => 'https://open.feishu.cn'
    } as never)
    const service = new ChannelsService(
        db as never,
        repo as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        {
            reload: async (channel: ChannelRow) => {
                reloads.push(channel)
            }
        } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        {
            reserveChannelSlot: async (userId: string) => {
                reservedUserId = userId
            }
        } as never,
        {
            get: (key: string) =>
                key === 'PUBLIC_API_BASE_URL'
                    ? 'https://api.example.com'
                    : undefined
        } as never
    )

    const created = await service.create('user-1', {
        agentId: 'agent-1',
        provider: 'lark',
        label: 'Lark WS',
        config: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: false,
            progressMode: 'preview',
            botName: 'NCA Bot'
        },
        credentials: { appSecret: 'secret' }
    })

    assert.equal(created.status, 'active')
    assert.equal(reservedUserId, 'user-1')
    assert.equal(reloads.length, 1)
    assert.equal(reloads[0]?.status, 'active')
    assert.match(
        created.inboundUrl,
        /^https:\/\/api\.example\.com\/api\/channels\/hooks\/lark\//
    )
})

test('ChannelsService.create rejects Lark mention gating without botName', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'agent-1', name: 'Agent One' }]
                })
            })
        })
    }
    const provider = new LarkChannelProvider({
        get: () => 'https://open.feishu.cn'
    } as never)
    const service = new ChannelsService(
        db as never,
        { insert: async () => null } as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        { reload: async () => null } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )

    await assert.rejects(
        service.create('user-1', {
            agentId: 'agent-1',
            provider: 'lark',
            label: 'Lark WS',
            config: {
                appId: 'cli_x',
                subscriptionMode: 'websocket',
                mentionOnly: true,
                shareSessionInChannel: false,
                threadIsolation: false,
                progressMode: 'preview'
            } satisfies LarkChannelConfig,
            credentials: { appSecret: 'secret' }
        }),
        /botName/
    )
})

test('ChannelsService.test restarts an active Lark websocket before giving up', async () => {
    let row: ChannelRow | null = {
        id: 'channel-1',
        userId: 'user-1',
        agentId: 'agent-1',
        provider: 'lark',
        label: 'Lark WS',
        status: 'active',
        configJson: {
            appId: 'cli_x',
            subscriptionMode: 'websocket',
            mentionOnly: true,
            shareSessionInChannel: false,
            threadIsolation: false,
            progressMode: 'preview',
            botName: null
        },
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
    let reloads = 0

    const repo = {
        getById: async (id: string) => (row?.id === id ? row : null),
        getOwned: async (id: string, userId: string) =>
            row?.id === id && row.userId === userId ? row : null
    }
    const provider = {
        validateConfig: (config: unknown) => config,
        validateCredentials: () => null,
        test: async (ctx: { channel: ChannelRow }) =>
            ctx.channel.lastConnectedAt
                ? { ok: true, message: 'websocket connected' }
                : { ok: false, message: 'websocket has not connected yet' }
    }
    const service = new ChannelsService(
        {} as never,
        repo as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        {
            reload: async (channel: ChannelRow) => {
                reloads += 1
                row = {
                    ...channel,
                    lastConnectedAt: new Date(),
                    updatedAt: new Date()
                }
            }
        } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )

    const result = await service.test('user-1', 'channel-1')

    assert.equal(reloads, 1)
    assert.equal(result.ok, true)
    assert.match(result.message, /^\(websocket restarted\)/)
})

const makeServiceRow = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'channel-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'telegram',
    label: 'TG',
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

const makeRegisterHarness = (
    initial: ChannelRow,
    registerResult: () => Promise<{ ok: boolean; message?: string }>
): {
    service: ChannelsService
    row: () => ChannelRow
} => {
    let row = initial
    const repo = {
        getById: async (id: string) => (row.id === id ? row : null),
        getOwned: async (id: string, userId: string) =>
            row.id === id && row.userId === userId ? row : null,
        update: async (id: string, patch: Partial<NewChannelRow>) => {
            if (row.id !== id) return null
            row = { ...row, ...patch, updatedAt: new Date() } as ChannelRow
            return row
        },
        listDeliveries: async (): Promise<ChannelDeliveryRow[]> => []
    }
    const provider = {
        validateConfig: (config: unknown) => config,
        validateCredentials: () => null,
        register: registerResult
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'agent-1', name: 'Agent One' }]
                })
            })
        })
    }
    const service = new ChannelsService(
        db as never,
        repo as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        { reload: async () => undefined } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )
    return { service, row: () => row }
}

test('register failure on an active channel records the error without degrading status', async () => {
    const h = makeRegisterHarness(makeServiceRow(), async () => ({
        ok: false,
        message: 'setWebhook failed'
    }))

    const result = await h.service.register('user-1', 'channel-1')

    assert.equal(result.ok, false)
    assert.equal(result.message, 'setWebhook failed')
    assert.equal(
        h.row().status,
        'active',
        'active channel keeps receiving webhooks'
    )
    assert.equal(h.row().lastErrorMessage, 'setWebhook failed')
})

test('register throw on an active channel also keeps it active but reports failure', async () => {
    const h = makeRegisterHarness(makeServiceRow(), async () => {
        throw new Error('telegram unreachable')
    })

    const result = await h.service.register('user-1', 'channel-1')

    assert.equal(result.ok, false)
    assert.equal(result.message, 'telegram unreachable')
    assert.equal(h.row().status, 'active')
    assert.equal(h.row().lastErrorMessage, 'telegram unreachable')
})

test('register failure on a draft channel still degrades it to error', async () => {
    const h = makeRegisterHarness(
        makeServiceRow({ status: 'draft' }),
        async () => ({ ok: false, message: 'setWebhook failed' })
    )

    const result = await h.service.register('user-1', 'channel-1')

    assert.equal(result.ok, false)
    assert.equal(h.row().status, 'error')
})

test('update resets the reconnect backoff so the tick retries promptly', async () => {
    const h = makeRegisterHarness(
        makeServiceRow({
            status: 'error',
            reconnectAttempts: 7,
            nextReconnectAt: new Date(Date.now() + 600_000)
        }),
        async () => ({ ok: true })
    )

    await h.service.update('user-1', 'channel-1', {
        config: { note: 'touched' }
    } as never)

    assert.equal(h.row().reconnectAttempts, 0)
    assert.equal(h.row().nextReconnectAt, null)
})

const makeRebindHarness = (
    agentLookup: Array<{ id: string; name: string; framework?: string }>,
    rowOverrides: Partial<ChannelRow> = {}
): {
    service: ChannelsService
    row: () => ChannelRow
    rebinds: Array<{ id: string; agentId: string }>
    reloads: ChannelRow[]
} => {
    let row = makeServiceRow(rowOverrides)
    const rebinds: Array<{ id: string; agentId: string }> = []
    const reloads: ChannelRow[] = []
    const repo = {
        getById: async (id: string) => (row.id === id ? row : null),
        getOwned: async (id: string, userId: string) =>
            row.id === id && row.userId === userId ? row : null,
        update: async (id: string, patch: Partial<NewChannelRow>) => {
            if (row.id !== id) return null
            row = { ...row, ...patch, updatedAt: new Date() } as ChannelRow
            return row
        },
        rebindAgent: async (id: string, agentId: string) => {
            if (row.id !== id) return null
            rebinds.push({ id, agentId })
            row = { ...row, agentId, updatedAt: new Date() }
            return row
        },
        listDeliveries: async (): Promise<ChannelDeliveryRow[]> => []
    }
    const provider = {
        validateConfig: (config: unknown) => config,
        validateCredentials: () => null
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => agentLookup
                })
            })
        })
    }
    const service = new ChannelsService(
        db as never,
        repo as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        {
            reload: async (channel: ChannelRow) => {
                reloads.push(channel)
            }
        } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )
    return { service, row: () => row, rebinds, reloads }
}

test('update with a new agentId rebinds atomically and reloads with the new agent', async () => {
    const h = makeRebindHarness([{ id: 'agent-2', name: 'Agent Two' }])

    const detail = await h.service.update('user-1', 'channel-1', {
        agentId: 'agent-2'
    })

    assert.deepEqual(h.rebinds, [{ id: 'channel-1', agentId: 'agent-2' }])
    assert.equal(h.row().agentId, 'agent-2')
    assert.equal(detail.agentId, 'agent-2')
    assert.equal(detail.agent.name, 'Agent Two')
    assert.equal(h.reloads.at(-1)?.agentId, 'agent-2')
})

test('update rejects rebinding to an agent the channel owner does not own', async () => {
    const h = makeRebindHarness([])

    await assert.rejects(
        h.service.update('user-1', 'channel-1', { agentId: 'agent-x' }),
        /agent not found/
    )
    assert.equal(h.rebinds.length, 0)
    assert.equal(h.row().agentId, 'agent-1')
})

test('update with the current agentId skips the rebind sweep', async () => {
    const h = makeRebindHarness([{ id: 'agent-1', name: 'Agent One' }])

    await h.service.update('user-1', 'channel-1', { agentId: 'agent-1' })

    assert.equal(h.rebinds.length, 0)
})

// agentManagedReply suppresses Manyfold's own delivery, so every path that can
// establish the (agent, config) pair must refuse a combination where nothing
// can deliver: only narranexus agents on providers NarraNexus can send through.

test('create rejects agentManagedReply for a non-narranexus agent', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: 'agent-1',
                            name: 'Agent One',
                            framework: 'claude-code'
                        }
                    ]
                })
            })
        })
    }
    const provider = new LarkChannelProvider({
        get: () => 'https://open.feishu.cn'
    } as never)
    const service = new ChannelsService(
        db as never,
        { insert: async () => null } as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        { reload: async () => null } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )

    await assert.rejects(
        service.create('user-1', {
            agentId: 'agent-1',
            provider: 'lark',
            label: 'Lark WS',
            config: {
                appId: 'cli_x',
                subscriptionMode: 'websocket' as const,
                botName: 'NCA Bot',
                agentManagedReply: true
            },
            credentials: { appSecret: 'secret' }
        } satisfies CreateChannelBody),
        /requires a narranexus agent/,
        'a non-narranexus agent has no channel send tools — the flag would silence the channel'
    )
})

test('create rejects agentManagedReply on a provider NarraNexus cannot send through', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: 'agent-1',
                            name: 'Agent One',
                            framework: 'narranexus'
                        }
                    ]
                })
            })
        })
    }
    const provider = {
        validateConfig: (config: unknown) => config,
        validateCredentials: () => null
    }
    const service = new ChannelsService(
        db as never,
        { insert: async () => null } as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        { reload: async () => null } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )

    await assert.rejects(
        service.create('user-1', {
            agentId: 'agent-1',
            provider: 'matrix',
            label: 'Matrix',
            config: { agentManagedReply: true },
            credentials: null
        } as never),
        /not supported for provider "matrix"/,
        'matrix has no NarraNexus WorkingSource — the turn would stay owner-chat while delivery is suppressed'
    )
})

// The same guard has to let the mirror through: the sync mapper renders a
// narramessenger binding as a matrix row with the flag already on, and the
// reconcile loop swallows a rejection here as a warn — so refusing it would not
// disable the switch, it would stop that channel from syncing at all.
test('create accepts agentManagedReply on a matrix row that mirrors a NarraNexus binding', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: 'agent-1',
                            name: 'Agent One',
                            framework: 'narranexus'
                        }
                    ]
                })
            })
        })
    }
    const provider = {
        validateConfig: (config: unknown) => config,
        validateCredentials: () => null
    }
    const inserted: unknown[] = []
    const service = new ChannelsService(
        db as never,
        {
            insert: async (row: unknown) => {
                inserted.push(row)
                return row
            }
        } as never,
        { get: () => provider } as never,
        {
            encrypt: () => ({ ciphertext: 'ciphertext', keyVersion: 1 }),
            decrypt: () => '{}'
        } as never,
        { reload: async () => null } as never,
        { fork: async () => null, switchTo: async () => null } as never,
        { reserveChannelSlot: async () => undefined } as never,
        { get: () => undefined } as never
    )

    // Only the guard is under test here; the reload/get tail needs a whole
    // repo and would not make the assertion any stronger. The insert is what
    // proves the gate opened — it is unreachable if the guard throws.
    await service
        .create(
            'user-1',
            {
                agentId: 'agent-1',
                provider: 'matrix',
                label: 'NarraNexus Matrix',
                config: {
                    homeserver: 'https://matrix.example',
                    agentManagedReply: true
                },
                credentials: null
            } as never,
            {
                origin: {
                    kind: 'narranexus',
                    runtimeId: 'rt-1',
                    nxAgentId: 'nx-1'
                }
            }
        )
        .catch(() => {})
    assert.equal(
        inserted.length,
        1,
        'the mirrored matrix row must clear the provider guard'
    )
})

test('update rejects flipping agentManagedReply on for a non-narranexus agent', async () => {
    const h = makeRebindHarness([
        { id: 'agent-1', name: 'Agent One', framework: 'codex' }
    ])

    await assert.rejects(
        h.service.update('user-1', 'channel-1', {
            config: { agentManagedReply: true }
        } as never),
        /requires a narranexus agent/,
        'the config-only update path must enforce the guard — it bypasses assertAgentOwned'
    )
    assert.deepEqual(
        h.row().configJson,
        {},
        'a rejected update must not persist the config'
    )
})

test('update rejects rebinding a flag-on channel away from narranexus before mutating', async () => {
    const h = makeRebindHarness(
        [{ id: 'agent-2', name: 'Agent Two', framework: 'claude-code' }],
        { configJson: { agentManagedReply: true } }
    )

    await assert.rejects(
        h.service.update('user-1', 'channel-1', { agentId: 'agent-2' }),
        /requires a narranexus agent/,
        'a stale flag on a rebound channel would suppress Manyfold with nothing to deliver'
    )
    assert.equal(
        h.rebinds.length,
        0,
        'the guard must run before the rebind so a rejection leaves no half-applied update'
    )
    assert.equal(h.row().agentId, 'agent-1')
})

test('update allows rebinding a flag-on channel to another narranexus agent', async () => {
    const h = makeRebindHarness(
        [{ id: 'agent-2', name: 'Agent Two', framework: 'narranexus' }],
        { configJson: { agentManagedReply: true } }
    )

    await h.service.update('user-1', 'channel-1', { agentId: 'agent-2' })

    assert.deepEqual(h.rebinds, [{ id: 'channel-1', agentId: 'agent-2' }])
})
