import type {
    ChannelConfig,
    ChannelCredentials,
    ChannelProviderName
} from '@manyfold/shared'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import {
    agents,
    channels,
    type Agent,
    type AgentRuntimeRow,
    type ChannelOrigin,
    type ChannelRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { AppEventsService } from '@/common/events/app-events.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { AgentReconcileService } from '@/modules/agents/reconcile/agent-reconcile.service'
import { AutomationsService } from '@/modules/automations/automations.service'
import { ChannelsService } from '@/modules/channels/channels.service'
import { ChannelBridgeService } from '@/modules/channels/channel-bridge.service'
import { ChannelsRepository } from '@/modules/channels/channels.repository'
import type { ChannelSendTarget } from '@/modules/channels/channel-provider'
import { DaemonRateLimitService } from '@/modules/daemon/daemon-rate-limit.service'
import { loadRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'
import {
    loadNarraNexusGatewayToken,
    narraNexusFetch
} from '@/modules/narranexus/narranexus-http'
import { mapChannel, mapJob, type MappedChannel, type MappedJob } from './narranexus-sync.mapper'
import type {
    NarraNexusChannelsResponse,
    NarraNexusJobsResponse
} from './narranexus-sync.types'
import type { NotifySyncDto } from './dto/notify-sync.dto'
import type { ChannelSendDto } from './dto/channel-send.dto'

const IP_RATE_LIMIT = 60
const RUNTIME_RATE_LIMIT = 30
const RATE_WINDOW_MS = 60_000

const MIN_INTERVAL_MS = 15_000
const RETRY_BACKOFF_MS = [15_000, 60_000, 300_000]
// Post-fire verification: if no reconcile landed after an alarm's fire time,
// pull once to re-arm (covers a lost NarraNexus webhook after a run).
const REARM_GRACE_MS = 120_000
// Beyond this horizon a live timer is pointless — the process will almost
// certainly restart first, and every reconcile re-arms it anyway.
const REARM_MAX_DELAY_MS = 6 * 60 * 60_000
// Backstop pull. Every other trigger is an edge — a notify webhook (which is
// fire-and-forget and can simply be lost), a finalized Manyfold turn, a runtime
// boot report, or an armed alarm's post-fire check. Binding a channel in the
// NarraNexus dashboard and then waiting in the IM app hits none of them, so a
// dropped notify left the channel unregistered with no signal at all.
const SWEEP_INTERVAL_MS = 5 * 60_000

// Inverse of the sync mapper's provider translation: what NarraNexus calls a
// channel when it asks us to deliver, mapped back to the Manyfold provider that
// mirrors it. narramessenger arrives as a matrix row, which is exactly why the
// row also has to be a mirror before we accept it.
const NARRANEXUS_PROVIDER_TO_MANYFOLD: Record<string, ChannelProviderName> = {
    lark: 'lark',
    telegram: 'telegram',
    discord: 'discord',
    wechat: 'weixin',
    narramessenger: 'matrix'
}

@Injectable()
export class NarraNexusSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(NarraNexusSyncService.name)
    private readonly inflight = new Map<string, Promise<void>>()
    private readonly dirty = new Set<string>()
    private readonly lastRun = new Map<string, number>()
    private readonly lastSuccessAt = new Map<string, number>()
    private readonly failures = new Map<string, number>()
    private readonly pendingKicks = new Map<string, NodeJS.Timeout>()
    private sweepTimer: NodeJS.Timeout | null = null
    private readonly rearmTimers = new Map<
        string,
        { timer: NodeJS.Timeout; armedFor: number }
    >()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly events: AppEventsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly reconcile: AgentReconcileService,
        private readonly automations: AutomationsService,
        private readonly channels: ChannelsService,
        private readonly rateLimit: DaemonRateLimitService,
        private readonly channelBridge: ChannelBridgeService,
        private readonly channelRepo: ChannelsRepository
    ) {}

    onModuleInit(): void {
        this.events.on('chat.turn.finalized', ({ agentId, framework }) => {
            if (framework !== 'narranexus') return
            void this.touchByAgent(agentId)
        })
        this.events.on('runtime.report.ready', ({ runtimeId, framework }) => {
            if (framework !== 'narranexus') return
            this.touchRuntime(runtimeId, { external: true })
        })
        this.sweepTimer = setInterval(() => {
            void this.sweep()
        }, SWEEP_INTERVAL_MS)
        this.sweepTimer.unref?.()
    }

    onModuleDestroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        this.sweepTimer = null
        for (const timer of this.pendingKicks.values()) clearTimeout(timer)
        this.pendingKicks.clear()
        for (const { timer } of this.rearmTimers.values()) clearTimeout(timer)
        this.rearmTimers.clear()
    }

    // Only runtimes whose sandbox is already running. A reconcile is two HTTP
    // calls to the sandbox ingress, and on Fly that wakes a suspended machine —
    // an unconditional sweep would hold every NarraNexus sandbox awake forever
    // and bill the user for it. Skipping the asleep ones costs nothing: with
    // the sandbox down there is no NarraNexus to serve the channel anyway, and
    // the next tick after it wakes picks the binding up. spriteStatus is
    // maintained by the sprite-status poller off the control plane, so reading
    // it here wakes nothing.
    private async sweep(): Promise<void> {
        try {
            const rows = await this.db
                .selectDistinct({ runtimeId: agents.runtimeId })
                .from(agents)
                .where(
                    and(
                        eq(agents.framework, 'narranexus'),
                        eq(agents.runtime, 'sprites'),
                        eq(agents.spriteStatus, 'running'),
                        isNotNull(agents.runtimeId)
                    )
                )
            for (const row of rows)
                if (row.runtimeId) this.touchRuntime(row.runtimeId)
        } catch (err) {
            this.log.warn(`sync sweep failed: ${(err as Error).message}`)
        }
    }

    // Webhook entry: same trust chain as runtime reports (per-runtime bearer,
    // pre-auth IP window, post-auth per-runtime window, uniform 401s), minus
    // the generation fence — config events are not boot-scoped.
    async notify(
        ip: string,
        bearer: string | null,
        dto: NotifySyncDto
    ): Promise<void> {
        const runtime = await this.authenticateRuntime(ip, bearer, dto.runtimeId)
        this.touchRuntime(runtime.id, { external: true })
    }

    private async authenticateRuntime(
        ip: string,
        bearer: string | null,
        runtimeId: string
    ): Promise<AgentRuntimeRow> {
        this.rateLimit.sweep()
        this.rateLimit.consume({
            key: `nx-sync-ip:${ip}`,
            limit: IP_RATE_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        if (!bearer) throw new UnauthorizedException('unauthorized')
        const runtime = await this.runtimes.findById(runtimeId)
        if (
            !runtime ||
            runtime.kind !== 'sprites' ||
            runtime.framework !== 'narranexus'
        )
            throw new UnauthorizedException('unauthorized')
        const stored = await loadRuntimeReportToken(
            this.db,
            this.crypto,
            runtime.id
        )
        if (!stored || !tokensMatch(bearer, stored))
            throw new UnauthorizedException('unauthorized')
        this.rateLimit.consume({
            key: `nx-sync-runtime:${runtime.id}`,
            limit: RUNTIME_RATE_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return runtime
    }

    // Platform-side outbound for a hosted channel: the agent asks Manyfold to
    // deliver, instead of Manyfold handing the agent a reply credential and
    // letting it call the IM API itself.
    //
    // The credential is the smaller half of the reason. NarraNexus found on
    // staging that a model with no context_token guessed one (it sent the
    // sender_id) and iLink accepted the send — and our own iLink client treats
    // context_token as optional on every call. So keeping the token secret was
    // never what stopped an agent from messaging an arbitrary person; the only
    // real control is binding the recipient, and that has to happen somewhere
    // the model cannot reach. Here, the request names a room and nothing else:
    // Manyfold resolves the recipient, and refuses a room nobody has written
    // to. wechat is stricter still — its sendDirect needs a reply credential
    // that only arrives with an inbound message, so an unsolicited DM cannot
    // even be attempted.
    async channelSend(
        ip: string,
        bearer: string | null,
        dto: ChannelSendDto
    ): Promise<{
        deliveryId: string
        status: 'sent' | 'queued' | 'failed'
        providerMessageId: string | null
        deduplicated: boolean
    }> {
        const runtime = await this.authenticateRuntime(ip, bearer, dto.runtimeId)
        const text = dto.text?.trim() ? dto.text : null
        const files = (dto.attachments ?? []).map((a) => {
            const relPath = a.path.trim().replace(/^\/?(?:workspace\/)?/, '')
            if (!relPath)
                throw new BadRequestException(`invalid file path: ${a.path}`)
            return { relPath, name: relPath.split('/').pop() ?? relPath }
        })
        if (!text && files.length === 0)
            throw new BadRequestException('text or attachments is required')

        const [agent] = await this.db
            .select()
            .from(agents)
            .where(
                and(
                    eq(agents.runtimeId, runtime.id),
                    eq(agents.framework, 'narranexus'),
                    eq(agents.internalId, dto.agentId)
                )
            )
            .limit(1)
        if (!agent)
            throw new NotFoundException(`unknown agent ${dto.agentId}`)

        const channel = await this.resolveMirroredChannel(agent, dto.provider)
        if (channel.status !== 'active')
            throw new BadRequestException(
                `channel is ${channel.status}; only active channels can send`
            )
        if (!(await this.channelRepo.hasSessionForRoom(channel.id, dto.roomId)))
            throw new BadRequestException(
                `no inbound history for this room — an agent may only reply where it was spoken to`
            )

        const key = dto.idempotencyKey?.trim() || null
        if (key) {
            const seen = await this.channelRepo.findAgentSendByKey(
                channel.id,
                key
            )
            if (seen)
                return {
                    deliveryId: String(seen.id),
                    status:
                        seen.status === 'sent'
                            ? 'sent'
                            : seen.status === 'dead'
                              ? 'failed'
                              : 'queued',
                    providerMessageId: seen.providerMessageId,
                    deduplicated: true
                }
        }

        // wechat has no addressable chat, only a peer; every other provider we
        // mirror addresses the room. Both carry the same meaning here: the
        // conversation this turn arrived in.
        const target: ChannelSendTarget =
            channel.provider === 'weixin'
                ? { kind: 'user', userId: dto.roomId }
                : { kind: 'chat', chatId: dto.roomId }
        const sent = await this.channelBridge.sendAgentDirect(
            channel,
            target,
            text,
            files,
            key
        )
        return {
            deliveryId: String(sent.deliveryId),
            status: sent.status,
            providerMessageId: sent.providerMessageId,
            deduplicated: false
        }
    }

    // The binding is (nx agent, provider), the same key syncChannels reconciles
    // on, and only mirrored rows qualify: a channel the user built themselves
    // is not something a hosted agent may send through.
    private async resolveMirroredChannel(
        agent: Agent,
        nxProvider: string
    ): Promise<ChannelRow> {
        const provider = NARRANEXUS_PROVIDER_TO_MANYFOLD[nxProvider]
        if (!provider)
            throw new BadRequestException(`unsupported provider ${nxProvider}`)
        const rows = await this.db
            .select()
            .from(channels)
            .where(
                and(
                    eq(channels.agentId, agent.id),
                    eq(channels.provider, provider),
                    isNotNull(channels.origin)
                )
            )
        const mirrored = rows.filter(
            (row) => (row.origin as ChannelOrigin | null)?.kind === 'narranexus'
        )
        if (mirrored.length === 0)
            throw new NotFoundException(
                `no mirrored ${nxProvider} channel for agent ${agent.internalId}`
            )
        return mirrored[0]
    }

    // Debounced single-flight per runtime (agent-reconcile pattern): bursts
    // coalesce into one trailing reconcile, failures back off with a bounded
    // self-retry, and any external event resets the failure budget.
    touchRuntime(
        runtimeId: string,
        opts: { external?: boolean; force?: boolean } = {}
    ): void {
        if (opts.external) this.failures.delete(runtimeId)
        if (this.inflight.has(runtimeId)) {
            this.dirty.add(runtimeId)
            return
        }
        if (!opts.force) {
            const last = this.lastRun.get(runtimeId) ?? 0
            const wait = last + MIN_INTERVAL_MS - Date.now()
            if (wait > 0) {
                this.scheduleKick(runtimeId, wait)
                return
            }
        }
        this.run(runtimeId)
    }

    private async touchByAgent(agentId: string): Promise<void> {
        const [row] = await this.db
            .select({ runtimeId: agents.runtimeId })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (row?.runtimeId) this.touchRuntime(row.runtimeId, { external: true })
    }

    private run(runtimeId: string): void {
        const p = this.reconcileRuntime(runtimeId)
            .then(() => {
                this.failures.delete(runtimeId)
                this.lastSuccessAt.set(runtimeId, Date.now())
            })
            .catch((err) => {
                const count = (this.failures.get(runtimeId) ?? 0) + 1
                this.failures.set(runtimeId, count)
                this.log.warn(
                    `reconcile failed for runtime ${runtimeId} (attempt ${count}): ${(err as Error).message}`
                )
                if (count <= RETRY_BACKOFF_MS.length)
                    this.scheduleKick(runtimeId, RETRY_BACKOFF_MS[count - 1])
            })
            .finally(() => {
                this.inflight.delete(runtimeId)
                this.lastRun.set(runtimeId, Date.now())
                if (this.dirty.delete(runtimeId))
                    this.scheduleKick(runtimeId, MIN_INTERVAL_MS)
            })
        this.inflight.set(runtimeId, p)
    }

    private scheduleKick(runtimeId: string, delayMs: number): void {
        if (this.pendingKicks.has(runtimeId)) return
        const timer = setTimeout(() => {
            this.pendingKicks.delete(runtimeId)
            this.touchRuntime(runtimeId)
        }, delayMs)
        timer.unref?.()
        this.pendingKicks.set(runtimeId, timer)
    }

    private async reconcileRuntime(runtimeId: string): Promise<void> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (
            !runtime ||
            runtime.kind !== 'sprites' ||
            runtime.framework !== 'narranexus' ||
            runtime.status === 'stopped'
        )
            return
        if (!runtime.ingressHost) return
        const token = await loadNarraNexusGatewayToken(
            this.db,
            this.crypto,
            runtime.id
        )
        if (!token) {
            this.log.warn(
                `runtime ${runtime.id} has no gateway token — skipping sync`
            )
            return
        }

        const jobs = await this.fetchList<NarraNexusJobsResponse>(
            runtime.ingressHost,
            '/manyfold/jobs',
            token
        )
        const bindings = await this.fetchList<NarraNexusChannelsResponse>(
            runtime.ingressHost,
            '/manyfold/channels',
            token
        )

        const agentRows = await this.db
            .select()
            .from(agents)
            .where(
                and(
                    eq(agents.runtimeId, runtime.id),
                    eq(agents.framework, 'narranexus')
                )
            )
        const agentsByInternalId = new Map(
            agentRows.map((a) => [a.internalId, a])
        )

        const minArmedAt = await this.syncJobs(
            runtime,
            agentsByInternalId,
            jobs.data ?? []
        )
        await this.syncChannels(
            runtime,
            agentsByInternalId,
            bindings.data ?? []
        )
        this.armRearmTimer(runtime.id, minArmedAt)
    }

    private async fetchList<T extends { data?: unknown[] }>(
        ingressHost: string,
        path: string,
        token: string
    ): Promise<T> {
        const res = await narraNexusFetch(ingressHost, path, token)
        if (!res.ok)
            throw new Error(`${path} failed (status ${res.status})`)
        const parsed = res.json<T>()
        // A malformed payload must abort the round: pruning against a body
        // we cannot parse would delete every mirrored row.
        if (!Array.isArray(parsed.data))
            throw new Error(`${path} returned an unexpected shape`)
        return parsed
    }

    private async syncJobs(
        runtime: AgentRuntimeRow,
        agentsByInternalId: Map<string, Agent>,
        jobs: NarraNexusJobsResponse['data'] & unknown[]
    ): Promise<number | null> {
        const now = new Date()
        const desired = new Map<string, { spec: MappedJob; agent: Agent }>()
        let missingAgents = false
        for (const job of jobs) {
            const spec = mapJob(runtime.id, job, now)
            if (!spec) continue
            const agent = agentsByInternalId.get(spec.nxAgentId)
            if (!agent) {
                missingAgents = true
                continue
            }
            desired.set(spec.jobId, { spec, agent })
        }

        const agentIds = [...agentsByInternalId.values()].map((a) => a.id)
        const existing = (
            await this.automations.listManagedByAgents(agentIds)
        ).filter(
            (row) =>
                row.origin?.kind === 'narranexus' &&
                row.origin.runtimeId === runtime.id
        )

        const seen = new Set<string>()
        for (const row of existing) {
            const jobId = row.origin!.jobId
            const match = jobId && !seen.has(jobId) ? desired.get(jobId) : null
            if (!match) {
                await this.automations.removeManaged(row.id)
                continue
            }
            seen.add(jobId)
            if (match.spec.contentHash !== row.origin!.contentHash)
                await this.automations.updateManaged(row.id, match.spec)
        }
        for (const [jobId, { spec, agent }] of desired) {
            if (seen.has(jobId)) continue
            await this.automations.createManaged(agent, spec)
        }

        if (missingAgents) {
            // The job's agent exists only inside NarraNexus so far — let the
            // agent reconciler discover it; the next sync round maps it.
            this.reconcile.touchRuntime(runtime)
            this.log.log(
                `runtime ${runtime.id} has jobs for undiscovered agents — agent reconcile touched`
            )
        }

        let minArmedAt: number | null = null
        for (const { spec } of desired.values()) {
            if (spec.status !== 'active' || !spec.nextRunAt) continue
            const at = spec.nextRunAt.getTime()
            if (minArmedAt === null || at < minArmedAt) minArmedAt = at
        }
        return minArmedAt
    }

    private async syncChannels(
        runtime: AgentRuntimeRow,
        agentsByInternalId: Map<string, Agent>,
        bindings: NarraNexusChannelsResponse['data'] & unknown[]
    ): Promise<void> {
        const desired = new Map<string, { spec: MappedChannel; agent: Agent }>()
        let missingAgents = false
        for (const binding of bindings) {
            const spec = mapChannel(runtime.id, binding)
            if (!spec) continue
            const agent = agentsByInternalId.get(spec.nxAgentId)
            if (!agent) {
                missingAgents = true
                continue
            }
            desired.set(`${spec.nxAgentId}::${spec.provider}`, { spec, agent })
        }
        if (missingAgents) {
            // Same undiscovered-agent path as syncJobs, and it must say so: a
            // silent skip here reads as "NarraNexus has no bindings" while the
            // agent's IM stays dead (its channels worker is off under
            // NEXUS_EXTERNAL_TRIGGERS).
            this.reconcile.touchRuntime(runtime)
            this.log.log(
                `runtime ${runtime.id} has channel bindings for undiscovered agents — agent reconcile touched`
            )
        }

        const agentIds = [...agentsByInternalId.values()].map((a) => a.id)
        const existing =
            agentIds.length === 0
                ? []
                : (
                      await this.db
                          .select()
                          .from(channels)
                          .where(
                              and(
                                  inArray(channels.agentId, agentIds),
                                  isNotNull(channels.origin)
                              )
                          )
                  ).filter(
                      (row) =>
                          row.origin?.kind === 'narranexus' &&
                          row.origin.runtimeId === runtime.id
                  )

        // Deletes run before creates so a re-bound external account frees its
        // (provider, externalId) slot within the same round.
        const seen = new Set<string>()
        const pendingUpdates: {
            row: ChannelRow
            spec: MappedChannel
        }[] = []
        for (const row of existing) {
            const key = `${row.origin!.nxAgentId}::${row.provider}`
            const match = !seen.has(key) ? desired.get(key) : null
            if (!match) {
                await this.deleteChannel(row)
                continue
            }
            seen.add(key)
            if (match.spec.contentHash !== row.origin!.contentHash)
                pendingUpdates.push({ row, spec: match.spec })
        }
        for (const { row, spec } of pendingUpdates) {
            try {
                await this.channels.update(
                    row.userId,
                    row.id,
                    {
                        label: spec.label,
                        config: spec.config as ChannelConfig,
                        credentials: spec.credentials as ChannelCredentials
                    },
                    true
                )
                await this.db
                    .update(channels)
                    .set({ origin: spec.origin })
                    .where(eq(channels.id, row.id))
            } catch (err) {
                this.log.warn(
                    `channel update failed (${row.id}, ${row.provider}): ${(err as Error).message}`
                )
            }
        }
        for (const [key, { spec, agent }] of desired) {
            if (seen.has(key)) continue
            try {
                await this.channels.create(
                    agent.userId,
                    {
                        agentId: agent.id,
                        provider: spec.provider,
                        label: spec.label,
                        config: spec.config as ChannelConfig,
                        credentials: spec.credentials as ChannelCredentials
                    },
                    { externalId: spec.externalId, origin: spec.origin }
                )
            } catch (err) {
                // Includes external_account_already_bound (the bot is already
                // connected to a user-created channel): never hijack, keep
                // the rest of the round going.
                this.log.warn(
                    `channel create failed (${spec.provider}, agent ${agent.id}): ${(err as Error).message}`
                )
            }
        }
    }

    private async deleteChannel(row: ChannelRow): Promise<void> {
        try {
            await this.channels.delete(row.userId, row.id, true)
        } catch (err) {
            this.log.warn(
                `channel delete failed (${row.id}): ${(err as Error).message}`
            )
        }
    }

    private armRearmTimer(runtimeId: string, minArmedAt: number | null): void {
        const current = this.rearmTimers.get(runtimeId)
        if (current) {
            clearTimeout(current.timer)
            this.rearmTimers.delete(runtimeId)
        }
        if (minArmedAt === null) return
        const delay = minArmedAt + REARM_GRACE_MS - Date.now()
        if (delay > REARM_MAX_DELAY_MS) return
        const timer = setTimeout(
            () => {
                this.rearmTimers.delete(runtimeId)
                const lastSuccess = this.lastSuccessAt.get(runtimeId) ?? 0
                if (lastSuccess > minArmedAt) return
                this.touchRuntime(runtimeId, { external: true })
            },
            Math.max(0, delay)
        )
        timer.unref?.()
        this.rearmTimers.set(runtimeId, { timer, armedFor: minArmedAt })
    }
}

const tokensMatch = (presented: string, stored: string): boolean =>
    timingSafeEqual(
        createHash('sha256').update(presented).digest(),
        createHash('sha256').update(stored).digest()
    )
