import { createHmac } from 'node:crypto'
import {
    createObjectId,
    normalizeAgentName,
    type AgentCreateStep
} from '@manyfold/shared'
import {
    agentCreateRequests,
    agents,
    type AgentCreateRequestRow,
    type Database
} from '@manyfold/db'
import {
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, lt, ne, sql } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import {
    errorEventFields,
    sanitizeMessage
} from '@/modules/agents/failure-report'
import type { AgentProgressEmitter } from '@/modules/agents/orchestration/agent-orchestrator.service'

// A running create touches its row this often...
export const CREATE_REQUEST_HEARTBEAT_MS = 15_000
// ...so one this quiet belongs to an API process that died mid-create: every
// deploy stops the old machines without waiting for creates to finish.
export const CREATE_REQUEST_STALE_MS = 120_000
const FOLLOW_POLL_MS = 1_500
// Finished rows are kept this long, then pruned by the owner's next claim;
// until then a repeat of a create that succeeded gets its agent back.
const CREATE_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000

export type CreateRequestClaim =
    | { kind: 'run'; request: AgentCreateRequestRow }
    | { kind: 'attach'; request: AgentCreateRequestRow }

interface StoredCreateError {
    code: string
    status: number
    message: string
    details?: unknown
}

// Object keys in one order at every depth, so a body hashes the same
// whichever client built it; undefined fields drop out.
const canonicalJson = (value: unknown): string =>
    JSON.stringify(value, (_key, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                  Object.keys(v)
                      .sort()
                      .map((key) => [key, (v as Record<string, unknown>)[key]])
              )
            : v
    )

const storedErrorFor = (err: unknown): StoredCreateError => {
    const { code, status, details } = errorEventFields(err)
    return {
        code: code ?? 'internal_error',
        status: status ?? 500,
        message: sanitizeMessage(err),
        ...(details === undefined ? {} : { details })
    }
}

const exceptionFor = (error: StoredCreateError): HttpException =>
    new HttpException(
        {
            message: error.message,
            code: error.code,
            ...(error.details === undefined ? {} : { details: error.details })
        },
        error.status
    )

@Injectable()
export class AgentCreateRequestsService {
    private readonly log = new Logger(AgentCreateRequestsService.name)

    // Keyed like the deletion links (API_CRYPTO_KEY): a fingerprint covers
    // inline keys, and without the key it says nothing about them.
    private readonly key: Buffer

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        config: ConfigService
    ) {
        const raw = config.get<string>('API_CRYPTO_KEY')?.trim()
        this.key = raw
            ? Buffer.from(raw, 'base64')
            : Buffer.from('manyfold-agent-create')
    }

    // What makes two requests the same create: the whole body but the name,
    // inline keys included, so a repeat with another key is another create.
    fingerprint(
        route: 'create' | 'add',
        body: object,
        extra: Record<string, unknown> = {}
    ): string {
        return createHmac('sha256', this.key)
            .update(
                canonicalJson({ ...body, ...extra, name: undefined, route })
            )
            .digest('hex')
    }

    // Reserve the name for this create, or attach to the one already running
    // it. Under the owner's lock, so two claims for one name never both run.
    // `resume` names a request this client saw accepted: it is followed to
    // whatever end it came to, and nothing new is started for it.
    async claim(input: {
        userId: string
        actorUserId: string
        name: string
        fingerprint: string
        resume?: string
    }): Promise<CreateRequestClaim> {
        const name = normalizeAgentName(input.name)
        if (input.resume)
            return this.resumeClaim(
                input.userId,
                input.resume,
                name,
                input.fingerprint
            )
        const now = Date.now()
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${'agent-create:' + input.userId}, 0))`
            )
            await tx
                .delete(agentCreateRequests)
                .where(
                    and(
                        eq(agentCreateRequests.userId, input.userId),
                        ne(agentCreateRequests.status, 'in_progress'),
                        lt(
                            agentCreateRequests.updatedAt,
                            new Date(now - CREATE_REQUEST_RETENTION_MS)
                        )
                    )
                )
            const [running] = await tx
                .select()
                .from(agentCreateRequests)
                .where(
                    and(
                        eq(agentCreateRequests.userId, input.userId),
                        eq(agentCreateRequests.name, name),
                        eq(agentCreateRequests.status, 'in_progress')
                    )
                )
                .limit(1)
            if (running) {
                const alive =
                    running.updatedAt.getTime() > now - CREATE_REQUEST_STALE_MS
                if (alive && running.fingerprint === input.fingerprint)
                    return { kind: 'attach' as const, request: running }
                if (alive)
                    throw new ConflictException({
                        message: `agent "${name}" is being created by another request right now`,
                        code: 'AGENT_CREATE_IN_PROGRESS',
                        details: {
                            name,
                            startedAt: running.createdAt.toISOString()
                        }
                    })
                await tx
                    .update(agentCreateRequests)
                    .set({
                        status: 'failed',
                        error: this.interruptedError(running),
                        updatedAt: new Date(now)
                    })
                    .where(
                        and(
                            eq(agentCreateRequests.id, running.id),
                            eq(agentCreateRequests.status, 'in_progress')
                        )
                    )
            }
            const [taken] = await tx
                .select({ id: agents.id })
                .from(agents)
                .where(
                    and(eq(agents.userId, input.userId), eq(agents.name, name))
                )
                .limit(1)
            if (taken) {
                // The agent in the way is the one this same request made: a
                // client that lost the connection near the end gets it back
                // instead of being told its own agent took the name.
                const [done] = await tx
                    .select()
                    .from(agentCreateRequests)
                    .where(
                        and(
                            eq(agentCreateRequests.userId, input.userId),
                            eq(agentCreateRequests.agentId, taken.id),
                            eq(agentCreateRequests.status, 'succeeded'),
                            eq(
                                agentCreateRequests.fingerprint,
                                input.fingerprint
                            )
                        )
                    )
                    .limit(1)
                if (done) return { kind: 'attach' as const, request: done }
                throw new ConflictException({
                    message: `agent "${name}" already exists for this user`,
                    code: 'AGENT_NAME_TAKEN',
                    details: { agentId: taken.id }
                })
            }
            const [request] = await tx
                .insert(agentCreateRequests)
                .values({
                    id: createObjectId('agentCreateRequest'),
                    userId: input.userId,
                    actorUserId: input.actorUserId,
                    name,
                    fingerprint: input.fingerprint
                })
                .returning()
            return { kind: 'run' as const, request }
        })
    }

    private async resumeClaim(
        userId: string,
        requestId: string,
        name: string,
        fingerprint: string
    ): Promise<CreateRequestClaim> {
        const [request] = await this.db
            .select()
            .from(agentCreateRequests)
            .where(
                and(
                    eq(agentCreateRequests.id, requestId),
                    eq(agentCreateRequests.userId, userId)
                )
            )
            .limit(1)
        if (
            !request ||
            request.name !== name ||
            request.fingerprint !== fingerprint
        )
            throw new NotFoundException({
                message: `agent create ${requestId} not found for this request`,
                code: 'AGENT_CREATE_NOT_FOUND'
            })
        return { kind: 'attach', request }
    }

    // Run the claimed create, or follow the running one it attached to.
    async execute<T extends { id: string }>(
        claim: CreateRequestClaim,
        emitter: AgentProgressEmitter | undefined,
        create: (emitter: AgentProgressEmitter) => Promise<T>,
        load: (agentId: string) => Promise<T>
    ): Promise<T> {
        if (claim.kind === 'run')
            return this.run(claim.request, emitter, create)
        const agentId = await this.follow(claim.request.id, (step) =>
            emitter?.step(step)
        )
        return load(agentId)
    }

    // Run a claimed create, recording its steps, where it landed and a
    // heartbeat, then its outcome. The outcome is written only while the row
    // is still this attempt's: a create marked interrupted stays that way.
    async run<T extends { id: string }>(
        request: AgentCreateRequestRow,
        emitter: AgentProgressEmitter | undefined,
        create: (emitter: AgentProgressEmitter) => Promise<T>
    ): Promise<T> {
        const touch = (patch: Partial<AgentCreateRequestRow>): void => {
            void this.update(request.id, patch).catch((err: unknown) =>
                this.log.warn(
                    `create request ${request.id}: ${(err as Error).message}`
                )
            )
        }
        const heartbeat = setInterval(
            () => touch({}),
            CREATE_REQUEST_HEARTBEAT_MS
        )
        heartbeat.unref?.()
        const tracked: AgentProgressEmitter = {
            step: (step: AgentCreateStep) => {
                touch({ step })
                emitter?.step(step)
            },
            placed: (where) => {
                touch({ hostId: where.hostId, runtimeId: where.runtimeId })
                emitter?.placed?.(where)
            }
        }
        let created: T
        try {
            created = await create(tracked)
        } catch (err) {
            await this.update(request.id, {
                status: 'failed',
                error: storedErrorFor(err)
            }).catch(() => undefined)
            throw err
        } finally {
            clearInterval(heartbeat)
        }
        // The agent exists whatever happens here; a row left in progress goes
        // stale and ends as interrupted.
        await this.update(request.id, {
            status: 'succeeded',
            agentId: created.id
        }).catch((err: unknown) =>
            this.log.warn(
                `create request ${request.id}: ${(err as Error).message}`
            )
        )
        return created
    }

    // Follow a create another request is running until it ends, passing its
    // steps on. Returns the created agent's id. A create whose heartbeat
    // stopped is ended here as interrupted, so a follower never waits on a
    // process that is gone — whichever API instance it runs on.
    async follow(
        requestId: string,
        onStep: (step: AgentCreateStep) => void
    ): Promise<string> {
        let lastStep: string | null = null
        for (;;) {
            const [row] = await this.db
                .select()
                .from(agentCreateRequests)
                .where(eq(agentCreateRequests.id, requestId))
                .limit(1)
            if (!row)
                throw new ConflictException({
                    message: `agent create ${requestId} no longer exists`,
                    code: 'AGENT_CREATE_INTERRUPTED'
                })
            if (row.status === 'succeeded' && row.agentId) return row.agentId
            if (row.status === 'failed')
                throw exceptionFor(row.error as StoredCreateError)
            if (row.step && row.step !== lastStep) {
                lastStep = row.step
                onStep(row.step as AgentCreateStep)
            }
            if (
                row.updatedAt.getTime() <
                Date.now() - CREATE_REQUEST_STALE_MS
            ) {
                const error = this.interruptedError(row)
                const [ended] = await this.db
                    .update(agentCreateRequests)
                    .set({ status: 'failed', error, updatedAt: new Date() })
                    .where(
                        and(
                            eq(agentCreateRequests.id, row.id),
                            eq(agentCreateRequests.status, 'in_progress')
                        )
                    )
                    .returning({ id: agentCreateRequests.id })
                if (ended) throw exceptionFor(error)
                continue
            }
            await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS))
        }
    }

    private async update(
        id: string,
        patch: Partial<AgentCreateRequestRow>
    ): Promise<void> {
        await this.db
            .update(agentCreateRequests)
            .set({ ...patch, updatedAt: new Date() })
            .where(
                and(
                    eq(agentCreateRequests.id, id),
                    eq(agentCreateRequests.status, 'in_progress')
                )
            )
    }

    private interruptedError(row: AgentCreateRequestRow): StoredCreateError {
        const left = row.hostId
            ? `; it may have left sandbox ${row.hostId} behind`
            : ''
        return {
            code: 'AGENT_CREATE_INTERRUPTED',
            status: 503,
            message: `the create of "${row.name}" stopped when its API process did${left}`,
            details: {
                name: row.name,
                ...(row.hostId ? { hostId: row.hostId } : {}),
                ...(row.runtimeId ? { runtimeId: row.runtimeId } : {})
            }
        }
    }
}
