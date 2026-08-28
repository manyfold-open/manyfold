import {
    A2aExposure,
    A2aTaskTraceItem,
    A2aTaskTracePage,
    ChatUsage,
    DEFAULT_A2A_TURN_TIMEOUTS,
    auditAction,
    createObjectId
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    type OnModuleDestroy,
    type OnModuleInit,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { trace } from '@opentelemetry/api'
import { and, eq, inArray } from 'drizzle-orm'
import {
    A2aError,
    A2aErrorCode,
    type AgentCard,
    type Artifact,
    type A2aStreamEvent,
    type Message,
    type MessageSendParams,
    type Part,
    type Task,
    type TaskState,
    type TextPart
} from '@manyfold/a2a'
import { agents, auditLogs, type A2aTask, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import {
    ChatService,
    InflightTurnConflictError
} from '@/modules/chat/chat.service'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import {
    A2aTaskRepository,
    type A2aTaskScope,
    type A2aTaskState
} from '@/modules/a2a/a2a-task.repository'

const PROTOCOL_VERSION = '0.3.0'
const DEFAULT_SKILL_ID = 'general-chat'
// Hard ceilings on a single delegated A2A turn, split by send mode: blocking
// sends hold the caller's request (and its in-turn `mf a2a call`) open, so
// they stay short; async (blocking:false) tasks are polled via tasks/get and
// get a much longer cap for real agent work. On expiry we cancel the target
// turn and fail the task with 'turn_timeout'. Resolution precedence lives in
// resolveTurnTimeouts(). Defaults come from DEFAULT_A2A_TURN_TIMEOUTS.
type A2aTurnMode = 'blocking' | 'detached'
// Cap on a single user's concurrently in-flight A2A turns. message/send is
// blocking, so every level of a delegation chain (and any A↔B cycle) holds
// one 'working' task for the user at the same time — a per-user concurrency
// cap therefore bounds recursion depth directly, without threading a depth
// counter through ChatService. Normal parallel fan-out stays well under it;
// a runaway chain climbs until it trips and then unwinds. Override with
// A2A_MAX_INFLIGHT_PER_USER.
const DEFAULT_MAX_INFLIGHT_PER_USER = 8
// Stale-task sweep: async (blocking:false) turns run detached in-process, so an
// API restart can leave a task stuck non-terminal with no runTurn to finish it.
// Every interval we force-fail non-terminal tasks untouched for longer than the
// turn timeout plus a grace window — past that, a live turn's own timeoutGuard
// would already have written a terminal, so anything still 'working' is orphaned.
// The window uses the LARGEST cap (async) because task rows record neither their
// send mode nor a deadline, and updatedAt is not refreshed mid-turn; a crashed
// blocking task therefore lingers up to the async window — acceptable for a
// correctness backstop.
const STALE_SWEEP_INTERVAL_MS = 60_000
const STALE_SWEEP_GRACE_MS = 60_000
const STALE_SWEEP_BATCH = 50

export interface A2aAuthContext {
    userId: string
    targetAgentId: string
    callerAgentId: string | null
    externalSubject: string | null
    tokenId?: string | null
}

export type A2aStreamEmit = (event: A2aStreamEvent) => void

const messageText = (message: Message): string =>
    message.parts
        .filter((part): part is TextPart => part.kind === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()

const textArtifact = (text: string): Artifact => ({
    artifactId: 'artifact-1',
    parts: [{ kind: 'text', text } as Part]
})

@Injectable()
export class A2aService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(A2aService.name)
    private sweepTimer?: ReturnType<typeof setInterval>

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly chat: ChatService,
        private readonly tasks: A2aTaskRepository,
        @Optional() private readonly config?: ConfigService,
        @Optional() private readonly adminSettings?: AdminSettingsService,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    onModuleInit(): void {
        this.sweepTimer = setInterval(() => {
            void this.sweepStaleTasks()
        }, STALE_SWEEP_INTERVAL_MS)
        this.sweepTimer.unref?.()
    }

    onModuleDestroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
    }

    // Force-fail orphaned non-terminal tasks (see STALE_SWEEP_* above). Best
    // effort: log and move on per-row so one bad update can't wedge the sweep.
    private async sweepStaleTasks(): Promise<void> {
        const { blockingMs, asyncMs } = await this.resolveTurnTimeouts()
        const olderThan = new Date(
            Date.now() - Math.max(blockingMs, asyncMs) - STALE_SWEEP_GRACE_MS
        )
        let rows: A2aTask[]
        try {
            rows = await this.tasks.listStaleInflight(olderThan, STALE_SWEEP_BATCH)
        } catch (err) {
            this.log.warn(
                `a2a stale sweep query failed: ${(err as Error).message}`
            )
            return
        }
        for (const row of rows) {
            try {
                // Conditional: skip if the turn terminalized between the select
                // and now (don't overwrite a real result with 'orphaned').
                const swept = await this.tasks.updateIfActive(row.id, {
                    state: 'failed',
                    errorJson: {
                        message:
                            'task orphaned: no terminal update before timeout',
                        code: 'orphaned'
                    },
                    completedAt: new Date()
                })
                if (swept)
                    this.log.warn(
                        `a2a task ${row.id} swept as orphaned (was '${row.state}')`
                    )
            } catch (err) {
                this.log.warn(
                    `a2a stale sweep update ${row.id} failed: ${
                        (err as Error).message
                    }`
                )
            }
        }
    }

    // Precedence: admin setting 'a2a_turn_timeouts' (row saved) > shared
    // defaults. A settings/DB hiccup falls through to defaults so turns and
    // the sweep never fail on a settings read. (The legacy single-cap
    // A2A_TURN_TIMEOUT_MS env var is migrated into the setting at startup by
    // A2aTimeoutEnvMigrationService and no longer read here.)
    private async resolveTurnTimeouts(): Promise<{
        blockingMs: number
        asyncMs: number
    }> {
        const override = this.adminSettings
            ? await this.adminSettings
                  .getCachedA2aTurnTimeoutsOverride()
                  .catch(() => null)
            : null
        if (override)
            return {
                blockingMs: override.blockingTimeoutSeconds * 1000,
                asyncMs: override.asyncTimeoutSeconds * 1000
            }
        return {
            blockingMs:
                DEFAULT_A2A_TURN_TIMEOUTS.blockingTimeoutSeconds * 1000,
            asyncMs: DEFAULT_A2A_TURN_TIMEOUTS.asyncTimeoutSeconds * 1000
        }
    }

    private maxInflightPerUser(): number {
        const raw = this.config
            ?.get<string>('A2A_MAX_INFLIGHT_PER_USER')
            ?.trim()
        const parsed = raw ? Number(raw) : NaN
        return Number.isFinite(parsed) && parsed > 0
            ? parsed
            : DEFAULT_MAX_INFLIGHT_PER_USER
    }

    // ---- exposure (agents.extras.a2aExposure) ----

    async assertOwner(agentId: string, userId: string): Promise<void> {
        const [agent] = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        if (!agent) throw new NotFoundException('agent not found')
    }

    async getExposure(agentId: string): Promise<A2aExposure | null> {
        const [agent] = await this.db
            .select({ extras: agents.extras })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return null
        const extras = agent.extras as { a2aExposure?: A2aExposure }
        return extras?.a2aExposure ?? null
    }

    async setExposure(
        agentId: string,
        patch: Partial<A2aExposure> & { enabled: boolean },
        db: Pick<Database, 'select' | 'update'> = this.db
    ): Promise<A2aExposure> {
        const [agent] = await db
            .select({ extras: agents.extras })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent)
            throw new A2aError(A2aErrorCode.taskNotFound, 'agent not found')
        const extras =
            (agent.extras as Record<string, unknown> | null) ?? {}
        const existing = (extras.a2aExposure as A2aExposure | undefined) ?? {
            enabled: false
        }
        const now = new Date().toISOString()
        const next: A2aExposure = {
            ...existing,
            ...patch,
            enabledAt:
                patch.enabled && !existing.enabled
                    ? now
                    : existing.enabledAt,
            updatedAt: now
        }
        await db
            .update(agents)
            .set({ extras: { ...extras, a2aExposure: next }, updatedAt: new Date() })
            .where(eq(agents.id, agentId))
        return next
    }

    // ---- agent card ----

    async buildAgentCard(
        agentId: string,
        apiOrigin: string
    ): Promise<AgentCard | null> {
        const [agent] = await this.db
            .select({
                id: agents.id,
                name: agents.name,
                extras: agents.extras
            })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return null
        const exposure = (agent.extras as { a2aExposure?: A2aExposure })
            ?.a2aExposure
        if (!exposure?.enabled) return null

        const rpcUrl = `${apiOrigin}/a2a/agents/${agentId}/rpc`
        // `description` here and `description`/`tags` on every skill are
        // REQUIRED by the A2A 0.3.0 AgentCard schema. Omitting them still
        // type-checks (our types mark them optional) and TS clients tolerate
        // it, but the official Python SDK validates the card with pydantic and
        // rejects it before ever calling — so a third-party client could not
        // discover this agent at all. Derived, not stored: agents have no
        // description column and the owner has nothing to fill in yet.
        return {
            protocolVersion: PROTOCOL_VERSION,
            name: agent.name,
            description: `${agent.name} — a Manyfold-hosted agent callable over A2A.`,
            url: rpcUrl,
            preferredTransport: 'JSONRPC',
            additionalInterfaces: [{ url: rpcUrl, transport: 'JSONRPC' }],
            version: '1.0.0',
            capabilities: { streaming: true },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: exposure.acceptedOutputModes ?? ['text/plain'],
            skills: [
                {
                    id: exposure.skillId ?? DEFAULT_SKILL_ID,
                    name: 'General Chat',
                    description:
                        'Send a text prompt and receive this agent’s reply.',
                    tags: ['chat', 'text']
                }
            ],
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
            security: [{ bearer: [] }],
            supportsAuthenticatedExtendedCard: false
        }
    }

    // ---- task wire shape ----

    private toWireTask(row: A2aTask): Task {
        const artifacts: Artifact[] = row.artifactJson
            ? [row.artifactJson as unknown as Artifact]
            : []
        const status: Task['status'] = {
            state: row.state as TaskState,
            timestamp: row.updatedAt.toISOString()
        }
        if (row.errorJson) {
            const detail = row.errorJson as { message?: string }
            if (detail.message)
                status.message = {
                    kind: 'message',
                    role: 'agent',
                    parts: [{ kind: 'text', text: detail.message }],
                    messageId: randomUUID()
                }
        }
        return {
            kind: 'task',
            id: row.id,
            contextId: row.contextId,
            status,
            artifacts,
            metadata: {}
        }
    }

    // ---- message/send (blocking; emits A2A events when onEvent is given) ----

    async sendMessage(
        ctx: A2aAuthContext,
        params: MessageSendParams,
        onEvent?: A2aStreamEmit
    ): Promise<Task> {
        const scope: A2aTaskScope = {
            targetAgentId: ctx.targetAgentId,
            callerAgentId: ctx.callerAgentId,
            externalSubject: ctx.externalSubject
        }
        const incoming = params.message
        if (!incoming || incoming.kind !== 'message')
            throw new A2aError(A2aErrorCode.invalidParams, 'message required')
        const clientMessageId = incoming.messageId
        if (!clientMessageId)
            throw new A2aError(
                A2aErrorCode.invalidParams,
                'message.messageId required'
            )

        // resolve session + context (never expose raw chat_sessions.id)
        let chatSessionId: string
        let contextId: string
        if (incoming.taskId) {
            const prior = await this.tasks.findById(incoming.taskId, scope)
            if (!prior)
                throw new A2aError(A2aErrorCode.taskNotFound, 'task not found')
            if (incoming.contextId && incoming.contextId !== prior.contextId)
                throw new A2aError(
                    A2aErrorCode.invalidParams,
                    'contextId does not match taskId'
                )
            chatSessionId = prior.chatSessionId
            contextId = prior.contextId
        } else if (incoming.contextId) {
            const prior = await this.tasks.findByContext(
                incoming.contextId,
                scope
            )
            if (!prior)
                throw new A2aError(A2aErrorCode.taskNotFound, 'context not found')
            chatSessionId = prior.chatSessionId
            contextId = prior.contextId
        } else {
            const session = await this.chat.createSession(
                ctx.userId,
                ctx.targetAgentId
            )
            chatSessionId = session.id
            contextId = createObjectId('a2aContext')
        }

        // idempotency: a replayed messageId returns the existing task
        const dupe = await this.tasks.findByClientMessage(
            chatSessionId,
            clientMessageId
        )
        if (dupe) return this.toWireTask(dupe)

        const prompt = messageText(incoming)
        if (!prompt)
            throw new A2aError(
                A2aErrorCode.contentTypeNotSupported,
                'only non-empty text/plain input is supported'
            )

        const inflight = await this.tasks.countInflightForUser(ctx.userId)
        const maxInflight = this.maxInflightPerUser()
        if (inflight >= maxInflight)
            throw new A2aError(
                A2aErrorCode.internalError,
                `too many concurrent A2A delegations (${inflight}/${maxInflight}); retry when one finishes`,
                { code: 'delegation_limit', inflight, limit: maxInflight }
            )

        const task = await this.tasks.create({
            id: createObjectId('a2aTask'),
            userId: ctx.userId,
            targetAgentId: ctx.targetAgentId,
            callerAgentId: ctx.callerAgentId,
            externalSubject: ctx.externalSubject,
            contextId,
            chatSessionId,
            clientMessageId
        })

        await this.writeAudit(
            auditAction.A2A_TASK_STARTED,
            task.id,
            ctx.userId,
            {
                taskId: task.id,
                targetAgentId: ctx.targetAgentId,
                callerAgentId: ctx.callerAgentId,
                externalSubject: ctx.externalSubject,
                tokenId: ctx.tokenId ?? null,
                contextId: task.contextId
            }
        )

        // Non-blocking (A2A blocking:false): return the working task at once and
        // drive the turn detached, so a caller doesn't hold a long request (and
        // its sprite doesn't hibernate) waiting on the peer. The result stays
        // durable in a2a_tasks for later tasks/get polling. SSE (onEvent) always
        // runs inline — the live turn IS the stream.
        if (params.configuration?.blocking === false && !onEvent) {
            void this.runTurnDetached(task, prompt)
            return this.toWireTask({ ...task, state: 'working' })
        }

        return this.runTurn(task, prompt, 'blocking', onEvent)
    }

    // Detached variant for non-blocking sends: runTurn writes its own terminal
    // on normal completion and on observed errors, but if it throws before that
    // (e.g. ChatService.sendMessage rejects) nothing else will finish the task —
    // so force a terminal failure here, unless the turn already settled.
    private async runTurnDetached(task: A2aTask, prompt: string): Promise<void> {
        try {
            await this.runTurn(task, prompt, 'detached')
        } catch (err) {
            this.log.error(
                `detached a2a task ${task.id} threw: ${(err as Error).message}`
            )
            // Conditional: only fail it if it's still active (don't clobber a
            // terminal state the turn or a cancel already wrote).
            await this.tasks
                .updateIfActive(task.id, {
                    state: 'failed',
                    errorJson: {
                        message: (err as Error).message,
                        code: 'detached_error'
                    },
                    completedAt: new Date()
                })
                .catch((e) =>
                    this.log.warn(
                        `failed to fail detached task ${task.id}: ${
                            (e as Error).message
                        }`
                    )
                )
        }
    }

    private async runTurn(
        task: A2aTask,
        prompt: string,
        mode: A2aTurnMode,
        onEvent?: A2aStreamEmit
    ): Promise<Task> {
        const startedAt = Date.now()
        const span = trace.getActiveSpan()
        span?.setAttribute('nca.a2a_task_id', task.id)
        if (task.callerAgentId)
            span?.setAttribute('nca.a2a_peer_agent_id', task.callerAgentId)
        const emit = (event: A2aStreamEvent): void => {
            if (onEvent) onEvent(event)
        }

        let text = ''
        let usage: Record<string, unknown> | null = null
        let settle!: (value: { error: { message: string; code: string } | null }) => void
        let settled = false
        const done = new Promise<{
            error: { message: string; code: string } | null
        }>((resolve) => {
            settle = resolve
        })
        const finish = (value: {
            error: { message: string; code: string } | null
        }): void => {
            if (settled) return
            settled = true
            settle(value)
        }

        const observer = (event: EmittedChatEvent): void => {
            if (event.type === 'token') {
                text += event.text
                emit({
                    kind: 'artifact-update',
                    taskId: task.id,
                    contextId: task.contextId,
                    artifact: textArtifact(event.text),
                    append: true,
                    lastChunk: false
                })
                return
            }
            // append:false makes this a true overwrite of the artifact, which
            // is the one surface that can actually retract a superseded answer.
            if (event.type === 'replace') {
                text = event.text
                emit({
                    kind: 'artifact-update',
                    taskId: task.id,
                    contextId: task.contextId,
                    artifact: textArtifact(event.text),
                    append: false,
                    lastChunk: false
                })
                return
            }
            if (event.type === 'usage') {
                usage = event.usage as unknown as Record<string, unknown>
                return
            }
            if (event.type === 'error') {
                finish({
                    error: {
                        message: event.error.message,
                        code: event.error.code
                    }
                })
                return
            }
            if (event.type === 'done') finish({ error: null })
        }

        // Conditional so a cancel that landed between create and here wins: if
        // the task is already terminal we never start (nor resurrect) the turn.
        const started = await this.tasks.updateIfActive(task.id, {
            state: 'working'
        })
        if (!started) {
            const current =
                (await this.tasks.findById(task.id, this.scopeOfTask(task))) ??
                task
            return this.toWireTask(current)
        }
        emit({
            kind: 'status-update',
            taskId: task.id,
            contextId: task.contextId,
            status: { state: 'working' },
            final: false
        })

        let sent: Awaited<ReturnType<ChatService['sendMessage']>>
        try {
            sent = await this.chat.sendMessage(
                task.userId,
                task.targetAgentId,
                task.chatSessionId,
                prompt,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                observer
            )
        } catch (err) {
            // sendMessage rejected before any observer event (e.g. a concurrent
            // turn already holds this context's turn lock -> InflightTurnConflictError).
            // Terminalize the task now instead of leaving it 'working' until the
            // stale-task sweep, then rethrow so the caller/detached wrapper sees it.
            await this.tasks
                .updateIfActive(task.id, {
                    state: 'failed',
                    errorJson: {
                        message: (err as Error).message,
                        code:
                            err instanceof InflightTurnConflictError
                                ? 'inflight_turn'
                                : 'turn_start_failed'
                    },
                    completedAt: new Date()
                })
                .catch(() => {})
            emit({
                kind: 'status-update',
                taskId: task.id,
                contextId: task.contextId,
                status: { state: 'failed' },
                final: true
            })
            throw err
        }
        await this.tasks.update(task.id, {
            userMessageId: sent.userMessage.id,
            assistantMessageId: sent.assistantMessageId
        })

        const { blockingMs, asyncMs } = await this.resolveTurnTimeouts()
        const timeoutMs = mode === 'detached' ? asyncMs : blockingMs
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutGuard = new Promise<{
            error: { message: string; code: string } | null
        }>((resolve) => {
            timer = setTimeout(() => {
                timedOut = true
                resolve({
                    error: {
                        message: `delegated turn exceeded ${Math.round(
                            timeoutMs / 1000
                        )}s (${mode} cap)`,
                        code: 'turn_timeout'
                    }
                })
            }, timeoutMs)
        })

        const outcome = await Promise.race([done, timeoutGuard])
        if (timer) clearTimeout(timer)
        if (timedOut) {
            this.log.warn(
                `a2a task ${task.id} timed out after ${timeoutMs}ms (${mode} cap); canceling target turn`
            )
            this.telemetry?.event('a2a.turn.timeout', {
                taskId: task.id,
                userId: task.userId,
                targetAgentId: task.targetAgentId,
                callerAgentId: task.callerAgentId,
                mode,
                timeoutMs,
                durationMs: Date.now() - startedAt
            })
            await this.chat
                .cancelMessage(
                    task.userId,
                    task.targetAgentId,
                    sent.assistantMessageId
                )
                .catch((err) =>
                    this.log.warn(
                        `cancel after a2a timeout failed for ${task.id}: ${
                            (err as Error).message
                        }`
                    )
                )
        }
        const completedAt = new Date()
        const finalState: TaskState = outcome.error ? 'failed' : 'completed'
        const artifactJson = outcome.error ? null : textArtifact(text)
        const errorJson = outcome.error
            ? { message: outcome.error.message, code: outcome.error.code }
            : null

        // Conditional: if a cancel/sweep already terminalized this task while the
        // turn was finishing, don't overwrite that terminal state (or its result).
        await this.tasks.updateIfActive(task.id, {
            state: finalState,
            artifactJson: artifactJson as unknown as Record<string, unknown>,
            errorJson,
            usageJson: usage,
            completedAt
        })

        await this.writeAudit(
            outcome.error
                ? auditAction.A2A_TASK_FAILED
                : auditAction.A2A_TASK_COMPLETED,
            task.id,
            task.userId,
            {
                taskId: task.id,
                targetAgentId: task.targetAgentId,
                callerAgentId: task.callerAgentId,
                externalSubject: task.externalSubject,
                state: finalState,
                errorCode: outcome.error?.code ?? null
            }
        )

        if (!outcome.error)
            this.telemetry?.event('a2a.turn.complete', {
                taskId: task.id,
                userId: task.userId,
                targetAgentId: task.targetAgentId,
                callerAgentId: task.callerAgentId,
                mode,
                state: finalState,
                durationMs: Date.now() - startedAt
            })
        else if (!timedOut)
            this.telemetry?.error(
                'a2a.turn.error',
                new Error(outcome.error.message),
                {
                    taskId: task.id,
                    userId: task.userId,
                    targetAgentId: task.targetAgentId,
                    callerAgentId: task.callerAgentId,
                    mode,
                    errorCode: outcome.error.code,
                    durationMs: Date.now() - startedAt
                }
            )

        if (!outcome.error)
            emit({
                kind: 'artifact-update',
                taskId: task.id,
                contextId: task.contextId,
                artifact: textArtifact(text),
                append: false,
                lastChunk: true
            })
        emit({
            kind: 'status-update',
            taskId: task.id,
            contextId: task.contextId,
            status: {
                state: finalState,
                ...(errorJson
                    ? {
                          message: {
                              kind: 'message',
                              role: 'agent',
                              parts: [
                                  { kind: 'text', text: errorJson.message }
                              ],
                              messageId: randomUUID()
                          }
                      }
                    : {})
            },
            final: true
        })

        return this.toWireTask({
            ...task,
            state: finalState,
            artifactJson: artifactJson as unknown as Record<string, unknown>,
            errorJson,
            usageJson: usage,
            completedAt,
            updatedAt: completedAt
        })
    }

    // ---- tasks/get ----

    async getTask(ctx: A2aAuthContext, taskId: string): Promise<Task> {
        const row = await this.tasks.findById(taskId, this.scopeOf(ctx))
        if (!row)
            throw new A2aError(A2aErrorCode.taskNotFound, 'task not found')
        return this.toWireTask(row)
    }

    // ---- tasks/cancel ----

    async cancelTask(ctx: A2aAuthContext, taskId: string): Promise<Task> {
        const row = await this.tasks.findById(taskId, this.scopeOf(ctx))
        if (!row)
            throw new A2aError(A2aErrorCode.taskNotFound, 'task not found')
        const terminal: TaskState[] = ['completed', 'failed', 'canceled', 'rejected']
        if (terminal.includes(row.state as TaskState))
            throw new A2aError(
                A2aErrorCode.taskNotCancelable,
                'task is already terminal'
            )
        // Mark canceled FIRST so the running turn's final write (conditional)
        // no-ops and 'canceled' wins; then abort the turn. For an async task this
        // makes the durable state actually reflect the cancel.
        const completedAt = new Date()
        const canceled = await this.tasks.updateIfActive(row.id, {
            state: 'canceled',
            completedAt
        })
        if (row.assistantMessageId)
            await this.chat.cancelMessage(
                ctx.userId,
                ctx.targetAgentId,
                row.assistantMessageId
            )
        await this.writeAudit(
            auditAction.A2A_TASK_CANCELED,
            row.id,
            ctx.userId,
            {
                taskId: row.id,
                targetAgentId: ctx.targetAgentId,
                callerAgentId: ctx.callerAgentId
            }
        )
        this.telemetry?.event('a2a.task.canceled', {
            taskId: row.id,
            userId: ctx.userId,
            targetAgentId: ctx.targetAgentId,
            callerAgentId: ctx.callerAgentId,
            durationMs: Date.now() - row.createdAt.getTime()
        })
        if (canceled)
            return this.toWireTask({
                ...row,
                state: 'canceled',
                completedAt,
                updatedAt: completedAt
            })
        // Raced to terminal between read and cancel — return the real state.
        const fresh =
            (await this.tasks.findById(taskId, this.scopeOf(ctx))) ?? row
        return this.toWireTask(fresh)
    }

    // ---- tasks/resubscribe ----
    // MVP: sweep a restart-orphaned turn, then replay the current snapshot and
    // close. Gap-free live replay of in-flight chunks during a concurrent
    // blocking send is a follow-up (would subscribe via ChatSseBroadcaster).
    async resubscribe(
        ctx: A2aAuthContext,
        taskId: string,
        emit: A2aStreamEmit
    ): Promise<void> {
        const row = await this.tasks.findById(taskId, this.scopeOf(ctx))
        if (!row)
            throw new A2aError(A2aErrorCode.taskNotFound, 'task not found')
        if (row.assistantMessageId)
            await this.chat.terminalizeDeadInflightMessage(
                row.assistantMessageId
            )
        const current =
            (await this.tasks.findById(taskId, this.scopeOf(ctx))) ?? row
        if (current.artifactJson)
            emit({
                kind: 'artifact-update',
                taskId: current.id,
                contextId: current.contextId,
                artifact: current.artifactJson as unknown as Artifact,
                append: false,
                lastChunk: true
            })
        emit({
            kind: 'status-update',
            taskId: current.id,
            contextId: current.contextId,
            status: { state: current.state as TaskState },
            final: true
        })
    }

    // ---- tasks/list ----

    async listTasks(
        ctx: A2aAuthContext,
        opts: { limit?: number; cursor?: string; state?: TaskState; contextId?: string }
    ): Promise<{ tasks: Task[]; nextCursor: string | null }> {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
        const cursor = opts.cursor ? this.decodeCursor(opts.cursor) : undefined
        const rows = await this.tasks.list(this.scopeOf(ctx), {
            limit: limit + 1,
            beforeCreatedAt: cursor?.createdAt,
            beforeId: cursor?.id,
            state: opts.state,
            contextId: opts.contextId
        })
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        const nextCursor =
            rows.length > limit && last
                ? this.encodeCursor(last.createdAt, last.id)
                : null
        return { tasks: page.map((row) => this.toWireTask(row)), nextCursor }
    }

    // ---- owner-facing task trace (user session, not an A2A token) ----

    async listAgentTasks(
        userId: string,
        agentId: string,
        opts: {
            limit?: number
            cursor?: string
            state?: string
            direction?: 'inbound' | 'outbound' | 'all'
            peer?: string
        }
    ): Promise<A2aTaskTracePage> {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
        const cursor = opts.cursor ? this.decodeCursor(opts.cursor) : undefined
        const rows = await this.tasks.listForOwner(userId, agentId, {
            limit: limit + 1,
            beforeCreatedAt: cursor?.createdAt,
            beforeId: cursor?.id,
            state: opts.state as A2aTaskState | undefined,
            direction: opts.direction,
            targetAgentId: opts.peer
        })
        const page = rows.slice(0, limit)

        const ids = new Set<string>()
        for (const row of page) {
            ids.add(row.targetAgentId)
            if (row.callerAgentId) ids.add(row.callerAgentId)
        }
        const names = await this.agentNames([...ids])

        const tasks: A2aTaskTraceItem[] = page.map((row) => ({
            id: row.id,
            direction: row.targetAgentId === agentId ? 'inbound' : 'outbound',
            state: row.state,
            targetAgentId: row.targetAgentId,
            targetAgentName: names.get(row.targetAgentId) ?? null,
            callerAgentId: row.callerAgentId,
            callerAgentName: row.callerAgentId
                ? (names.get(row.callerAgentId) ?? null)
                : null,
            externalSubject: row.externalSubject,
            contextId: row.contextId,
            chatSessionId: row.chatSessionId,
            userMessageId: row.userMessageId,
            assistantMessageId: row.assistantMessageId,
            usage: (row.usageJson as ChatUsage | null) ?? null,
            errorMessage:
                (row.errorJson as { message?: string } | null)?.message ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null
        }))
        const last = page[page.length - 1]
        const nextCursor =
            rows.length > limit && last
                ? this.encodeCursor(last.createdAt, last.id)
                : null
        return { tasks, nextCursor }
    }

    private async agentNames(ids: string[]): Promise<Map<string, string>> {
        if (ids.length === 0) return new Map()
        const rows = await this.db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, ids))
        return new Map(rows.map((row) => [row.id, row.name]))
    }

    // Cross-agent invocation audit. Never break the A2A turn over an audit
    // failure — log and swallow, mirroring ApiTokenService.writeAuditInTx.
    private async writeAudit(
        action: string,
        subject: string,
        actorId: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db
                .insert(auditLogs)
                .values({ id: randomUUID(), actorId, action, subject, meta })
        } catch (err) {
            this.log.warn(
                `failed to write a2a audit ${action}/${subject}: ${(err as Error).message}`
            )
        }
    }

    private scopeOf(ctx: A2aAuthContext): A2aTaskScope {
        return {
            targetAgentId: ctx.targetAgentId,
            callerAgentId: ctx.callerAgentId,
            externalSubject: ctx.externalSubject
        }
    }

    private scopeOfTask(task: A2aTask): A2aTaskScope {
        return {
            targetAgentId: task.targetAgentId,
            callerAgentId: task.callerAgentId,
            externalSubject: task.externalSubject
        }
    }

    private encodeCursor(createdAt: Date, id: string): string {
        return Buffer.from(`${createdAt.toISOString()}|${id}`).toString(
            'base64url'
        )
    }

    private decodeCursor(
        cursor: string
    ): { createdAt: Date; id: string } | undefined {
        try {
            const [iso, id] = Buffer.from(cursor, 'base64url')
                .toString('utf8')
                .split('|')
            if (!iso || !id) return undefined
            return { createdAt: new Date(iso), id }
        } catch {
            return undefined
        }
    }
}
