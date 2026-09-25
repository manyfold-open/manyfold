import { ApiException } from '@kubernetes/client-node'
import {
    ConflictException,
    Inject,
    Injectable,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    daemonTokens,
    serviceLeases,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database
} from '@manyfold/db'
import { podRunnerHostName } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import {
    KubernetesService,
    type K8sApis
} from '@/modules/k8s/kubernetes.service'
import { teardownCreatedPodHost } from '@/modules/agents/orchestration/k8s-strict-teardown'
import { deletePodRunnerHostForPodHost } from '../sprite-runner-teardown'
import {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT,
    k8sCreateInProgress,
    k8sCreateLeaseName,
    lockK8sCreateLease
} from './k8s-create-ownership'
export {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT
} from './k8s-create-ownership'

export const describeK8sCreateError = (error: unknown): string => {
    if (error instanceof ApiException)
        return `ApiException: Kubernetes API HTTP ${error.code}`
    if (error instanceof Error)
        return redactCredentialText(`${error.name}: ${error.message}`).slice(
            0,
            512
        )
    return 'Unknown error'
}

const recovery = (runtimeId: string) => ({
    runtimeId,
    recoveryUrl: `/settings/runtimes/${runtimeId}`
})

export class K8sCreateCleanupPendingError extends ServiceUnavailableException {
    constructor(runtimeId: string, original: string, cleanup: string) {
        super({
            code: 'RUNTIME_CREATE_CLEANUP_PENDING',
            message: `Agent creation failed and container cleanup is incomplete. Open Settings > Runtimes (${runtimeId}) and retry Delete before creating another container on this cluster.`,
            ...recovery(runtimeId),
            creationError: original,
            cleanupError: cleanup
        })
    }
}

@Injectable()
export class K8sCreateCleanupService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly k8s: KubernetesService
    ) {}

    async assertClusterAvailable(
        userId: string,
        clusterId: string
    ): Promise<void> {
        const [pending] = await this.db
            .select({ id: agentRuntimes.id })
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.userId, userId),
                    eq(agentRuntimes.clusterId, clusterId),
                    eq(agentRuntimes.kind, 'k8s'),
                    eq(agentRuntimes.currentPhase, K8S_CREATE_CLEANUP_PENDING)
                )
            )
            .limit(1)
        if (pending)
            throw new ConflictException({
                code: 'RUNTIME_CREATE_CLEANUP_PENDING',
                message: `A failed container on this cluster still needs cleanup. Open Settings > Runtimes (${pending.id}) and retry Delete.`,
                ...recovery(pending.id)
            })
    }

    async rollback(args: {
        runtimeId: string
        userId: string
        agentId: string
        error: unknown
        apis: K8sApis
        clusterId: string
        namespace: string
        requestsSettled?: boolean
    }): Promise<void> {
        const failureReason = describeK8sCreateError(args.error)
        try {
            // Commit this marker before external cleanup; a lost process still
            // leaves a visible, owned runtime that explicit DELETE can retry.
            const runtime = await this.db.transaction(async (tx) => {
                await tx.execute(
                    sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
                )
                await tx
                    .select({ id: agentRuntimes.id })
                    .from(agentRuntimes)
                    .where(eq(agentRuntimes.id, args.runtimeId))
                    .for('update')
                const lease = await lockK8sCreateLease(tx, args.runtimeId)
                if (lease && lease.holderId !== args.agentId)
                    throw new Error('fresh container creation ownership lost')
                if (args.requestsSettled && lease?.holderId === args.agentId)
                    await tx
                        .delete(serviceLeases)
                        .where(
                            eq(
                                serviceLeases.name,
                                k8sCreateLeaseName(args.runtimeId)
                            )
                        )
                const [row] = await tx
                    .update(agentRuntimes)
                    .set({
                        status: 'failed',
                        currentPhase: K8S_CREATE_CLEANUP_PENDING,
                        failureReason,
                        updatedAt: new Date()
                    })
                    .where(
                        and(
                            eq(agentRuntimes.id, args.runtimeId),
                            eq(agentRuntimes.userId, args.userId),
                            eq(agentRuntimes.kind, 'k8s'),
                            eq(agentRuntimes.clusterId, args.clusterId),
                            eq(agentRuntimes.namespace, args.namespace),
                            eq(
                                agentRuntimes.currentPhase,
                                K8S_CREATE_INITIAL_AGENT
                            ),
                            eq(agentRuntimes.status, 'pending')
                        )
                    )
                    .returning()
                return row
            })
            if (!runtime)
                throw new Error(
                    'fresh runtime ownership changed; automatic cleanup refused'
                )
            await this.cleanup(runtime, args.agentId, args.apis)
        } catch (cleanupError) {
            // This runs after the cleanup transaction has released its lock.
            await this.db
                .update(agentRuntimes)
                .set({
                    failureReason: `${failureReason}; cleanup: ${describeK8sCreateError(cleanupError)}`,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(agentRuntimes.id, args.runtimeId),
                        eq(agentRuntimes.userId, args.userId),
                        eq(
                            agentRuntimes.currentPhase,
                            K8S_CREATE_CLEANUP_PENDING
                        )
                    )
                )
                .catch(() => undefined)
            throw new K8sCreateCleanupPendingError(
                args.runtimeId,
                failureReason,
                describeK8sCreateError(cleanupError)
            )
        }
    }

    async retry(runtime: AgentRuntimeRow): Promise<void> {
        if (
            runtime.kind !== 'k8s' ||
            (runtime.currentPhase !== K8S_CREATE_CLEANUP_PENDING &&
                runtime.currentPhase !== K8S_CREATE_INITIAL_AGENT)
        )
            throw new ConflictException(
                'runtime is not awaiting create cleanup'
            )
        try {
            if (runtime.currentPhase === K8S_CREATE_INITIAL_AGENT) {
                runtime = await this.db.transaction(async (tx) => {
                    await tx.execute(
                        sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true)`
                    )
                    const [current] = await tx
                        .select()
                        .from(agentRuntimes)
                        .where(eq(agentRuntimes.id, runtime.id))
                        .for('update')
                    if (
                        !current ||
                        current.currentPhase !== K8S_CREATE_INITIAL_AGENT
                    )
                        throw new ConflictException(
                            'runtime creation state changed; retry Delete'
                        )
                    const lease = await lockK8sCreateLease(tx, runtime.id)
                    if (lease?.active) throw k8sCreateInProgress()
                    const [failed] = await tx
                        .update(agentRuntimes)
                        .set({
                            status: 'failed',
                            currentPhase: K8S_CREATE_CLEANUP_PENDING,
                            failureReason:
                                'Container creation owner exited or expired; explicit cleanup requested',
                            updatedAt: new Date()
                        })
                        .where(eq(agentRuntimes.id, runtime.id))
                        .returning()
                    return failed
                })
            }
            if (!runtime.clusterId)
                throw new Error(
                    'original container cluster is no longer registered'
                )
            const { apis } = await this.k8s.getClient(runtime.clusterId)
            await this.cleanup(runtime, undefined, apis)
        } catch (error) {
            if (error instanceof ConflictException) throw error
            throw new K8sCreateCleanupPendingError(
                runtime.id,
                redactCredentialText(
                    runtime.failureReason ?? 'Agent creation failed'
                ).slice(0, 1024),
                describeK8sCreateError(error)
            )
        }
    }

    private async cleanup(
        runtime: AgentRuntimeRow,
        ownedAgentId: string | undefined,
        apis: K8sApis
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            const signal = AbortSignal.timeout(30_000)
            await tx.execute(
                sql`select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '5000', true), set_config('idle_in_transaction_session_timeout', '35000', true)`
            )
            const [current] = await tx
                .select()
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.id, runtime.id),
                        eq(agentRuntimes.userId, runtime.userId)
                    )
                )
                .for('update')
            if (!current) return
            if (
                current.currentPhase !== K8S_CREATE_CLEANUP_PENDING ||
                current.status !== 'failed' ||
                current.clusterId !== runtime.clusterId ||
                current.namespace !== runtime.namespace
            )
                throw new ConflictException('runtime cleanup ownership changed')
            // The pod host this create made for the runtime (ADR-0035). Locked
            // first: a framework added to it meanwhile has to either commit
            // before this cleanup (and be seen as a sibling below) or fail on
            // the host it referenced.
            const hostId = current.hostId
            if (!hostId) throw new Error('fresh runtime has no pod host')
            await tx
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, hostId))
                .for('update')
            signal.throwIfAborted()
            const lease = await lockK8sCreateLease(tx, runtime.id)
            if (lease?.active) throw k8sCreateInProgress()
            await tx
                .delete(serviceLeases)
                .where(eq(serviceLeases.name, k8sCreateLeaseName(runtime.id)))
            signal.throwIfAborted()
            // Registration owns this token lock before creating/binding its
            // host. Take it first so a late committed runner cannot be missed.
            await tx
                .select({ id: daemonTokens.id })
                .from(daemonTokens)
                .where(
                    and(
                        eq(daemonTokens.userId, current.userId),
                        eq(daemonTokens.name, podRunnerHostName(hostId)),
                        eq(daemonTokens.purpose, 'pod_runner')
                    )
                )
                .for('update')
            signal.throwIfAborted()
            const runners = await tx
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.userId, current.userId),
                        eq(runtimeHosts.managed, true),
                        eq(runtimeHosts.kind, 'daemon'),
                        eq(runtimeHosts.name, podRunnerHostName(hostId))
                    )
                )
                .for('update')
            signal.throwIfAborted()
            const children = runners.length
                ? await tx
                      .select({ id: agentRuntimes.id })
                      .from(agentRuntimes)
                      .where(
                          inArray(
                              agentRuntimes.daemonId,
                              runners.map((runner) => runner.id)
                          )
                      )
                      .for('update')
                : []
            signal.throwIfAborted()
            const attached = await tx
                .select({ id: agents.id, runtimeId: agents.runtimeId })
                .from(agents)
                .where(
                    inArray(agents.runtimeId, [
                        runtime.id,
                        ...children.map((child) => child.id)
                    ])
                )
            if (
                ownedAgentId &&
                attached.some(
                    (agent) =>
                        agent.id !== ownedAgentId ||
                        agent.runtimeId !== current.id
                )
            )
                throw new ConflictException(
                    'another agent attached; automatic container cleanup refused'
                )
            if (!current.namespace)
                throw new Error('fresh runtime namespace is missing')
            // Another framework added to the fresh host in the meantime keeps
            // the host: only this runtime goes.
            const siblings = await tx
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.hostId, hostId),
                        ne(agentRuntimes.id, current.id)
                    )
                )
                .for('update')
            if (siblings.length > 0) {
                await tx
                    .delete(agentRuntimes)
                    .where(eq(agentRuntimes.id, current.id))
                return
            }
            await teardownCreatedPodHost({
                apis,
                namespace: current.namespace,
                hostId,
                signal
            })
            signal.throwIfAborted()
            // Same transaction: a second DB connection would wait on the FK
            // locks held here and could leave the runner untracked on failure.
            await deletePodRunnerHostForPodHost(tx, current.userId, hostId)
            signal.throwIfAborted()
            await tx
                .delete(daemonTokens)
                .where(
                    and(
                        eq(daemonTokens.userId, current.userId),
                        eq(daemonTokens.name, podRunnerHostName(hostId)),
                        eq(daemonTokens.purpose, 'pod_runner'),
                        isNull(daemonTokens.daemonId)
                    )
                )
            signal.throwIfAborted()
            await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.id, current.id))
            await tx
                .delete(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.id, hostId),
                        eq(runtimeHosts.kind, 'pod')
                    )
                )
            signal.throwIfAborted()
        })
    }
}
