import {
    AGENT_SEND_PROVIDERS,
    AgentFramework,
    AutomationDeliveryStatus,
    AutomationDeliveryTarget,
    AutomationDetail,
    AutomationRunStatus,
    AutomationRunSummary,
    AutomationRunTrigger,
    AutomationSchedulePreset,
    AutomationSummary,
    CreateAutomationBody,
    UpdateAutomationBody,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    and,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    lte,
    sql
} from 'drizzle-orm'
import { rrulestr } from 'rrule'
import {
    agents,
    automations,
    automationRuns,
    channels,
    channelSessions,
    chatStreamEvents,
    type Agent,
    type AutomationOrigin,
    type AutomationRow,
    type AutomationRunRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { ChannelBridgeService } from '@/modules/channels/channel-bridge.service'
import type { ChannelSendTarget } from '@/modules/channels/channel-provider'
import { ChatService } from '@/modules/chat/chat.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { ForbiddenException } from '@nestjs/common'

type AutomationWithAgent = {
    automation: AutomationRow
    agent: Agent
}

// Mirror of an external framework schedule (the NarraNexus sync reconciler is
// the only writer): a one-shot alarm at nextRunAt, re-armed by the reconciler
// after each run instead of by an RRULE recurrence.
export interface ManagedAutomationSpec {
    title: string
    prompt: string
    status: 'active' | 'paused'
    nextRunAt: Date | null
    origin: AutomationOrigin
}

const MANAGED_RRULE = 'RRULE:FREQ=DAILY;COUNT=1'

const schedulePresets: AutomationSchedulePreset[] = [
    'hourly',
    'daily',
    'weekdays',
    'weekly',
    'custom'
]

const modelOverrideFrameworks: ReadonlySet<AgentFramework> = new Set([
    'claude-code',
    'codex',
    'gemini-cli'
])

@Injectable()
export class AutomationsService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(AutomationsService.name)
    private scheduler: NodeJS.Timeout | null = null
    private ticking = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly chat: ChatService,
        private readonly config: ConfigService,
        private readonly runtimeAccess: RuntimeAccessService,
        @Optional()
        private readonly modelConfigs?: AgentModelConfigService,
        @Optional()
        private readonly channelBridge?: ChannelBridgeService
    ) {}

    onModuleInit(): void {
        if (this.config.get('AUTOMATIONS_SCHEDULER_ENABLED') === 'false') return
        const intervalMs = Math.max(
            5000,
            Number(
                this.config.get('AUTOMATIONS_SCHEDULER_INTERVAL_MS') ?? 30000
            )
        )
        this.scheduler = setInterval(() => {
            void this.tick()
        }, intervalMs)
        this.scheduler.unref?.()
    }

    onModuleDestroy(): void {
        if (this.scheduler) clearInterval(this.scheduler)
    }

    async list(userId: string, agentId?: string): Promise<AutomationSummary[]> {
        await this.reconcileRunning(userId)
        const whereExpr = agentId
            ? and(
                  eq(automations.userId, userId),
                  eq(automations.agentId, agentId),
                  isNull(automations.deletedAt)
              )
            : and(
                  eq(automations.userId, userId),
                  isNull(automations.deletedAt)
              )
        const rows = await this.db
            .select({
                automation: automations,
                agent: agents,
                // Index-backed correlated read (automation_runs_automation_
                // started_idx) so a list surface can show "last run failed"
                // without loading run history per row.
                lastRunStatus: sql<string | null>`(
                    select ${automationRuns.status} from ${automationRuns}
                    where ${automationRuns.automationId} = ${automations.id}
                    order by ${automationRuns.startedAt} desc limit 1
                )`
            })
            .from(automations)
            .innerJoin(agents, eq(automations.agentId, agents.id))
            .where(whereExpr)
            .orderBy(desc(automations.updatedAt), desc(automations.createdAt))
        return rows.map((row) =>
            toSummary(row, (row.lastRunStatus as AutomationRunStatus) ?? null)
        )
    }

    async get(userId: string, id: string): Promise<AutomationDetail> {
        await this.reconcileRunning(userId)
        return this.toDetail(await this.loadOwned(userId, id))
    }

    async create(
        userId: string,
        body: CreateAutomationBody
    ): Promise<AutomationDetail> {
        const agent = await this.loadAgent(userId, body.agentId)
        assertRunnableAgent(agent, body.model ?? null)
        await this.assertAutomationModelConfig(
            userId,
            agent,
            body.model ?? null
        )
        const schedule = normalizeSchedule({
            schedulePreset: body.schedulePreset,
            rrule: body.rrule,
            timezone: body.timezone,
            dtstart: body.dtstart
        })
        const delivery = await this.resolveDelivery(
            userId,
            agent.id,
            body.deliveryChannelId ?? null,
            body.deliveryTarget ?? null,
            { verifyScopeLiveness: true }
        )
        await this.runtimeAccess.reserveAutomationSlot(userId)
        const now = new Date()
        const id = createObjectId('automation')
        await this.db.insert(automations).values({
            id,
            userId,
            agentId: agent.id,
            title: body.title.trim(),
            prompt: body.prompt.trim(),
            status: 'active',
            schedulePreset: schedule.schedulePreset,
            rrule: schedule.rrule,
            timezone: schedule.timezone,
            dtstart: schedule.dtstart,
            model: normalizeModel(body.model),
            deliveryChannelId: delivery.deliveryChannelId,
            deliveryTarget: delivery.deliveryTarget,
            nextRunAt: schedule.nextRunAt,
            lastRunAt: null,
            createdAt: now,
            updatedAt: now
        })
        return this.get(userId, id)
    }

    async update(
        userId: string,
        id: string,
        body: UpdateAutomationBody
    ): Promise<AutomationDetail> {
        const existing = await this.loadOwned(userId, id)
        assertNotManaged(existing.automation)
        const agent = body.agentId
            ? await this.loadAgent(userId, body.agentId)
            : existing.agent
        const nextModel =
            body.model === undefined
                ? existing.automation.model
                : normalizeModel(body.model)
        assertRunnableAgent(agent, nextModel)
        await this.assertAutomationModelConfig(userId, agent, nextModel)

        const schedule = normalizeSchedule({
            schedulePreset:
                body.schedulePreset ?? existing.automation.schedulePreset,
            rrule: body.rrule ?? existing.automation.rrule,
            timezone: body.timezone ?? existing.automation.timezone,
            dtstart: body.dtstart ?? existing.automation.dtstart.toISOString()
        })
        const requestedChannelId =
            body.deliveryChannelId === undefined
                ? existing.automation.deliveryChannelId
                : body.deliveryChannelId
        const storedTarget = parseDeliveryTarget(
            existing.automation.deliveryTarget
        )
        const requestedTarget =
            body.deliveryTarget === undefined
                ? storedTarget
                : parseDeliveryTarget(body.deliveryTarget)
        const deliveryChanged =
            requestedChannelId !== existing.automation.deliveryChannelId ||
            !deliveryTargetsEqual(requestedTarget, storedTarget)
        const delivery = await this.resolveDelivery(
            userId,
            agent.id,
            requestedChannelId,
            body.deliveryTarget === undefined
                ? storedTarget
                : body.deliveryTarget,
            { verifyScopeLiveness: deliveryChanged }
        )
        const now = new Date()
        await this.db
            .update(automations)
            .set({
                agentId: agent.id,
                title: body.title?.trim() ?? existing.automation.title,
                prompt: body.prompt?.trim() ?? existing.automation.prompt,
                status: body.status ?? existing.automation.status,
                schedulePreset: schedule.schedulePreset,
                rrule: schedule.rrule,
                timezone: schedule.timezone,
                dtstart: schedule.dtstart,
                model: nextModel,
                deliveryChannelId: delivery.deliveryChannelId,
                deliveryTarget: delivery.deliveryTarget,
                nextRunAt: schedule.nextRunAt,
                updatedAt: now
            })
            .where(eq(automations.id, id))
        return this.get(userId, id)
    }

    async runNow(userId: string, id: string): Promise<AutomationRunSummary> {
        await this.reconcileRunning(userId)
        return this.startRun(await this.loadOwned(userId, id), 'manual', true)
    }

    // Deletion is two-phase (#588): tombstone now, hard-delete in the
    // retention sweep. Runs stay queryable in PostgreSQL until the purge.
    async delete(userId: string, id: string): Promise<void> {
        const existing = await this.loadOwned(userId, id)
        assertNotManaged(existing.automation)
        await this.tombstone(id)
    }

    // nextRunAt is cleared as a second line of defence: even a scan that
    // forgets the deletedAt filter then finds nothing due.
    private async tombstone(id: string): Promise<void> {
        const now = new Date()
        await this.db
            .update(automations)
            .set({ deletedAt: now, nextRunAt: null, updatedAt: now })
            .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
    }

    private async tick(): Promise<void> {
        if (this.ticking) return
        this.ticking = true
        try {
            await this.reconcileRunning()
            const now = new Date()
            const due = await this.db
                .select({ automation: automations, agent: agents })
                .from(automations)
                .innerJoin(agents, eq(automations.agentId, agents.id))
                .where(
                    and(
                        eq(automations.status, 'active'),
                        lte(automations.nextRunAt, now),
                        isNull(automations.deletedAt)
                    )
                )
                .orderBy(automations.nextRunAt)
                .limit(10)

            for (const row of due) {
                try {
                    await this.startRun(row, 'scheduled', false)
                } catch (err) {
                    if (err instanceof ConflictException) continue
                    if (
                        err instanceof ForbiddenException &&
                        (err.getResponse() as { code?: string }).code ===
                            'AUTOMATION_RUN_QUOTA_REACHED'
                    ) {
                        await this.deferAutomationAfterQuotaSkip(
                            row.automation,
                            now
                        )
                        this.log.warn(
                            `scheduled automation ${row.automation.id} skipped: monthly run quota reached for user ${row.automation.userId}`
                        )
                        continue
                    }
                    this.log.warn(
                        `scheduled automation ${row.automation.id} failed to start: ${(err as Error).message}`
                    )
                }
            }
        } finally {
            this.ticking = false
        }
    }

    private async startRun(
        row: AutomationWithAgent,
        trigger: AutomationRunTrigger,
        throwOnError: boolean
    ): Promise<AutomationRunSummary> {
        const running = await this.db
            .select({ id: automationRuns.id })
            .from(automationRuns)
            .where(
                and(
                    eq(automationRuns.automationId, row.automation.id),
                    eq(automationRuns.status, 'running')
                )
            )
            .limit(1)
        if (running.length > 0)
            throw new ConflictException('automation already has a running run')

        // Managed mirrors are throttled by their source framework's own
        // quota machine, not the user's plan.
        if (!row.automation.origin)
            await this.runtimeAccess.reserveAutomationRun(
                row.automation.userId
            )

        const startedAt = new Date()
        const [run] = await this.db
            .insert(automationRuns)
            .values({
                id: createObjectId('automationRun'),
                automationId: row.automation.id,
                userId: row.automation.userId,
                agentId: row.agent.id,
                trigger,
                status: 'running',
                chatSessionId: null,
                assistantMessageId: null,
                errorMessage: null,
                titleSnapshot: row.automation.title,
                promptSnapshot: row.automation.prompt,
                rruleSnapshot: row.automation.rrule,
                modelSnapshot: row.automation.model,
                startedAt,
                finishedAt: null,
                createdAt: startedAt
            })
            .returning()

        try {
            if (row.agent.status !== 'running')
                throw new BadRequestException(`agent is ${row.agent.status}`)
            // The caller's row may predate a concurrent delete (a scheduler
            // tick holding a stale due list, or runNow racing DELETE).
            // Re-check right before dispatch: a tombstone committed by now
            // fails the run instead of executing it, and anything later is
            // indistinguishable from deleting during a running run.
            await this.assertLive(row.automation.id)
            const session = await this.chat.createSession(
                row.automation.userId,
                row.agent.id,
                row.automation.title
            )
            const model = modelOverrideFrameworks.has(row.agent.framework)
                ? row.automation.model
                : null
            const sent = await this.chat.sendMessage(
                row.automation.userId,
                row.agent.id,
                session.id,
                row.automation.prompt,
                [],
                model ?? undefined
            )
            const [updatedRun] = await this.db
                .update(automationRuns)
                .set({
                    chatSessionId: session.id,
                    assistantMessageId: sent.assistantMessageId
                })
                .where(eq(automationRuns.id, run.id))
                .returning()
            await this.advanceAutomation(row.automation, startedAt)
            return toRunSummary(updatedRun)
        } catch (err) {
            const message = (err as Error).message
            const [failedRun] = await this.db
                .update(automationRuns)
                .set({
                    status: 'failed',
                    errorMessage: message,
                    finishedAt: new Date()
                })
                .where(eq(automationRuns.id, run.id))
                .returning()
            await this.advanceAutomation(row.automation, startedAt)
            if (throwOnError) {
                if (err instanceof HttpException) throw err
                throw new BadRequestException(message)
            }
            return toRunSummary(failedRun)
        }
    }

    private async assertLive(id: string): Promise<void> {
        const rows = await this.db
            .select({ id: automations.id })
            .from(automations)
            .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
            .limit(1)
        if (rows.length === 0)
            throw new ConflictException('automation was deleted')
    }

    // Schedule bookkeeping is predicated on the tombstone so a lost race
    // never re-arms nextRunAt on a deleted automation.
    private async advanceAutomation(
        row: AutomationRow,
        ranAt: Date
    ): Promise<void> {
        const nextRunAt = nextOccurrence({
            rrule: row.rrule,
            timezone: row.timezone,
            dtstart: row.dtstart,
            after: ranAt
        })
        await this.db
            .update(automations)
            .set({
                lastRunAt: ranAt,
                nextRunAt,
                updatedAt: new Date()
            })
            .where(
                and(eq(automations.id, row.id), isNull(automations.deletedAt))
            )
    }

    private async deferAutomationAfterQuotaSkip(
        row: AutomationRow,
        skippedAt: Date
    ): Promise<void> {
        const quotaResetAt = startOfNextUtcMonth(skippedAt)
        const nextRunAt = nextOccurrence({
            rrule: row.rrule,
            timezone: row.timezone,
            dtstart: row.dtstart,
            after: new Date(quotaResetAt.getTime() - 1)
        })
        await this.db
            .update(automations)
            .set({
                nextRunAt,
                updatedAt: new Date()
            })
            .where(
                and(eq(automations.id, row.id), isNull(automations.deletedAt))
            )
    }

    private async reconcileRunning(userId?: string): Promise<void> {
        const whereExpr = userId
            ? and(
                  eq(automationRuns.status, 'running'),
                  eq(automationRuns.userId, userId)
              )
            : eq(automationRuns.status, 'running')
        const rows = await this.db
            .select({ run: automationRuns, automation: automations })
            .from(automationRuns)
            .innerJoin(
                automations,
                eq(automationRuns.automationId, automations.id)
            )
            .where(whereExpr)
            .orderBy(automationRuns.startedAt)
            .limit(100)

        for (const { run, automation } of rows) {
            if (!run.assistantMessageId) continue
            const terminal = await this.db
                .select({
                    eventType: chatStreamEvents.eventType,
                    payloadJson: chatStreamEvents.payloadJson
                })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, run.assistantMessageId),
                        inArray(chatStreamEvents.eventType, ['done', 'error'])
                    )
                )
                .orderBy(desc(chatStreamEvents.id))
                .limit(1)
            const event = terminal[0]
            if (!event) continue
            const failed = event.eventType === 'error'
            const resultPreview = failed
                ? null
                : await this.loadResultPreview(run.assistantMessageId)
            // CAS on status='running': reconcile runs concurrently (tick +
            // list/get), and only the flip winner may deliver — a lost race
            // must not send the result twice.
            const [flipped] = await this.db
                .update(automationRuns)
                .set({
                    status: failed ? 'failed' : 'succeeded',
                    errorMessage: failed
                        ? extractErrorMessage(event.payloadJson)
                        : null,
                    resultPreview,
                    finishedAt: new Date()
                })
                .where(
                    and(
                        eq(automationRuns.id, run.id),
                        eq(automationRuns.status, 'running')
                    )
                )
                .returning()
            if (!flipped) continue
            await this.maybeDeliverRun(flipped, automation)
        }
    }

    // Snapshotted so run history never re-reads a transcript that may have
    // been compacted away. A silence token reported nothing, so it previews as
    // nothing; a preview failure must not block the terminal flip.
    private async loadResultPreview(
        assistantMessageId: string
    ): Promise<string | null> {
        try {
            const outcome = await this.chat.getTurnOutcome(assistantMessageId)
            if (outcome.state !== 'done') return null
            const text = outcome.text.trim()
            if (text.length === 0 || isSilentReply(text)) return null
            return toResultPreview(text)
        } catch (err) {
            this.log.warn(
                `automation run preview snapshot failed for message ${assistantMessageId}: ${(err as Error).message}`
            )
            return null
        }
    }

    // Channel delivery of a finished run's outcome: fire once per run (the
    // reconcile CAS guarantees a single caller), never throw — a delivery
    // problem must not wedge the reconcile loop.
    private async maybeDeliverRun(
        run: AutomationRunRow,
        automation: AutomationRow
    ): Promise<void> {
        // Reconcile still finalizes run rows of tombstoned automations (the
        // retained history should show the true outcome), but a deleted
        // automation must not reach the channel anymore.
        if (automation.deletedAt) return
        const target = parseDeliveryTarget(automation.deliveryTarget)
        if (!automation.deliveryChannelId || !target) return
        let deliveryStatus: AutomationDeliveryStatus
        try {
            deliveryStatus = await this.deliverRunOutcome(
                run,
                automation.deliveryChannelId,
                target
            )
        } catch (err) {
            this.log.warn(
                `automation run ${run.id} channel delivery failed: ${(err as Error).message}`
            )
            deliveryStatus = 'failed'
        }
        await this.db
            .update(automationRuns)
            .set({ deliveryStatus })
            .where(eq(automationRuns.id, run.id))
    }

    private async deliverRunOutcome(
        run: AutomationRunRow,
        channelId: string,
        target: AutomationDeliveryTarget
    ): Promise<AutomationDeliveryStatus> {
        if (!this.channelBridge)
            throw new Error('channel bridge unavailable in this process')
        let body: string
        if (run.status === 'succeeded' && run.assistantMessageId) {
            const outcome = await this.chat.getTurnOutcome(
                run.assistantMessageId
            )
            const text = outcome.state === 'done' ? outcome.text.trim() : ''
            // The agent can decide the run is not worth a notification: a
            // bare silence token suppresses delivery but stays in the
            // transcript (openclaw's heartbeat-ok pattern).
            if (isSilentReply(text)) return 'suppressed'
            body = text.length > 0 ? text : '(empty response)'
        } else {
            body = `run failed: ${run.errorMessage ?? 'unknown error'}`
        }
        const [channel] = await this.db
            .select()
            .from(channels)
            .where(eq(channels.id, channelId))
            .limit(1)
        if (!channel || channel.status !== 'active')
            throw new Error(
                `delivery channel ${channelId} is ${channel?.status ?? 'missing'}`
            )
        const message = `⏰ ${run.titleSnapshot}\n\n${body}`
        if (target.kind === 'scope') {
            const sent = await this.channelBridge.sendAgentScoped(
                channel,
                target.scopeKey,
                message
            )
            return sent.status
        }
        const sendTarget: ChannelSendTarget =
            target.kind === 'chat'
                ? { kind: 'chat', chatId: target.id }
                : { kind: 'user', userId: target.id }
        const sent = await this.channelBridge.sendAgentDirect(
            channel,
            sendTarget,
            message
        )
        return sent.status
    }

    // Both-or-neither, strict target shape, channel owned by the user, bound
    // to the automation's agent. chat/user targets additionally need a
    // provider that can send directly; scope targets work on any provider but
    // must point at a live conversation. The bridge re-checks both at send
    // time. verifyScopeLiveness is skipped when an update carries the config
    // unchanged: session liveness is volatile (archival, rebind), and a
    // title-only or pause PATCH must not 400 on it.
    private async resolveDelivery(
        userId: string,
        agentId: string,
        channelId: string | null,
        target: AutomationDeliveryTarget | null,
        opts: { verifyScopeLiveness: boolean }
    ): Promise<{
        deliveryChannelId: string | null
        deliveryTarget: AutomationDeliveryTarget | null
    }> {
        if (!channelId && !target)
            return { deliveryChannelId: null, deliveryTarget: null }
        if (!channelId || !target)
            throw new BadRequestException(
                'deliveryChannelId and deliveryTarget must be set together'
            )
        const parsed = parseDeliveryTarget(target)
        if (!parsed)
            throw new BadRequestException(
                'deliveryTarget must be { kind: "chat" | "user", id } or { kind: "scope", scopeKey }'
            )
        const [channel] = await this.db
            .select()
            .from(channels)
            .where(
                and(eq(channels.id, channelId), eq(channels.userId, userId))
            )
            .limit(1)
        if (!channel)
            throw new NotFoundException('delivery channel not found')
        if (channel.agentId !== agentId)
            throw new BadRequestException(
                'delivery channel must be bound to the automation agent'
            )
        if (parsed.kind === 'scope') {
            if (opts.verifyScopeLiveness) {
                const [session] = await this.db
                    .select()
                    .from(channelSessions)
                    .where(
                        and(
                            eq(channelSessions.channelId, channelId),
                            eq(channelSessions.scopeKey, parsed.scopeKey),
                            eq(channelSessions.isActive, true),
                            isNull(channelSessions.archivedAt)
                        )
                    )
                    .limit(1)
                if (!session)
                    throw new BadRequestException(
                        'delivery scope has no active conversation on this channel'
                    )
            }
        } else if (!AGENT_SEND_PROVIDERS.includes(channel.provider))
            throw new BadRequestException(
                `${channel.provider} channels do not support agent send`
            )
        return { deliveryChannelId: channelId, deliveryTarget: parsed }
    }

    // Tombstoned mirrors are invisible to the reconciler: if the source job
    // still exists upstream it simply re-creates a fresh mirror row, while
    // the tombstone keeps its run history for the retention window.
    async listManagedByAgents(agentIds: string[]): Promise<AutomationRow[]> {
        if (agentIds.length === 0) return []
        return this.db
            .select()
            .from(automations)
            .where(
                and(
                    inArray(automations.agentId, agentIds),
                    isNotNull(automations.origin),
                    isNull(automations.deletedAt)
                )
            )
    }

    // Managed mirrors bypass plan slot reservation and the future-occurrence
    // schedule validation: nextRunAt is written verbatim (null = disarmed
    // until the reconciler re-arms it after the source job's next_run_time
    // is recomputed).
    async createManaged(
        agent: Agent,
        spec: ManagedAutomationSpec
    ): Promise<AutomationRow> {
        const now = new Date()
        const [row] = await this.db
            .insert(automations)
            .values({
                id: createObjectId('automation'),
                userId: agent.userId,
                agentId: agent.id,
                title: spec.title,
                prompt: spec.prompt,
                status: spec.status,
                schedulePreset: 'custom',
                rrule: MANAGED_RRULE,
                timezone: 'UTC',
                dtstart: spec.nextRunAt ?? now,
                model: null,
                deliveryChannelId: null,
                deliveryTarget: null,
                origin: spec.origin,
                nextRunAt: spec.nextRunAt,
                lastRunAt: null,
                createdAt: now,
                updatedAt: now
            })
            .returning()
        return row
    }

    async updateManaged(
        automationId: string,
        spec: ManagedAutomationSpec
    ): Promise<void> {
        await this.db
            .update(automations)
            .set({
                title: spec.title,
                prompt: spec.prompt,
                status: spec.status,
                dtstart: spec.nextRunAt ?? new Date(),
                origin: spec.origin,
                nextRunAt: spec.nextRunAt,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(automations.id, automationId),
                    isNull(automations.deletedAt)
                )
            )
    }

    // Managed removal follows the same retention lifecycle as user deletion
    // (#588): the mirror disappears from the product now, the purge sweep
    // hard-deletes it later.
    async removeManaged(automationId: string): Promise<void> {
        await this.tombstone(automationId)
    }

    private async toDetail(
        row: AutomationWithAgent
    ): Promise<AutomationDetail> {
        const runs = await this.db
            .select()
            .from(automationRuns)
            .where(eq(automationRuns.automationId, row.automation.id))
            .orderBy(desc(automationRuns.startedAt))
            .limit(20)
        return {
            ...toSummary(row, runs[0]?.status ?? null),
            prompt: row.automation.prompt,
            runs: runs.map(toRunSummary)
        }
    }

    private async loadOwned(
        userId: string,
        id: string
    ): Promise<AutomationWithAgent> {
        const rows = await this.db
            .select({ automation: automations, agent: agents })
            .from(automations)
            .innerJoin(agents, eq(automations.agentId, agents.id))
            .where(
                and(
                    eq(automations.id, id),
                    eq(automations.userId, userId),
                    isNull(automations.deletedAt)
                )
            )
            .limit(1)
        const row = rows[0]
        if (!row) throw new NotFoundException('automation not found')
        return row
    }

    private async loadAgent(userId: string, agentId: string): Promise<Agent> {
        const rows = await this.db
            .select()
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        const row = rows[0]
        if (!row) throw new NotFoundException('agent not found')
        return row
    }

    private async assertAutomationModelConfig(
        userId: string,
        agent: Agent,
        model: string | null
    ): Promise<void> {
        if (!this.modelConfigs) return
        if (!modelOverrideFrameworks.has(agent.framework)) return
        const view = await this.modelConfigs.getForAgent(
            userId,
            agent.id,
            false
        )
        if (view.source === 'runtime-local' && model)
            throw new BadRequestException(
                'Automation model override is only available when the agent uses Manyfold model config.'
            )
        await this.modelConfigs.resolveTurnConfig({
            callerUserId: userId,
            agentId: agent.id,
            model,
            saveAsDefault: false
        })
    }
}

interface ScheduleInput {
    schedulePreset: AutomationSchedulePreset
    rrule: string
    timezone: string
    dtstart?: string
}

interface NormalizedSchedule {
    schedulePreset: AutomationSchedulePreset
    rrule: string
    timezone: string
    dtstart: Date
    nextRunAt: Date
}

const normalizeSchedule = (input: ScheduleInput): NormalizedSchedule => {
    if (!schedulePresets.includes(input.schedulePreset))
        throw new BadRequestException('invalid schedule preset')
    const timezone = normalizeTimezone(input.timezone)
    const dtstart = parseDate(input.dtstart)
    const rrule = normalizeRrule(input.rrule)
    const nextRunAt = nextOccurrence({
        rrule,
        timezone,
        dtstart,
        after: new Date()
    })
    if (!nextRunAt)
        throw new BadRequestException('schedule has no future occurrence')
    return {
        schedulePreset: input.schedulePreset,
        rrule,
        timezone,
        dtstart,
        nextRunAt
    }
}

const normalizeRrule = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new BadRequestException('rrule is required')
    if (/[\r\n]/.test(trimmed))
        throw new BadRequestException('rrule must be a single line')
    const withPrefix = /^RRULE:/i.test(trimmed) ? trimmed : `RRULE:${trimmed}`
    try {
        rrulestr(withPrefix)
    } catch (err) {
        throw new BadRequestException(
            `invalid rrule: ${(err as Error).message}`
        )
    }
    return withPrefix
}

const normalizeTimezone = (value: string): string => {
    const timezone = value.trim()
    if (!timezone) throw new BadRequestException('timezone is required')
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(
            new Date()
        )
    } catch {
        throw new BadRequestException('invalid timezone')
    }
    return timezone
}

const parseDate = (value?: string): Date => {
    if (!value) return new Date()
    const date = new Date(value)
    if (Number.isNaN(date.getTime()))
        throw new BadRequestException('invalid dtstart')
    return date
}

const startOfNextUtcMonth = (date: Date): Date =>
    new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            1,
            0,
            0,
            0,
            0
        )
    )

const nextOccurrence = (input: {
    after: Date
    dtstart: Date
    rrule: string
    timezone: string
}): Date | null => {
    const dtstart = formatDateInTimeZone(input.dtstart, input.timezone)
    try {
        const rule = rrulestr(
            `DTSTART;TZID=${input.timezone}:${dtstart}\n${input.rrule}`
        ) as { after: (date: Date, inc?: boolean) => Date | null }
        return rule.after(input.after, false)
    } catch (err) {
        if (err instanceof BadRequestException) throw err
        throw new BadRequestException(
            `invalid schedule: ${(err as Error).message}`
        )
    }
}

const formatDateInTimeZone = (date: Date, timezone: string): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date)
    const get = (type: string): string =>
        parts.find((part) => part.type === type)?.value ?? '00'
    return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get(
        'minute'
    )}${get('second')}`
}

const normalizeModel = (model?: string | null): string | null => {
    const trimmed = model?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : null
}

const assertRunnableAgent = (agent: Agent, model: string | null): void => {
    if (model && !modelOverrideFrameworks.has(agent.framework))
        throw new BadRequestException(
            `model override is not supported for framework ${agent.framework}`
        )
}

const assertNotManaged = (row: AutomationRow): void => {
    if (row.origin)
        throw new ConflictException(
            'this automation mirrors a NarraNexus job — manage it in the NarraNexus dashboard'
        )
}

const toSummary = (
    row: AutomationWithAgent,
    lastRunStatus: AutomationRunStatus | null
): AutomationSummary => ({
    id: row.automation.id,
    userId: row.automation.userId,
    agentId: row.automation.agentId,
    agent: {
        id: row.agent.id,
        name: row.agent.name,
        framework: row.agent.framework,
        status: row.agent.status,
        model: row.agent.model
    },
    title: row.automation.title,
    status: row.automation.status,
    schedulePreset: row.automation.schedulePreset,
    rrule: row.automation.rrule,
    timezone: row.automation.timezone,
    dtstart: row.automation.dtstart.toISOString(),
    model: row.automation.model,
    deliveryChannelId: row.automation.deliveryChannelId,
    deliveryTarget: parseDeliveryTarget(row.automation.deliveryTarget),
    managed: row.automation.origin != null,
    nextRunAt: row.automation.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.automation.lastRunAt?.toISOString() ?? null,
    lastRunStatus,
    createdAt: row.automation.createdAt.toISOString(),
    updatedAt: row.automation.updatedAt.toISOString()
})

const toRunSummary = (run: AutomationRunRow): AutomationRunSummary => ({
    id: run.id,
    automationId: run.automationId,
    trigger: run.trigger,
    status: run.status as AutomationRunStatus,
    chatSessionId: run.chatSessionId,
    assistantMessageId: run.assistantMessageId,
    errorMessage: run.errorMessage,
    deliveryStatus: (run.deliveryStatus as AutomationDeliveryStatus) ?? null,
    resultPreview: run.resultPreview,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString()
})

const SILENT_REPLY_RE = /^\[?(?:silent|no[_ ]reply)\]?$/i

const isSilentReply = (text: string): boolean => SILENT_REPLY_RE.test(text)

const RESULT_PREVIEW_MAX = 200

// Markdown scaffolding (heading hashes, list bullets, emphasis) reads as noise
// at one-line length, so the first meaningful line is stripped down to prose.
export const toResultPreview = (text: string): string | null => {
    const line = text
        .split('\n')
        .map((candidate) =>
            candidate
                .replace(/^\s*(?:[#>]+|[-*+]|\d+[.)])\s*/, '')
                .replace(/[*_`]/g, '')
                .trim()
        )
        .find((candidate) => candidate.length > 0)
    if (!line) return null
    return line.length > RESULT_PREVIEW_MAX
        ? `${line.slice(0, RESULT_PREVIEW_MAX - 1).trimEnd()}…`
        : line
}

export const parseDeliveryTarget = (
    value: unknown
): AutomationDeliveryTarget | null => {
    if (!value || typeof value !== 'object') return null
    const target = value as { kind?: unknown; id?: unknown; scopeKey?: unknown }
    if (target.kind === 'scope') {
        if (typeof target.scopeKey !== 'string') return null
        const scopeKey = target.scopeKey.trim()
        if (scopeKey.length === 0 || scopeKey.length > 500) return null
        return { kind: 'scope', scopeKey }
    }
    if (target.kind !== 'chat' && target.kind !== 'user') return null
    if (typeof target.id !== 'string') return null
    const id = target.id.trim()
    if (id.length === 0 || id.length > 200) return null
    return { kind: target.kind, id }
}

const deliveryTargetsEqual = (
    a: AutomationDeliveryTarget | null,
    b: AutomationDeliveryTarget | null
): boolean => {
    if (a === null || b === null) return a === b
    if (a.kind === 'scope' || b.kind === 'scope')
        return (
            a.kind === 'scope' && b.kind === 'scope' && a.scopeKey === b.scopeKey
        )
    return a.kind === b.kind && a.id === b.id
}

const extractErrorMessage = (payload: unknown): string => {
    if (!payload || typeof payload !== 'object') return 'automation run failed'
    const error = (payload as { error?: unknown }).error
    if (!error || typeof error !== 'object') return 'automation run failed'
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' && message.trim()
        ? message.slice(0, 1000)
        : 'automation run failed'
}
