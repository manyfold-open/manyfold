import { ConflictException } from '@nestjs/common'
import { Observable, type ConfigurationOptions } from '@kubernetes/client-node'
import { and, eq, sql } from 'drizzle-orm'
import { agentRuntimes, serviceLeases, type Database } from '@manyfold/db'

export const K8S_CREATE_CLEANUP_PENDING = 'create_cleanup_pending'
export const K8S_CREATE_INITIAL_AGENT = 'creating_initial_agent'
export const k8sCreateLeaseName = (runtimeId: string): string =>
    `k8s-create:${runtimeId}`
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const k8sCreateInProgress = (): ConflictException =>
    new ConflictException({
        code: 'CONTAINER_CREATE_IN_PROGRESS',
        message:
            'container creation or an unconfirmed Kubernetes request is still in progress; retry Delete after it finishes'
    })

// Every owner check and recovery takes runtime -> lease locks. A failed process
// stops renewing; an explicit DELETE can then recover without guessing row age.
export const lockK8sCreateLease = async (
    tx: Transaction,
    runtimeId: string
) => {
    const [lease] = await tx
        .select({
            holderId: serviceLeases.holderId,
            active: sql<boolean>`${serviceLeases.expiresAt} > clock_timestamp()`
        })
        .from(serviceLeases)
        .where(eq(serviceLeases.name, k8sCreateLeaseName(runtimeId)))
        .for('update')
    return lease
}

export const insertK8sCreateLease = async (
    tx: Transaction,
    runtimeId: string,
    ownerId: string
): Promise<void> => {
    await tx.insert(serviceLeases).values({
        name: k8sCreateLeaseName(runtimeId),
        holderId: ownerId,
        acquiredAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        expiresAt: sql`clock_timestamp() + interval '90 seconds'`
    })
}

export class K8sCreateOwnership {
    private readonly abort = new AbortController()
    readonly signal = this.abort.signal
    private heartbeat: ReturnType<typeof setInterval> | undefined
    private deadline: ReturnType<typeof setTimeout> | undefined
    private renewing: Promise<void> | undefined
    private uncertainRequest = false
    private stopped = false

    constructor(
        private readonly db: Database,
        private readonly runtimeId: string,
        private readonly ownerId: string
    ) {}

    async start(): Promise<void> {
        const remaining = await this.db.transaction((tx) => this.assertInTx(tx))
        this.deadline = setTimeout(() => {
            clearInterval(this.heartbeat)
            this.abort.abort(
                new Error(
                    'fresh container creation exceeded its 10 minute budget'
                )
            )
        }, remaining)
        this.deadline.unref()
        this.heartbeat = setInterval(() => {
            if (this.renewing) return
            this.renewing = this.assertActive()
                .catch((error: unknown) => {
                    clearInterval(this.heartbeat)
                    this.abort.abort(error)
                })
                .finally(() => {
                    this.renewing = undefined
                })
        }, 20_000)
        this.heartbeat.unref()
    }

    async assertInTx(tx: Transaction): Promise<number> {
        this.signal.throwIfAborted()
        if (this.stopped)
            throw new Error('fresh container owner is no longer active')
        await tx.execute(
            sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
        )
        const [runtime] = await tx
            .select({ phase: agentRuntimes.currentPhase })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, this.runtimeId))
            .for('update')
        const lease = await lockK8sCreateLease(tx, this.runtimeId)
        if (
            runtime?.phase !== K8S_CREATE_INITIAL_AGENT ||
            lease?.holderId !== this.ownerId ||
            !lease.active
        )
            throw new Error('fresh container creation ownership lost')
        const [renewed] = await tx
            .update(serviceLeases)
            .set({
                updatedAt: sql`clock_timestamp()`,
                expiresAt: sql`clock_timestamp() + interval '90 seconds'`
            })
            .where(
                and(
                    eq(serviceLeases.name, k8sCreateLeaseName(this.runtimeId)),
                    sql`${serviceLeases.acquiredAt} + interval '10 minutes' > clock_timestamp()`
                )
            )
            .returning({
                remaining: sql<number>`extract(epoch from (${serviceLeases.acquiredAt} + interval '10 minutes' - clock_timestamp())) * 1000`
            })
        if (!renewed)
            throw new Error(
                'fresh container creation exceeded its 10 minute budget'
            )
        return Math.max(1, Number(renewed.remaining))
    }

    async assertActive(): Promise<void> {
        try {
            await this.db.transaction((tx) => this.assertInTx(tx))
        } catch (error) {
            this.abort.abort(error)
            throw error
        }
    }

    async mutate<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
        return this.db.transaction(async (tx) => {
            await this.assertInTx(tx)
            return work(tx)
        })
    }

    async run<T>(work: () => Promise<T>): Promise<T> {
        await this.assertActive()
        let onAbort!: () => void
        const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(this.signal.reason)
            this.signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
            this.signal.throwIfAborted()
            return await Promise.race([work(), aborted])
        } finally {
            this.signal.removeEventListener('abort', onAbort)
        }
    }

    readonly requestOptions: ConfigurationOptions = {
        middlewareMergeStrategy: 'append',
        middleware: [
            {
                pre: (request) =>
                    new Observable(
                        (async () => {
                            await this.assertActive()
                            this.signal.throwIfAborted()
                            this.uncertainRequest = true
                            // Kubernetes apiserver's WithRequestDeadline honors timeout for
                            // these non-watch requests. Keep 60s lease margin after its 30s.
                            request.setQueryParam('timeout', '30s')
                            request.setSignal(
                                AbortSignal.any([
                                    this.signal,
                                    AbortSignal.timeout(30_000)
                                ])
                            )
                            return request
                        })()
                    ),
                post: (response) => {
                    this.uncertainRequest = false
                    return new Observable(Promise.resolve(response))
                }
            }
        ]
    }

    async stop(): Promise<boolean> {
        this.stopped = true
        clearInterval(this.heartbeat)
        clearTimeout(this.deadline)
        await this.renewing
        const settled = !this.uncertainRequest && !this.signal.aborted
        this.abort.abort(new Error('fresh container owner stopped'))
        return settled
    }
}
