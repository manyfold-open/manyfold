import assert from 'node:assert/strict'
import test from 'node:test'
import { UnauthorizedException } from '@nestjs/common'
import { agents as agentsTable, channels as channelsTable } from '@manyfold/db'
import { AppEventsService } from '../src/common/events/app-events.service'
import { DaemonRateLimitService } from '../src/modules/daemon/daemon-rate-limit.service'
import { NarraNexusSyncService } from '../src/modules/narranexus-sync/narranexus-sync.service'
import { mapChannel, mapJob } from '../src/modules/narranexus-sync/narranexus-sync.mapper'
import type { NotifySyncDto } from '../src/modules/narranexus-sync/dto/notify-sync.dto'

const TOKEN = 'b'.repeat(64)
const IP = '203.0.113.9'

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    kind: 'sprites',
    framework: 'narranexus',
    status: 'ready',
    ingressHost: 'sprite.example',
    ...over
})

interface Harness {
    svc: NarraNexusSyncService
    calls: {
        created: unknown[]
        updated: Array<{ id: string; spec: unknown }>
        removed: string[]
        channelCreated: unknown[]
        channelUpdated: Array<{ id: string }>
        channelDeleted: string[]
        agentReconciles: number
        originPatches: string[]
        sweepQueries: number
        agentSends: Array<{
            channelId: string
            target: unknown
            text: string | null
            files: unknown[]
            idempotencyKey: string | null
        }>
    }
    setManagedAutomations: (rows: unknown[]) => void
    setChannelRows: (rows: unknown[]) => void
    setSweepRows: (rows: unknown[]) => void
    sendState: {
        armed: boolean
        hasSession: boolean
        priorSend: Record<string, unknown> | null
        agentRows: unknown[]
        channelLookup: unknown[]
    }
}

const makeHarness = (
    opts: { runtime?: Record<string, unknown> | null } = {}
): Harness => {
    const runtime = opts.runtime === undefined ? fakeRuntime() : opts.runtime
    const calls: Harness['calls'] = {
        created: [],
        updated: [],
        removed: [],
        channelCreated: [],
        channelUpdated: [],
        channelDeleted: [],
        agentReconciles: 0,
        originPatches: [],
        sweepQueries: 0,
        agentSends: []
    }
    let managedAutomations: unknown[] = []
    let channelRows: unknown[] = []
    let sweepRows: unknown[] = []
    // Explicit rather than inferred from row counts: "the send path is under
    // test and found nothing" has to be distinguishable from "this is a
    // reconcile test that never touched sendState".
    const sendState: {
        armed: boolean
        hasSession: boolean
        priorSend: Record<string, unknown> | null
        agentRows: unknown[]
        channelLookup: unknown[]
    } = {
        armed: false,
        hasSession: true,
        priorSend: null,
        agentRows: [],
        channelLookup: []
    }
    const db = {
        // One fake chain serves both callers: `.limit(1)` is the credential
        // lookup (loadRuntimeReportToken / loadNarraNexusGatewayToken),
        // awaiting the bare where() is the channels-table scan.
        select: () => ({
            from: (table: unknown) => ({
                where: () => {
                    // Table-aware only where channelSend needs it; every other
                    // caller keeps the original conflated behaviour so the
                    // reconcile tests below are unaffected.
                    const wantAgents =
                        table === agentsTable && sendState.armed
                    const wantChannels =
                        table === channelsTable && sendState.armed
                    const rows = wantAgents
                        ? sendState.agentRows
                        : wantChannels
                          ? sendState.channelLookup
                          : channelRows
                    const result = Promise.resolve(rows) as Promise<unknown[]> & {
                        limit: () => Promise<unknown[]>
                    }
                    result.limit = async () =>
                        wantAgents
                            ? sendState.agentRows
                            : [{ payloadCiphertext: 'ct', keyVersion: 1 }]
                    return result
                }
            })
        }),
        update: () => ({
            set: () => ({
                where: async () => {
                    calls.originPatches.push('origin')
                }
            })
        }),
        selectDistinct: () => ({
            from: () => ({
                where: async () => {
                    calls.sweepQueries += 1
                    return sweepRows
                }
            })
        })
    }
    const crypto = {
        decrypt: () =>
            JSON.stringify({ gatewayToken: 'gw', runtimeReportToken: TOKEN })
    }
    const runtimes = {
        findById: async (id: string) =>
            runtime && (runtime as { id: string }).id === id ? runtime : null
    }
    const reconcile = {
        touchRuntime: () => {
            calls.agentReconciles += 1
        }
    }
    const automations = {
        listManagedByAgents: async () => managedAutomations,
        createManaged: async (_agent: unknown, spec: unknown) => {
            calls.created.push(spec)
        },
        updateManaged: async (id: string, spec: unknown) => {
            calls.updated.push({ id, spec })
        },
        removeManaged: async (id: string) => {
            calls.removed.push(id)
        }
    }
    const channels = {
        create: async (_userId: string, body: unknown) => {
            calls.channelCreated.push(body)
        },
        update: async (_userId: string, id: string) => {
            calls.channelUpdated.push({ id })
        },
        delete: async (_userId: string, id: string) => {
            calls.channelDeleted.push(id)
        }
    }
    const channelBridge = {
        sendAgentDirect: async (
            channel: { id: string },
            target: unknown,
            text: string | null,
            files: unknown[],
            idempotencyKey: string | null
        ) => {
            calls.agentSends.push({
                channelId: channel.id,
                target,
                text,
                files,
                idempotencyKey
            })
            return {
                deliveryId: 42n,
                status: 'sent' as const,
                providerMessageId: 'pm-1'
            }
        }
    }
    const channelRepo = {
        hasSessionForRoom: async () => sendState.hasSession,
        findAgentSendByKey: async () => sendState.priorSend
    }
    const svc = new NarraNexusSyncService(
        db as never,
        crypto as never,
        new AppEventsService(),
        runtimes as never,
        reconcile as never,
        automations as never,
        channels as never,
        new DaemonRateLimitService(),
        channelBridge as never,
        channelRepo as never
    )
    return {
        svc,
        calls,
        setManagedAutomations: (rows) => {
            managedAutomations = rows
        },
        setChannelRows: (rows) => {
            channelRows = rows
        },
        setSweepRows: (rows) => {
            sweepRows = rows
        },
        sendState
    }
}

const dto = (over: Record<string, unknown> = {}): NotifySyncDto =>
    ({ runtimeId: 'rt-1', ...over }) as NotifySyncDto

test('notify rejects a missing or wrong bearer with a uniform 401', async () => {
    const { svc } = makeHarness()
    let touched = 0
    svc.touchRuntime = () => {
        touched += 1
    }
    await assert.rejects(
        svc.notify(IP, null, dto()),
        UnauthorizedException
    )
    await assert.rejects(
        svc.notify(IP, 'wrong-token', dto()),
        UnauthorizedException
    )
    assert.equal(touched, 0)
})

test('notify rejects unknown runtimes and non-narranexus frameworks', async () => {
    for (const runtime of [
        null,
        fakeRuntime({ framework: 'openclaw' }),
        fakeRuntime({ kind: 'k8s' })
    ]) {
        const { svc } = makeHarness({ runtime })
        await assert.rejects(
            svc.notify(IP, TOKEN, dto()),
            UnauthorizedException
        )
    }
})

test('notify with a valid bearer touches the runtime', async () => {
    const { svc } = makeHarness()
    const touched: string[] = []
    svc.touchRuntime = (runtimeId) => {
        touched.push(runtimeId)
    }
    await svc.notify(IP, TOKEN, dto())
    assert.deepEqual(touched, ['rt-1'])
})

test('touchRuntime coalesces while a reconcile is inflight', async () => {
    const { svc } = makeHarness()
    let running = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    ;(svc as never as { reconcileRuntime: unknown }).reconcileRuntime =
        async () => {
            running += 1
            await gate
        }
    svc.touchRuntime('rt-1', { external: true })
    svc.touchRuntime('rt-1', { external: true })
    svc.touchRuntime('rt-1', { external: true })
    assert.equal(running, 1)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    // The coalesced re-run is deferred through the debounce window, not
    // fired inline — a trailing kick must be pending.
    assert.equal(
        (svc as never as { pendingKicks: Map<string, unknown> }).pendingKicks
            .size,
        1
    )
    svc.onModuleDestroy()
})

test('reconcile failure schedules a bounded retry kick', async () => {
    const { svc } = makeHarness()
    ;(svc as never as { reconcileRuntime: unknown }).reconcileRuntime =
        async () => {
            throw new Error('sprite unreachable')
        }
    svc.touchRuntime('rt-1', { external: true })
    await new Promise((resolve) => setImmediate(resolve))
    const inner = svc as never as {
        failures: Map<string, number>
        pendingKicks: Map<string, unknown>
    }
    assert.equal(inner.failures.get('rt-1'), 1)
    assert.equal(inner.pendingKicks.size, 1)
    svc.onModuleDestroy()
})

const NOW = new Date('2026-07-16T12:00:00.000Z')  // mapJob calls in assertions use far-future fire times so the real-clock clamp never kicks in

const nxJob = (over: Record<string, unknown> = {}) => ({
    job_id: 'job_1',
    agent_id: 'nx_a1',
    title: 'Brief',
    status: 'active',
    job_type: 'scheduled',
    next_run_time: '2027-01-01T15:00:00.000Z',
    updated_at: null,
    ...over
})

const agentRow = (over: Record<string, unknown> = {}) => ({
    id: 'agt_1',
    userId: 'user_1',
    internalId: 'nx_a1',
    runtimeId: 'rt-1',
    framework: 'narranexus',
    ...over
})

test('syncJobs creates, updates, prunes and reports undiscovered agents', async () => {
    const h = makeHarness()
    const agents = new Map([['nx_a1', agentRow()]])
    const unchanged = mapJob('rt-1', nxJob({ job_id: 'job_same' }) as never, NOW)!
    h.setManagedAutomations([
        {
            id: 'auto_same',
            origin: {
                kind: 'narranexus',
                runtimeId: 'rt-1',
                jobId: 'job_same',
                contentHash: unchanged.contentHash
            }
        },
        {
            id: 'auto_stale',
            origin: {
                kind: 'narranexus',
                runtimeId: 'rt-1',
                jobId: 'job_changed',
                contentHash: 'old-hash'
            }
        },
        {
            id: 'auto_gone',
            origin: {
                kind: 'narranexus',
                runtimeId: 'rt-1',
                jobId: 'job_deleted',
                contentHash: 'x'
            }
        }
    ])
    const jobs = [
        nxJob({ job_id: 'job_same' }),
        nxJob({ job_id: 'job_changed', title: 'Renamed' }),
        nxJob({ job_id: 'job_new' }),
        nxJob({ job_id: 'job_orphan', agent_id: 'nx_unknown' })
    ]
    const minArmed = await (
        h.svc as never as {
            syncJobs: (
                runtime: unknown,
                agents: Map<string, unknown>,
                jobs: unknown[]
            ) => Promise<number | null>
        }
    ).syncJobs(fakeRuntime(), agents, jobs)

    assert.equal(h.calls.created.length, 1)
    assert.equal(
        (h.calls.created[0] as { origin: { jobId: string } }).origin.jobId,
        'job_new'
    )
    assert.deepEqual(
        h.calls.updated.map((u) => u.id),
        ['auto_stale']
    )
    assert.deepEqual(h.calls.removed, ['auto_gone'])
    assert.equal(h.calls.agentReconciles, 1)
    assert.equal(minArmed, Date.parse('2027-01-01T15:00:00.000Z'))
})

const nxBinding = (over: Record<string, unknown> = {}) => ({
    provider: 'telegram',
    agent_id: 'nx_a1',
    enabled: true,
    external_id: '42',
    credentials: { bot_token: '123456:ABCDEF' },
    config: { bot_username: 'nx_bot' },
    ...over
})

test('syncChannels creates, updates (with origin patch) and prunes', async () => {
    const h = makeHarness()
    const agents = new Map([['nx_a1', agentRow()]])
    const same = mapChannel('rt-1', nxBinding({ provider: 'discord' }) as never)!
    h.setChannelRows([
        {
            id: 'ch_same',
            userId: 'user_1',
            agentId: 'agt_1',
            provider: 'discord',
            origin: {
                kind: 'narranexus',
                runtimeId: 'rt-1',
                nxAgentId: 'nx_a1',
                contentHash: same.contentHash
            }
        },
        {
            id: 'ch_stale',
            userId: 'user_1',
            agentId: 'agt_1',
            provider: 'telegram',
            origin: {
                kind: 'narranexus',
                runtimeId: 'rt-1',
                nxAgentId: 'nx_a1',
                contentHash: 'old-hash'
            }
        },
        {
            id: 'ch_gone',
            userId: 'user_1',
            agentId: 'agt_1',
            provider: 'matrix',
            origin: {
                kind: 'narranexus',
                runtimeId: 'rt-1',
                nxAgentId: 'nx_a1',
                contentHash: 'x'
            }
        }
    ])
    const bindings = [
        nxBinding({ provider: 'discord', credentials: { bot_token: '123456:ABCDEF' } }),
        nxBinding(),
        nxBinding({ provider: 'wechat', agent_id: 'nx_unknown' })
    ]
    await (
        h.svc as never as {
            syncChannels: (
                runtime: unknown,
                agents: Map<string, unknown>,
                bindings: unknown[]
            ) => Promise<void>
        }
    ).syncChannels(fakeRuntime(), agents, bindings)

    assert.deepEqual(h.calls.channelDeleted, ['ch_gone'])
    assert.deepEqual(
        h.calls.channelUpdated.map((u) => u.id),
        ['ch_stale']
    )
    assert.deepEqual(h.calls.originPatches, ['origin'])
    assert.equal(h.calls.channelCreated.length, 0)
})

// Every other trigger is an edge — a lost notify webhook, a Manyfold turn, a
// boot report, an armed alarm. Binding a channel in the NarraNexus dashboard
// and then waiting in the IM app hits none of them, so a dropped notify left
// the channel unregistered with no signal at all.
test('the sweep pulls runtimes no edge trigger would have reached', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const { svc, setSweepRows } = makeHarness()
    setSweepRows([{ runtimeId: 'rt-1' }, { runtimeId: 'rt-2' }])
    const touched: string[] = []
    svc.touchRuntime = (runtimeId) => {
        touched.push(runtimeId)
    }
    svc.onModuleInit()
    t.mock.timers.tick(5 * 60_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(touched, ['rt-1', 'rt-2'])
    svc.onModuleDestroy()
})

// A reconcile is two HTTP calls to the sandbox ingress, and on Fly that wakes a
// suspended machine. Sweeping unconditionally would hold every NarraNexus
// sandbox awake forever and bill the user for it — so the query itself filters
// on the sprite-status poller's control-plane view, and an empty result must
// stay an empty result rather than falling back to "touch everything".
test('the sweep touches nothing when no sandbox is running', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const { svc, setSweepRows, calls } = makeHarness()
    setSweepRows([])
    const touched: string[] = []
    svc.touchRuntime = (runtimeId) => {
        touched.push(runtimeId)
    }
    svc.onModuleInit()
    t.mock.timers.tick(5 * 60_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.sweepQueries, 1, 'the sweep still ran')
    assert.deepEqual(touched, [], 'but woke nothing')
    svc.onModuleDestroy()
})

test('a failing sweep query does not kill the interval', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const { svc } = makeHarness()
    const touched: string[] = []
    svc.touchRuntime = (runtimeId) => {
        touched.push(runtimeId)
    }
    ;(svc as never as { db: { selectDistinct: unknown } }).db = {
        selectDistinct: () => ({
            from: () => ({
                where: async () => {
                    throw new Error('db down')
                }
            })
        })
    }
    svc.onModuleInit()
    t.mock.timers.tick(5 * 60_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(touched, [])
    svc.onModuleDestroy()
})

// Platform-side outbound. The point is not that the token stays home — staging
// showed a model guessing a context_token that iLink accepted, and our iLink
// client marks the token optional on every call, so secrecy was never the
// control. The control is that the request cannot name a recipient: it names a
// room, and Manyfold decides who that is and whether anyone lives there.
const sendDto = (over: Record<string, unknown> = {}) =>
    ({
        runtimeId: 'rt-1',
        agentId: 'nx-agent-1',
        provider: 'wechat',
        roomId: 'o9cq805XyMxOvfxqj2FjTYRvhxPs@im.wechat',
        text: 'hello back',
        ...over
    }) as never

const armSend = (h: Harness, over: Record<string, unknown> = {}): void => {
    h.sendState.armed = true
    h.sendState.agentRows = [
        { id: 'agent-1', internalId: 'nx-agent-1', framework: 'narranexus' }
    ]
    h.sendState.channelLookup = [
        {
            id: 'chn-1',
            provider: 'weixin',
            status: 'active',
            origin: { kind: 'narranexus', runtimeId: 'rt-1', nxAgentId: 'nx-1' },
            ...over
        }
    ]
}

test('channelSend delivers through the platform without any credential in the request', async () => {
    const h = makeHarness()
    armSend(h)
    const result = await h.svc.channelSend(IP, TOKEN, sendDto())
    assert.equal(result.status, 'sent')
    assert.equal(result.deduplicated, false)
    assert.equal(h.calls.agentSends.length, 1)
    // wechat has no addressable chat, only a peer — and its sendDirect refuses
    // a peer with no stored reply credential, so an unsolicited DM cannot even
    // be attempted.
    assert.deepEqual(h.calls.agentSends[0].target, {
        kind: 'user',
        userId: 'o9cq805XyMxOvfxqj2FjTYRvhxPs@im.wechat'
    })
    assert.equal(h.calls.agentSends[0].text, 'hello back')
})

test('channelSend addresses a room for every provider that has one', async () => {
    const h = makeHarness()
    armSend(h, { provider: 'matrix' })
    await h.svc.channelSend(
        IP,
        TOKEN,
        sendDto({
            provider: 'narramessenger',
            roomId: '!room:matrix.netmind.chat'
        })
    )
    assert.deepEqual(h.calls.agentSends[0].target, {
        kind: 'chat',
        chatId: '!room:matrix.netmind.chat'
    })
})

// The whole point of moving delivery to the platform: an agent may answer where
// it was spoken to and nowhere else.
test('channelSend refuses a room nobody has written to', async () => {
    const h = makeHarness()
    armSend(h)
    h.sendState.hasSession = false
    await assert.rejects(
        h.svc.channelSend(IP, TOKEN, sendDto()),
        /no inbound history for this room/
    )
    assert.equal(h.calls.agentSends.length, 0)
})

// A channel the user built themselves is not something a hosted agent may
// speak through, even if it happens to be bound to the same agent.
test('channelSend refuses a channel that is not a NarraNexus mirror', async () => {
    const h = makeHarness()
    armSend(h, { origin: null })
    await assert.rejects(
        h.svc.channelSend(IP, TOKEN, sendDto()),
        /no mirrored wechat channel/
    )
    assert.equal(h.calls.agentSends.length, 0)
})

test('channelSend refuses an agent that does not belong to the runtime', async () => {
    const h = makeHarness()
    armSend(h)
    h.sendState.agentRows = []
    await assert.rejects(
        h.svc.channelSend(IP, TOKEN, sendDto()),
        /unknown agent nx-agent-1/
    )
})

test('channelSend refuses a provider NarraNexus cannot be hosted on', async () => {
    const h = makeHarness()
    armSend(h)
    await assert.rejects(
        h.svc.channelSend(IP, TOKEN, sendDto({ provider: 'slack' })),
        /unsupported provider slack/
    )
})

test('channelSend rejects a bad bearer before touching a channel', async () => {
    const h = makeHarness()
    armSend(h)
    await assert.rejects(
        h.svc.channelSend(IP, 'wrong-token', sendDto()),
        UnauthorizedException
    )
    await assert.rejects(
        h.svc.channelSend(IP, null, sendDto()),
        UnauthorizedException
    )
    assert.equal(h.calls.agentSends.length, 0)
})

test('channelSend needs text or attachments', async () => {
    const h = makeHarness()
    armSend(h)
    await assert.rejects(
        h.svc.channelSend(IP, TOKEN, sendDto({ text: '   ' })),
        /text or attachments is required/
    )
})

// A retry whose first response was never seen must not post the message twice.
test('channelSend returns the earlier delivery instead of sending again', async () => {
    const h = makeHarness()
    armSend(h)
    h.sendState.priorSend = {
        id: 7n,
        status: 'sent',
        providerMessageId: 'pm-earlier'
    }
    const result = await h.svc.channelSend(
        IP,
        TOKEN,
        sendDto({ idempotencyKey: 'k-1' })
    )
    assert.equal(result.deduplicated, true)
    assert.equal(result.deliveryId, '7')
    assert.equal(result.providerMessageId, 'pm-earlier')
    assert.equal(h.calls.agentSends.length, 0, 'nothing was re-sent')
})

test('the idempotency key is stamped on the delivery so the retry can find it', async () => {
    const h = makeHarness()
    armSend(h)
    await h.svc.channelSend(IP, TOKEN, sendDto({ idempotencyKey: 'k-2' }))
    assert.equal(h.calls.agentSends[0].idempotencyKey, 'k-2')
})

// Agents name files the way they see them; the workspace-relative form is what
// readWorkspaceFiles expects, and path safety is enforced at read time.
test('channelSend normalizes workspace file paths', async () => {
    const h = makeHarness()
    armSend(h)
    await h.svc.channelSend(
        IP,
        TOKEN,
        sendDto({ attachments: [{ path: '/workspace/out/report.pdf' }] })
    )
    assert.deepEqual(h.calls.agentSends[0].files, [
        { relPath: 'out/report.pdf', name: 'report.pdf' }
    ])
})

test('channelSend refuses an inactive channel', async () => {
    const h = makeHarness()
    armSend(h, { status: 'draft' })
    await assert.rejects(
        h.svc.channelSend(IP, TOKEN, sendDto()),
        /channel is draft/
    )
})
