import 'reflect-metadata'
import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and, inArray, isNull, sql } from 'drizzle-orm'
import {
    schema,
    users,
    k8sClusters,
    agentRuntimes,
    agents,
    daemonTokens,
    runtimeHosts,
    chatSessions,
    serviceLeases,
    type Database,
    type AgentRuntimeRow
} from '@manyfold/db'
import { createObjectId, podRunnerHostName } from '@manyfold/shared'
import type { ConfigService } from '@nestjs/config'
import { GatewayTimeoutException, Logger } from '@nestjs/common'
import { CryptoService } from '../src/modules/secrets/crypto.service'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import { KubernetesService } from '../src/modules/k8s/kubernetes.service'
import { K8sContainerProvisioner } from '../src/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { K8sCreateCleanupService } from '../src/modules/agent-runtimes/provisioning/k8s-create-cleanup.service'
import { k8sCreateLeaseName } from '../src/modules/agent-runtimes/provisioning/k8s-create-ownership'
import { K8sProvisioner } from '../src/modules/agent-runtimes/provisioning/k8s-provisioner'
import { AgentRuntimesController } from '../src/modules/agent-runtimes/agent-runtimes.controller'
import { AdminAgentRuntimesController } from '../src/modules/agent-runtimes/admin-agent-runtimes.controller'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'
import { ChatService } from '../src/modules/chat/chat.service'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import {
    RuntimeAgentsController,
    AdminRuntimeAgentsController
} from '../src/modules/agents/runtime-agents.controller'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { openCloudComputerPort } from '../src/common/ports/cloud-computer.ports'
import { K8sLifecycleFixture } from './helpers/k8s-lifecycle-fixture'

const RUN = process.env.RUN_PG_E2E === '1'

const fixture = async (t: TestContext) => {
    const framework = 'codex'
    assert(process.env.DATABASE_URL)
    const client = postgres(process.env.DATABASE_URL, { max: 4 })
    const db: Database = drizzle(client, { schema })
    const api = new K8sLifecycleFixture()
    await api.start()
    const userId = createObjectId('user')
    const clusterId = createObjectId('k8sCluster')
    const clusterIds = [clusterId]
    const apis = [api]
    t.after(async () => {
        for (const server of apis) await server.close()
        try {
            const runtimeRows = await db
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(eq(agentRuntimes.userId, userId))
            if (runtimeRows.length)
                await db.delete(serviceLeases).where(
                    inArray(
                        serviceLeases.name,
                        runtimeRows.map((row) => k8sCreateLeaseName(row.id))
                    )
                )
            await db.delete(users).where(eq(users.id, userId))
            await db
                .delete(k8sClusters)
                .where(inArray(k8sClusters.id, clusterIds))
        } finally {
            await client.end({ timeout: 5 })
        }
    })
    const configValues: Record<string, string> = {
        API_CRYPTO_KEY: randomBytes(32).toString('base64'),
        K8S_CONTAINER_PROVISION_TIMEOUT_MS: '2000',
        K8S_RUNTIME_IMAGE: 'fixture-only'
    }
    const config = { get: (key: string) => configValues[key] } as ConfigService
    const crypto = new CryptoService(config)
    const kubeconfig = crypto.encrypt(api.kubeconfig())
    await db
        .insert(users)
        .values({ id: userId, email: `${userId}@fixture.invalid` })
    await db.insert(k8sClusters).values({
        id: clusterId,
        name: `fixture-${clusterId}`,
        lastHealthStatus: 'ok',
        kubeconfigCiphertext: kubeconfig.ciphertext,
        kubeconfigKeyVersion: kubeconfig.keyVersion,
        hostSuffix: 'fixture.invalid'
    })
    const k8s = new KubernetesService(config, db, crypto)
    const cleanup = new K8sCreateCleanupService(db, k8s)
    const runtimes = new AgentRuntimesService(db, { event() {} } as never)
    // pod host id -> the runner token minted for it
    const minted = new Map<string, string>()
    const registered = new Set<string>()
    const podRunner = {
        mint: async (
            input: { podHostId: string },
            store: Pick<Database, 'insert'> = db
        ) => {
            const tokenId = `ldt_${randomUUID()}`
            await store.insert(daemonTokens).values({
                id: tokenId,
                userId,
                name: podRunnerHostName(input.podHostId),
                tokenHash: `fixture-${tokenId}`,
                purpose: 'pod_runner'
            })
            minted.set(input.podHostId, tokenId)
            return { env: { MF_DAEMON_TOKEN: 'fixture-only' }, tokenId }
        },
        discardUnbound: async (_userId: string, tokenId: string) => {
            await db
                .delete(daemonTokens)
                .where(
                    and(
                        eq(daemonTokens.id, tokenId),
                        isNull(daemonTokens.daemonId)
                    )
                )
        }
    }
    const failure = new Error('owned fixture attach timeout')
    const behavior: {
        failAttach: boolean
        failConfig: boolean
        failDefaults: boolean
        // The host's daemon registering the moment its pod runs; the
        // provisioner waits for it before installing anything.
        registerRunner: boolean
        beforeAttach?: (runtime: AgentRuntimeRow) => Promise<void>
        afterRunner?: () => Promise<void>
        beforeDefaults?: () => Promise<void>
    } = {
        failAttach: true,
        failConfig: false,
        failDefaults: false,
        registerRunner: true
    }
    const registerRunner = async (podHostId: string): Promise<void> => {
        const hostId = createObjectId('daemonHost')
        await db.insert(runtimeHosts).values({
            id: hostId,
            userId,
            kind: 'daemon',
            managed: true,
            daemonUuid: randomUUID(),
            name: podRunnerHostName(podHostId),
            status: 'active',
            rpcConnectedAt: new Date()
        })
        await db
            .update(daemonTokens)
            .set({ daemonId: hostId })
            .where(eq(daemonTokens.id, minted.get(podHostId)!))
        await db.insert(agentRuntimes).values({
            id: createObjectId('agentRuntime'),
            userId,
            name: 'fixture runner',
            kind: 'daemon',
            framework: 'codex',
            daemonId: hostId
        })
    }
    const hooks: {
        afterCreate?: (collection: string, name: string) => Promise<void>
    } = {}
    api.afterCreate = async (collection, name) => {
        await hooks.afterCreate?.(collection, name)
        if (collection !== 'deployments' || !behavior.registerRunner) return
        for (const podHostId of minted.keys()) {
            if (registered.has(podHostId)) continue
            registered.add(podHostId)
            await registerRunner(podHostId)
            await behavior.afterRunner?.()
        }
    }
    // Every install step answers as a host that already runs the requested
    // version, so a create reaches its attach without touching npm.
    const podExec = {
        forClient: () => ({
            run: async () => ({ exitCode: 0, stdout: '1.0.0', stderr: '' })
        })
    }
    const frameworkVersions = {
        resolveInstallVersion: async () => ({
            selection: { version: '1.0.0', source: 'latest' },
            repo: null
        })
    }
    // Coding frameworks only: nothing here runs as a host service.
    const podServices = {} as never
    const k8sProvisioner = new K8sProvisioner(
        db,
        k8s,
        runtimes,
        cleanup,
        podServices
    )
    const provisioner = new K8sContainerProvisioner(
        db,
        k8s,
        config,
        crypto,
        podRunner as never,
        cleanup,
        podExec as never,
        frameworkVersions as never,
        k8sProvisioner,
        podServices
    )
    const adapter = {
        addAgent: async (input: {
            runtime: AgentRuntimeRow
            agentId: string
        }) => {
            await behavior.beforeAttach?.(input.runtime)
            if (behavior.failAttach) throw failure
            return {
                internalId: input.agentId,
                workspace: `/workspace/${input.agentId}`,
                model: null,
                extras: {}
            }
        },
        removeAgent: async () => {}
    }
    const credentials = {
        resolve: async () => ({ value: {} }),
        assertManagedChannelBindable: async () => {}
    }
    const attach = new RuntimeAgentAttachService(
        db,
        { get: () => adapter } as never,
        { touchAfterWrite() {} } as never,
        credentials as never,
        {
            installDefaults: async () => {
                await behavior.beforeDefaults?.()
                if (behavior.failDefaults) throw failure
            }
        } as never
    )
    const orchestrator = Object.assign(
        Object.create(AgentOrchestratorService.prototype),
        {
            db,
            runtimes,
            attach,
            k8sProvisioner: provisioner,
            cloudComputer: openCloudComputerPort,
            adminSettings: {
                isFeatureEnabled: async () => true,
                getCachedFrameworkDefaultVersions: async () => ({
                    defaults: {}
                })
            },
            frameworkVersions: { latestForFresh: async () => '1.0.0' },
            credentialsResolver: credentials,
            modelConfig: {
                updateForAgent: async () => {
                    if (behavior.failConfig) throw failure
                }
            }
        }
    ) as AgentOrchestratorService
    const create = (
        runtimeId?: string,
        overrides: Record<string, unknown> = {}
    ): Promise<unknown> =>
        (
            orchestrator as unknown as {
                createK8sAgent(
                    context: unknown,
                    emitter: unknown
                ): Promise<unknown>
            }
        ).createK8sAgent(
            {
                userId,
                isAdmin: false,
                dto: {
                    name: 'owned fixture',
                    framework,
                    runtime: 'k8s',
                    clusterId,
                    ...(runtimeId ? { runtimeId } : {}),
                    ...(behavior.failConfig
                        ? { modelConfigSource: 'runtime-local' }
                        : {}),
                    ...overrides
                }
            },
            { step() {} }
        )
    const controller = Object.assign(
        Object.create(AgentRuntimesController.prototype),
        { db, runtimes, k8sProvisioner }
    ) as AgentRuntimesController
    const remove = (runtimeId: string) =>
        controller.delete({ userId } as never, runtimeId)
    const addCluster = async () => {
        const nextApi = new K8sLifecycleFixture()
        await nextApi.start()
        nextApi.afterCreate = api.afterCreate
        apis.push(nextApi)
        const id = createObjectId('k8sCluster')
        clusterIds.push(id)
        const encrypted = crypto.encrypt(nextApi.kubeconfig())
        await db.insert(k8sClusters).values({
            id,
            name: `fixture-${id}`,
            lastHealthStatus: 'ok',
            hostSuffix: 'fixture.invalid',
            kubeconfigCiphertext: encrypted.ciphertext,
            kubeconfigKeyVersion: encrypted.keyVersion
        })
        return { id, api: nextApi }
    }
    return {
        db,
        client,
        api,
        hooks,
        userId,
        clusterId,
        create,
        failure,
        behavior,
        provisioner,
        k8sProvisioner,
        runtimes,
        attach,
        k8s,
        cleanup,
        remove,
        controller,
        credentials,
        addCluster
    }
}

test(
    'failed self-serve creates leave no runtime or remote resources across retries',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        for (let attempt = 0; attempt < 2; attempt++)
            await assert.rejects(h.create(), (error) => error === h.failure)
        assert.deepEqual(
            await h.db
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(eq(agentRuntimes.userId, h.userId)),
            []
        )
        assert.deepEqual(
            await h.db
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(eq(runtimeHosts.userId, h.userId)),
            []
        )
        assert.deepEqual(
            await h.db
                .select({ id: daemonTokens.id })
                .from(daemonTokens)
                .where(eq(daemonTokens.userId, h.userId)),
            []
        )
        assert.deepEqual(h.api.runtimeResources(), [])
    }
)

test(
    'an attach failure on an existing runtime does not destroy its resources',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        const { runtime } = await h.provisioner.provision({
            userId: h.userId,
            name: 'existing fixture',
            credentials: {},
            clusterId: h.clusterId,
            framework: 'codex',
            sku: {
                id: null,
                region: null,
                cpuMillicores: 1000,
                memoryMb: 2048,
                diskGb: 10
            }
        })
        const resourcesBefore = h.api.runtimeResources()
        await assert.rejects(
            h.create(runtime.id),
            (error) => error === h.failure
        )
        assert.equal((await h.runtimes.findById(runtime.id))?.status, 'ready')
        assert.deepEqual(h.api.runtimeResources(), resourcesBefore)
        assert.equal(
            h.api.requests.filter((request) => request.method === 'DELETE')
                .length,
            0
        )
    }
)

test(
    'a successful self-serve create only becomes ready after its agent is committed',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.behavior.failAttach = false
        h.behavior.beforeAttach = async (runtime) => {
            assert.equal(
                (await h.runtimes.findById(runtime.id))?.status,
                'pending'
            )
        }
        const summary = (await h.create()) as { id: string; runtimeId: string }
        const [row] = await h.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.userId, h.userId),
                    eq(agentRuntimes.kind, 'k8s')
                )
            )
        assert.equal(row.status, 'ready')
        assert.deepEqual(
            await h.db
                .select()
                .from(serviceLeases)
                .where(eq(serviceLeases.name, k8sCreateLeaseName(row.id))),
            []
        )
        assert.equal(row.currentPhase, null)
        assert.equal(row.primaryAgentId, summary.id)
        assert.equal(
            (await h.db.select().from(agents).where(eq(agents.id, summary.id)))
                .length,
            1
        )
        assert(h.api.runtimeResources().length > 0)
    }
)

for (const phase of ['failConfig', 'failDefaults'] as const)
    test(
        `a ${phase} after agent insertion rolls back only the fresh runtime`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const h = await fixture(t)
            h.behavior.failAttach = false
            h.behavior[phase] = true
            await assert.rejects(h.create(), (error) => error === h.failure)
            assert.deepEqual(await h.runtimes.listByUser(h.userId), [])
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(agents)
                        .where(eq(agents.userId, h.userId))
                ).length,
                0
            )
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(runtimeHosts)
                        .where(eq(runtimeHosts.userId, h.userId))
                ).length,
                0
            )
            assert.deepEqual(h.api.runtimeResources(), [])
        }
    )

test(
    'provision failure cleans partial resources and its unbound runner token',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.api.failCreate = 'deployments'
        await assert.rejects(h.create(), /container provisioning failed/)
        assert.deepEqual(await h.runtimes.listByUser(h.userId), [])
        assert.equal(
            (
                await h.db
                    .select()
                    .from(daemonTokens)
                    .where(eq(daemonTokens.userId, h.userId))
            ).length,
            0
        )
        assert.deepEqual(h.api.runtimeResources(), [])
    }
)

for (const failedStage of ['provision', 'attach'] as const)
    test(
        `${failedStage} cleanup failure is visible, blocks another create and strict DELETE can recover`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const h = await fixture(t)
            if (failedStage === 'provision') h.api.failCreate = 'deployments'
            h.api.failDelete = 'persistentvolumeclaims'
            await assert.rejects(
                h.create(),
                (error: any) =>
                    error.getResponse?.().code ===
                    'RUNTIME_CREATE_CLEANUP_PENDING'
            )
            const rows = await h.runtimes.listByUser(h.userId)
            const runtime = rows.find((row) => row.kind === 'k8s')!
            assert.equal(runtime.status, 'failed')
            assert.equal(runtime.currentPhase, 'create_cleanup_pending')
            assert.match(runtime.failureReason ?? '', /cleanup/)
            const summary = await h.controller.get(
                { userId: h.userId } as never,
                runtime.id
            )
            assert.equal(summary.status, 'failed')
            assert.equal(summary.failureReason, runtime.failureReason)
            assert(
                h.api
                    .runtimeResources()
                    .some(
                        (resource) => resource.kind === 'PersistentVolumeClaim'
                    )
            )
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(daemonTokens)
                        .where(eq(daemonTokens.userId, h.userId))
                ).length,
                1
            )
            const requestsBefore = h.api.requests.length
            await assert.rejects(h.create(), (error: any) => {
                const response = error.getResponse?.()
                return (
                    error.getStatus?.() === 409 &&
                    response.runtimeId === runtime.id &&
                    response.recoveryUrl === `/settings/runtimes/${runtime.id}`
                )
            })
            assert.equal(h.api.requests.length, requestsBefore)
            assert.equal(
                (await h.runtimes.listByUser(h.userId)).filter(
                    (row) => row.kind === 'k8s'
                ).length,
                1
            )
            h.api.failDelete = null
            await h.remove(runtime.id)
            assert.deepEqual(await h.runtimes.listByUser(h.userId), [])
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(runtimeHosts)
                        .where(eq(runtimeHosts.userId, h.userId))
                ).length,
                0
            )
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(daemonTokens)
                        .where(eq(daemonTokens.userId, h.userId))
                ).length,
                0
            )
            assert.deepEqual(h.api.runtimeResources(), [])
        }
    )

const barrier = () => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
    })
    const released = new Promise<void>((resolve) => {
        release = resolve
    })
    return { enter, release, entered, released }
}

const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer!: ReturnType<typeof setTimeout>
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('fixture barrier timed out')),
                    5000
                )
            })
        ])
    } finally {
        clearTimeout(timer)
    }
}

test(
    'a terminated create owner is recoverable through explicit DELETE after its DB lease expires',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        const { runtime } = await h.provisioner.provision({
            userId: h.userId,
            name: 'interrupted fixture',
            credentials: {},
            clusterId: h.clusterId,
            framework: 'codex',
            sku: {
                id: null,
                region: null,
                cpuMillicores: 1000,
                memoryMb: 2048,
                diskGb: 10
            }
        })
        const child = fork(
            join(__dirname, 'helpers/k8s-create-owner-child.ts'),
            [runtime.id, createObjectId('agent')],
            {
                execArgv: ['--import', 'tsx'],
                env: {
                    PATH: process.env.PATH,
                    DATABASE_URL: process.env.DATABASE_URL
                },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            }
        )
        let stderr = ''
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk)
        })
        const exited = once(child, 'exit')
        try {
            const [message] = await bounded(
                Promise.race([
                    once(child, 'message'),
                    exited.then(() => {
                        throw new Error(stderr)
                    })
                ])
            )
            assert.equal(message, 'owned', stderr)
            await assert.rejects(
                h.remove(runtime.id),
                (error: any) => error.getStatus?.() === 409
            )
            child.kill('SIGKILL')
            await bounded(exited)
            await assert.rejects(
                h.remove(runtime.id),
                (error: any) => error.getStatus?.() === 409
            )
            const [lease] =
                await h.client`select expires_at > clock_timestamp() as active, extract(epoch from (expires_at - acquired_at)) as ttl from service_leases where name = ${k8sCreateLeaseName(runtime.id)}`
            assert.equal(lease.active, true)
            assert(Number(lease.ttl) >= 90 && Number(lease.ttl) < 95)
            // Advance only this owned fixture's persisted lease, not the host clock.
            await h.db
                .update(serviceLeases)
                .set({
                    expiresAt: sql`clock_timestamp() - interval '1 second'`
                })
                .where(eq(serviceLeases.name, k8sCreateLeaseName(runtime.id)))
            await h.remove(runtime.id)
            assert.equal(await h.runtimes.findById(runtime.id), null)
            assert.deepEqual(h.api.runtimeResources(), [])
            assert.deepEqual(
                await h.db
                    .select()
                    .from(serviceLeases)
                    .where(
                        eq(serviceLeases.name, k8sCreateLeaseName(runtime.id))
                    ),
                []
            )
        } finally {
            child.kill('SIGKILL')
            await bounded(exited)
        }
    }
)

test(
    'a lost owner cannot advance a late successful Kubernetes POST or publish its agent',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const gate = barrier()
        const h = await fixture(t)
        h.behavior.failAttach = false
        h.hooks.afterCreate = async (collection) => {
            if (collection !== 'secrets') return
            gate.enter()
            await bounded(gate.released)
        }
        const creating = h.create().then(
            () => null,
            (error: unknown) => error
        )
        try {
            await bounded(gate.entered)
            const [runtime] = await h.runtimes.listByUser(h.userId)
            await h.db
                .update(serviceLeases)
                .set({
                    expiresAt: sql`clock_timestamp() - interval '1 second'`
                })
                .where(eq(serviceLeases.name, k8sCreateLeaseName(runtime.id)))
        } finally {
            gate.release()
        }
        assert(await bounded(creating))
        assert.deepEqual(
            h.api.requests
                .filter(
                    (request) =>
                        request.method === 'POST' &&
                        request.collection !== 'namespaces'
                )
                .map((request) => ({
                    collection: request.collection,
                    timeout: request.timeout
                })),
            [{ collection: 'secrets', timeout: '30s' }]
        )
        assert.deepEqual(await h.runtimes.listByUser(h.userId), [])
        assert.deepEqual(
            await h.db.select().from(agents).where(eq(agents.userId, h.userId)),
            []
        )
        assert.deepEqual(h.api.runtimeResources(), [])
    }
)

test(
    'an unconfirmed create response keeps its lease margin and recovery row until explicit cleanup is safe',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.api.dropCreateResponse = 'secrets'
        await assert.rejects(
            h.create(),
            (error: any) =>
                error.getResponse?.().code === 'RUNTIME_CREATE_CLEANUP_PENDING'
        )
        const [runtime] = await h.runtimes.listByUser(h.userId)
        assert.equal(runtime.currentPhase, 'create_cleanup_pending')
        assert.equal(h.api.runtimeResources().length, 1)
        await assert.rejects(
            h.remove(runtime.id),
            (error: any) => error.getStatus?.() === 409
        )
        assert.equal(
            h.api.requests.filter((request) => request.method === 'DELETE')
                .length,
            0
        )
        await h.db
            .update(serviceLeases)
            .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
            .where(eq(serviceLeases.name, k8sCreateLeaseName(runtime.id)))
        await h.remove(runtime.id)
        assert.equal(await h.runtimes.findById(runtime.id), null)
        assert.deepEqual(h.api.runtimeResources(), [])
    }
)

for (const role of ['user', 'admin'] as const)
    test(
        `${role} DELETE cannot remove ownership while a Kubernetes create request is in flight`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const gate = barrier()
            const h = await fixture(t)
            const collection = role === 'user' ? 'secrets' : 'deployments'
            h.api.beforeCreate = async (creating) => {
                if (creating !== collection) return
                gate.enter()
                await bounded(gate.released)
            }
            const creating = h.create().then(
                () => null,
                (error: unknown) => error
            )
            let deletionError: unknown
            try {
                await bounded(gate.entered)
                const [runtime] = await h.runtimes.listByUser(h.userId)
                const admin = Object.assign(
                    Object.create(AdminAgentRuntimesController.prototype),
                    {
                        db: h.db,
                        runtimes: h.runtimes,
                        k8sProvisioner: h.k8sProvisioner
                    }
                ) as AdminAgentRuntimesController
                deletionError = await (
                    role === 'user'
                        ? h.remove(runtime.id)
                        : admin.delete(runtime.id)
                ).then(
                    () => null,
                    (error: unknown) => error
                )
            } finally {
                gate.release()
                await bounded(creating)
            }
            const rows = await h.runtimes.listByUser(h.userId)
            const witness = {
                deleteStatus:
                    (
                        deletionError as { getStatus?(): number } | null
                    )?.getStatus?.() ?? null,
                runtimes: rows.length,
                resources: h.api.runtimeResources().length
            }
            t.diagnostic(JSON.stringify(witness))
            assert.deepEqual(witness, {
                deleteStatus: 409,
                runtimes: 0,
                resources: 0
            })
            assert.equal(await creating, h.failure)
        }
    )

test(
    'cleanup fences a pod runner registration already holding its token lock',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        // The daemon registers just as the create gives up waiting for it:
        // cleanup must neither miss the runner nor delete anything remote
        // before that registration commits.
        const gate = barrier()
        const h = await fixture(t)
        h.behavior.registerRunner = false
        let registrationPid = 0
        const daemonHosts = Object.assign(
            Object.create(DaemonHostService.prototype),
            {
                db: h.db,
                runtimeAccess: {
                    lockDaemonHostRegistrationInTx: async (tx: Database) => {
                        const [connection] = await tx.execute(
                            sql`select pg_backend_pid() as pid`
                        )
                        registrationPid = Number(connection.pid)
                        gate.enter()
                        await bounded(gate.released)
                    }
                }
            }
        ) as DaemonHostService
        let registering: Promise<unknown> | undefined
        h.hooks.afterCreate = async (collection) => {
            if (collection !== 'deployments') return
            const [token] = await h.db
                .select()
                .from(daemonTokens)
                .where(
                    and(
                        eq(daemonTokens.userId, h.userId),
                        eq(daemonTokens.purpose, 'pod_runner')
                    )
                )
            registering = daemonHosts.upsertOnRegister({
                tokenId: token.id,
                lastIp: null,
                request: {
                    daemonUuid: randomUUID(),
                    name: token.name,
                    hostname: null,
                    os: 'linux',
                    arch: 'x64',
                    cliVersion: '3.0.2',
                    homeDir: '/home/node',
                    workspaceBaseDir: '/home/node/.manyfold/workspaces',
                    detectedFrameworks: []
                }
            })
            void registering.catch(() => undefined)
            await bounded(gate.entered)
        }
        const failed = assert.rejects(
            h.create(),
            (error) => error instanceof GatewayTimeoutException
        )
        void failed.catch(() => undefined)
        let deletesBeforeRegistrationCommitted = -1
        try {
            await bounded(gate.entered)
            await bounded(
                (async () => {
                    while (true) {
                        const [blocked] =
                            await h.client`select pid from pg_stat_activity where ${registrationPid} = any(pg_blocking_pids(pid))`
                        if (blocked) return
                        await new Promise((resolve) => setTimeout(resolve, 10))
                    }
                })()
            )
            deletesBeforeRegistrationCommitted = h.api.requests.filter(
                (request) => request.method === 'DELETE'
            ).length
        } finally {
            gate.release()
            await bounded(Promise.all([failed, registering]))
        }
        const hosts = await h.db
            .select({ id: runtimeHosts.id })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.userId, h.userId))
        const tokens = await h.db
            .select({ id: daemonTokens.id })
            .from(daemonTokens)
            .where(eq(daemonTokens.userId, h.userId))
        const runtimes = await h.db
            .select({ id: agentRuntimes.id })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.userId, h.userId))
        const witness = {
            deletesBeforeRegistrationCommitted,
            hosts: hosts.length,
            tokens: tokens.length,
            runtimes: runtimes.length,
            resources: h.api.runtimeResources().length
        }
        t.diagnostic(JSON.stringify(witness))
        assert.deepEqual(witness, {
            deletesBeforeRegistrationCommitted: 0,
            hosts: 0,
            tokens: 0,
            runtimes: 0,
            resources: 0
        })
    }
)

test(
    'pending self-serve runtime rejects stale external attach and reconcile before any adoption',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const gate = barrier()
        t.after(() => gate.release())
        const h = await fixture(t)
        let pendingRuntime!: AgentRuntimeRow
        h.behavior.beforeAttach = async (runtime) => {
            pendingRuntime = runtime
            gate.enter()
            await gate.released
        }
        const creating = h.create()
        const failed = assert.rejects(creating, (error) => error === h.failure)
        await bounded(gate.entered)
        const stale = { ...pendingRuntime, status: 'ready' as const }
        await assert.rejects(
            bounded(h.attach.attach({ runtime: stale, name: 'foreign' })),
            /container is not ready/
        )
        let listed = false
        const reconcile = new AgentReconcileService(h.db, {
            get: () => ({
                listAgents: async () => {
                    listed = true
                    return []
                }
            })
        } as never)
        await reconcile.reconcileRuntime(stale)
        assert.equal(listed, false)
        assert.equal(
            (
                await h.db
                    .select()
                    .from(agents)
                    .where(eq(agents.runtimeId, stale.id))
            ).length,
            0
        )
        gate.release()
        await bounded(failed)
    }
)

test(
    'automatic rollback preserves a runtime if a different agent already owns it',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        const foreignId = createObjectId('agent')
        let runtimeId!: string
        h.behavior.beforeAttach = async (runtime) => {
            runtimeId = runtime.id
            await h.db.insert(agents).values({
                id: foreignId,
                userId: h.userId,
                runtimeId,
                name: 'foreign fixture',
                internalId: 'foreign-fixture',
                framework: 'codex',
                runtime: 'k8s'
            })
        }
        await assert.rejects(h.create(), (error: any) =>
            /another agent attached/.test(error.getResponse?.().cleanupError)
        )
        assert(await h.runtimes.findById(runtimeId))
        assert.equal(
            (await h.db.select().from(agents).where(eq(agents.id, foreignId)))
                .length,
            1
        )
        assert(h.api.runtimeResources().length > 0)
        assert.equal(
            h.api.requests.filter((request) => request.method === 'DELETE')
                .length,
            0
        )
    }
)

for (const target of ['parent', 'runner', 'host', 'pod host'] as const)
    test(
        `runtime row locks fence a concurrent ${target} FK insert through remote deletion and commit`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const gate = barrier()
            t.after(() => gate.release())
            const h = await fixture(t)
            h.api.beforeDelete = async (collection) => {
                if (collection === 'deployments') {
                    gate.enter()
                    await gate.released
                }
            }
            const creating = h.create()
            const failed = assert.rejects(
                creating,
                (error) => error === h.failure
            )
            await bounded(gate.entered)
            const [runtime] = (await h.runtimes.listByUser(h.userId)).filter(
                (row) => row.kind === 'k8s'
            )
            const [child] = await h.db
                .select({
                    id: agentRuntimes.id,
                    daemonId: agentRuntimes.daemonId
                })
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.userId, h.userId),
                        eq(agentRuntimes.kind, 'daemon')
                    )
                )
            const targetId = target === 'runner' ? child.id : runtime.id
            assert.equal(
                runtime.currentPhase,
                'create_cleanup_pending',
                'marker committed before remote DELETE'
            )
            const writer = postgres(process.env.DATABASE_URL!, { max: 1 })
            t.after(() => writer.end({ timeout: 5 }))
            const [{ pid }] = await writer`select pg_backend_pid() as pid`
            await writer`set statement_timeout = '5000'`
            const writerDb = drizzle(writer, { schema })
            const insertion =
                target === 'pod host'
                    ? writerDb.insert(agentRuntimes).values({
                          id: createObjectId('agentRuntime'),
                          userId: h.userId,
                          name: 'late framework runtime',
                          framework: 'claude-code',
                          kind: 'k8s',
                          hostId: runtime.hostId
                      })
                    : target === 'host'
                    ? writerDb.insert(agentRuntimes).values({
                          id: createObjectId('agentRuntime'),
                          userId: h.userId,
                          name: 'late runner runtime',
                          framework: 'codex',
                          kind: 'daemon',
                          daemonId: child.daemonId
                      })
                    : writerDb.insert(agents).values({
                          id: createObjectId('agent'),
                          userId: h.userId,
                          runtimeId: targetId,
                          name: 'racing fixture',
                          internalId: 'racing-fixture',
                          framework: 'codex',
                          runtime: target === 'runner' ? 'daemon' : 'k8s'
                      })
            const inserted = Promise.resolve(insertion).then(
                () => null,
                (error: unknown) => error
            )
            await bounded(
                (async () => {
                    while (true) {
                        const [activity] =
                            await h.client`select wait_event_type from pg_stat_activity where pid = ${pid}`
                        if (activity?.wait_event_type === 'Lock') return
                        await new Promise((resolve) => setTimeout(resolve, 10))
                    }
                })()
            )
            gate.release()
            await bounded(failed)
            assert.equal(((await inserted) as { code?: string })?.code, '23503')
            assert.equal(await h.runtimes.findById(runtime.id), null)
            assert.deepEqual(h.api.runtimeResources(), [])
        }
    )

test(
    'accepted but terminating storage keeps durable ownership until a later DELETE confirms absence',
    { skip: !RUN, timeout: 45_000 },
    async (t) => {
        const h = await fixture(t)
        h.api.terminating = 'persistentvolumeclaims'
        await assert.rejects(
            h.create(),
            (error: any) =>
                error.getResponse?.().code === 'RUNTIME_CREATE_CLEANUP_PENDING'
        )
        const [runtime] = await h.runtimes.listByUser(h.userId)
        assert.equal(runtime.currentPhase, 'create_cleanup_pending')
        const pvc = h.api
            .runtimeResources()
            .find((resource) => resource.kind === 'PersistentVolumeClaim')
        assert(pvc?.metadata.deletionTimestamp)
        h.api.terminating = null
        await h.remove(runtime.id)
        assert.equal(await h.runtimes.findById(runtime.id), null)
        assert.deepEqual(h.api.runtimeResources(), [])
    }
)

test(
    'user and admin attach cannot create independent agents on the owned managed runner',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        let executions = 0
        const registry = {
            get: () => ({
                addAgent: async (input: { agentId: string }) => {
                    executions++
                    return {
                        internalId: input.agentId,
                        workspace: '/workspace/foreign',
                        model: null,
                        extras: {}
                    }
                }
            })
        }
        const attacher = new RuntimeAgentAttachService(
            h.db,
            registry as never,
            { touchAfterWrite() {} } as never,
            h.credentials as never,
            { installDefaults: async () => {} } as never
        )
        const userController = new RuntimeAgentsController(
            h.runtimes,
            registry as never,
            attacher,
            { recordFirstAgentCreated: async () => {} } as never
        )
        const adminController = new AdminRuntimeAgentsController(
            h.runtimes,
            registry as never,
            attacher
        )
        h.behavior.afterRunner = async () => {
            const [runner] = await h.db
                .select()
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.userId, h.userId),
                        eq(agentRuntimes.kind, 'daemon')
                    )
                )
            const denied = (error: any): boolean =>
                error.getResponse?.().code === 'MANAGED_RUNNER_RUNTIME'
            await assert.rejects(
                userController.addAgent(
                    { userId: h.userId } as never,
                    runner.id,
                    { name: 'foreign-user' } as never
                ),
                denied
            )
            await assert.rejects(
                adminController.addAgent(runner.id, {
                    name: 'foreign-admin'
                } as never),
                denied
            )
        }
        await assert.rejects(h.create(), (error) => error === h.failure)
        assert.equal(executions, 0)
    }
)

test(
    'a pre-existing independent agent on the runner prevents automatic capacity deletion',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        const foreignId = createObjectId('agent')
        h.behavior.afterRunner = async () => {
            const [child] = await h.db
                .select()
                .from(agentRuntimes)
                .where(
                    and(
                        eq(agentRuntimes.userId, h.userId),
                        eq(agentRuntimes.kind, 'daemon')
                    )
                )
            await h.db.insert(agents).values({
                id: foreignId,
                userId: h.userId,
                runtimeId: child.id,
                name: 'foreign runner fixture',
                internalId: 'foreign-runner',
                framework: 'codex',
                runtime: 'daemon',
                daemonId: child.daemonId
            })
        }
        await assert.rejects(h.create(), (error: any) =>
            /another agent attached/.test(error.getResponse?.().cleanupError)
        )
        assert.equal(
            h.api.requests.filter((request) => request.method === 'DELETE')
                .length,
            0
        )
        assert.equal(
            (await h.db.select().from(agents).where(eq(agents.id, foreignId)))
                .length,
            1
        )
        const [parent] = (await h.runtimes.listByUser(h.userId)).filter(
            (row) => row.kind === 'k8s'
        )
        assert.equal(parent.currentPhase, 'create_cleanup_pending')
        await h.remove(parent.id)
        assert.deepEqual(h.api.runtimeResources(), [])
        assert.equal(
            (await h.db.select().from(agents).where(eq(agents.id, foreignId)))
                .length,
            0
        )
    }
)

test(
    'unmanaged daemon and ready parent capacity still accept agents',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.behavior.failAttach = false
        await h.create()
        const [parent] = await h.runtimes.listByUser(h.userId)
        const controller = new RuntimeAgentsController(
            h.runtimes,
            {} as never,
            h.attach,
            { recordFirstAgentCreated: async () => {} } as never
        )
        await controller.addAgent({ userId: h.userId } as never, parent.id, {
            name: 'second parent agent'
        } as never)
        assert.equal(
            (
                await h.db
                    .select()
                    .from(agents)
                    .where(eq(agents.runtimeId, parent.id))
            ).length,
            2
        )
        const hostId = createObjectId('daemonHost')
        const runtimeId = createObjectId('agentRuntime')
        await h.db.insert(runtimeHosts).values({
            id: hostId,
            userId: h.userId,
            name: 'owned standalone daemon',
            kind: 'daemon',
            managed: false
        })
        await h.db.insert(agentRuntimes).values({
            id: runtimeId,
            userId: h.userId,
            name: 'standalone',
            kind: 'daemon',
            framework: 'codex',
            status: 'ready',
            daemonId: hostId
        })
        await controller.addAgent({ userId: h.userId } as never, runtimeId, {
            name: 'standalone agent'
        } as never)
        assert.equal(
            (
                await h.db
                    .select()
                    .from(agents)
                    .where(eq(agents.runtimeId, runtimeId))
            ).length,
            1
        )
    }
)

test(
    'cleanup guard uses the one selected default cluster and leaves other clusters available',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.api.failDelete = 'persistentvolumeclaims'
        await assert.rejects(
            h.create(),
            (error: any) =>
                error.getResponse?.().code === 'RUNTIME_CREATE_CLEANUP_PENDING'
        )
        const [pending] = await h.runtimes.listByUser(h.userId)
        const other = await h.addCluster()
        await h.db
            .update(k8sClusters)
            .set({ priority: 10 })
            .where(eq(k8sClusters.id, h.clusterId))
        const check = h.cleanup.assertClusterAvailable.bind(h.cleanup)
        let selected: string | undefined
        h.cleanup.assertClusterAvailable = async (userId, clusterId) => {
            selected = clusterId
            await h.db
                .update(k8sClusters)
                .set({ priority: 20 })
                .where(eq(k8sClusters.id, other.id))
            await check(userId, clusterId)
        }
        await assert.rejects(
            h.create(undefined, { clusterId: null }),
            (error: any) => error.getResponse?.().runtimeId === pending.id
        )
        assert.equal(selected, h.clusterId)
        assert.equal(other.api.requests.length, 0)
        h.cleanup.assertClusterAvailable = check
        h.behavior.failAttach = false
        await h.create(undefined, { clusterId: null })
        const rows = await h.runtimes.listByUser(h.userId)
        assert.equal(
            rows.find((row) => row.clusterId === other.id)?.status,
            'ready'
        )
        assert.equal(
            rows.find((row) => row.clusterId === h.clusterId)?.currentPhase,
            'create_cleanup_pending'
        )
        await check(createObjectId('user'), h.clusterId)
        h.api.failDelete = null
        await h.remove(pending.id)
        assert.deepEqual(h.api.runtimeResources(), [])
        assert(other.api.runtimeResources().length > 0)
    }
)

test(
    'Kubernetes response bodies and credentials never enter recovery responses or warnings',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const warnings: unknown[] = []
        t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => {
            warnings.push(args)
        })
        const h = await fixture(t)
        h.api.failCreate = 'deployments'
        h.api.failDelete = 'persistentvolumeclaims'
        h.api.errorBody = {
            arbitrary: 'sensitive-fixture-body',
            token: 'sensitive-fixture-token'
        }
        let first: unknown
        await assert.rejects(h.create(), (error: any) => {
            first = error.getResponse?.()
            return first !== undefined
        })
        const [runtime] = await h.runtimes.listByUser(h.userId)
        let second: unknown
        await assert.rejects(h.remove(runtime.id), (error: any) => {
            second = error.getResponse?.()
            return second !== undefined
        })
        const serialized = JSON.stringify({
            first,
            second,
            warnings,
            failureReason: runtime.failureReason
        })
        assert(!serialized.includes('sensitive-fixture'))
        assert(serialized.includes('Kubernetes API HTTP 503'))
    }
)

const creationChat = (db: Database) => {
    const repo = new ChatRepository(db)
    const chat = Object.assign(Object.create(ChatService.prototype), {
        db,
        repo,
        telemetry: { event() {} },
        adapters: { get: () => ({}) },
        resolveTurnConfig: async () => ({}),
        markRuntimeActive: async () => {},
        markAgentMessaged: async () => {},
        beginPendingTurn() {},
        endPendingTurn() {},
        startAssistantTurn: async () => {}
    }) as ChatService
    return { chat, repo }
}

test(
    'postinsert setup cannot accept Chat data before the fresh agent is published',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const gate = barrier()
        t.after(() => gate.release())
        const h = await fixture(t)
        h.behavior.failAttach = false
        h.behavior.failDefaults = true
        h.behavior.beforeDefaults = async () => {
            gate.enter()
            await gate.released
        }
        const failed = assert.rejects(
            h.create(),
            (error) => error === h.failure
        )
        await bounded(gate.entered)
        const [agent] = await h.db
            .select()
            .from(agents)
            .where(eq(agents.userId, h.userId))
        const { chat, repo } = creationChat(h.db)
        const sessionId = createObjectId('chatSession')
        await h.db.insert(chatSessions).values({
            id: sessionId,
            userId: h.userId,
            agentId: agent.id,
            title: 'fixture'
        })
        try {
            assert.equal(agent.status, 'pending')
            // A report or another status writer cannot bypass the runtime fence.
            await h.db
                .update(agents)
                .set({ status: 'running' })
                .where(eq(agents.id, agent.id))
            const sent = await chat
                .sendMessage(
                    h.userId,
                    agent.id,
                    sessionId,
                    'owned fixture message'
                )
                .then(
                    (value) => ({ value, error: undefined as any }),
                    (error: any) => ({ value: undefined, error })
                )
            const stored = await repo.listMessages(sessionId)
            t.diagnostic(
                JSON.stringify({
                    accepted: !!sent.value,
                    storedMessages: stored.length
                })
            )
            assert.equal(sent.error?.getResponse?.().code, 'AGENT_NOT_READY')
            assert.equal(stored.length, 0)
            await assert.rejects(
                chat.createSession(h.userId, agent.id, 'should not persist'),
                (error: any) => error.getResponse?.().code === 'AGENT_NOT_READY'
            )
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(chatSessions)
                        .where(eq(chatSessions.agentId, agent.id))
                ).length,
                1
            )
        } finally {
            gate.release()
            await bounded(failed)
        }
    }
)

test(
    'published K8s agent admits real Chat session and message writes',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.behavior.failAttach = false
        const summary = (await h.create()) as { id: string; status: string }
        assert.equal(summary.status, 'running')
        const { chat, repo } = creationChat(h.db)
        const session = await chat.createSession(
            h.userId,
            summary.id,
            'ready fixture'
        )
        const sent = await chat.sendMessage(
            h.userId,
            summary.id,
            session.id,
            'owned ready message'
        )
        assert(sent.userMessage.id)
        assert.equal((await repo.listMessages(session.id)).length, 1)
    }
)

test(
    'cleanup-pending parent rejects Chat even if the agent appears running',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.behavior.failAttach = false
        h.behavior.failDefaults = true
        h.api.failDelete = 'persistentvolumeclaims'
        await assert.rejects(
            h.create(),
            (error: any) =>
                error.getResponse?.().code === 'RUNTIME_CREATE_CLEANUP_PENDING'
        )
        const [agent] = await h.db
            .select()
            .from(agents)
            .where(eq(agents.userId, h.userId))
        await h.db
            .update(agents)
            .set({ status: 'running' })
            .where(eq(agents.id, agent.id))
        const { chat } = creationChat(h.db)
        await assert.rejects(
            chat.createSession(h.userId, agent.id),
            (error: any) => error.getResponse?.().code === 'AGENT_NOT_READY'
        )
        assert.equal(
            (
                await h.db
                    .select()
                    .from(chatSessions)
                    .where(eq(chatSessions.agentId, agent.id))
            ).length,
            0
        )
    }
)

for (const kind of ['daemon', 'sprites'] as const)
    test(
        `${kind} Chat admission is unchanged by the K8s create fence`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const h = await fixture(t)
            const runtimeId = createObjectId('agentRuntime')
            const agentId = createObjectId('agent')
            await h.db.insert(agentRuntimes).values({
                id: runtimeId,
                userId: h.userId,
                name: 'other runtime',
                framework: 'codex',
                kind,
                status: 'pending'
            })
            await h.db.insert(agents).values({
                id: agentId,
                userId: h.userId,
                runtimeId,
                name: 'existing agent',
                internalId: 'existing-fixture',
                framework: 'codex',
                runtime: kind,
                status: 'running'
            })
            const { chat, repo } = creationChat(h.db)
            const session = await chat.createSession(
                h.userId,
                agentId,
                'other runtime'
            )
            await chat.sendMessage(
                h.userId,
                agentId,
                session.id,
                'owned fixture message'
            )
            assert.equal((await repo.listMessages(session.id)).length, 1)
        }
    )

test(
    'agent publication failure rolls back the runtime ready transition before cleanup',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.behavior.failAttach = false
        await h.client.unsafe(
            `create function fixture_k8s_publish_fail() returns trigger language plpgsql as $$ begin raise exception 'fixture publish failure'; end; $$`
        )
        await h.client.unsafe(
            `create trigger fixture_k8s_publish_fail before update on agents for each row when (old.status = 'pending' and new.status = 'running') execute function fixture_k8s_publish_fail()`
        )
        try {
            await assert.rejects(h.create(), /fixture publish failure/)
            assert.deepEqual(await h.runtimes.listByUser(h.userId), [])
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(agents)
                        .where(eq(agents.userId, h.userId))
                ).length,
                0
            )
            assert.deepEqual(h.api.runtimeResources(), [])
        } finally {
            await h.client.unsafe(
                'drop trigger fixture_k8s_publish_fail on agents'
            )
            await h.client.unsafe('drop function fixture_k8s_publish_fail()')
        }
    }
)

for (const provisionStage of ['secrets', 'deployments'] as const)
    test(
        `fresh ownership fences reconcile during ${provisionStage} creation before readiness`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const gate = barrier()
            t.after(() => gate.release())
            const h = await fixture(t)
            h.hooks.afterCreate = async (collection) => {
                if (collection === provisionStage) {
                    gate.enter()
                    await gate.released
                }
            }
            const failed = assert.rejects(
                h.create(),
                (error) => error === h.failure
            )
            await bounded(gate.entered)
            const [runtime] = await h.runtimes.listByUser(h.userId)
            assert.equal(runtime.currentPhase, 'creating_initial_agent')
            assert.equal(runtime.status, 'pending')
            let listed = false
            const reconcile = new AgentReconcileService(h.db, {
                get: () => ({
                    listAgents: async () => {
                        listed = true
                        return []
                    }
                })
            } as never)
            await reconcile.reconcileRuntime({
                ...runtime,
                currentPhase: null,
                status: 'ready'
            })
            assert.equal(listed, false)
            await assert.rejects(
                h.attach.attach({
                    runtime: {
                        ...runtime,
                        currentPhase: null,
                        status: 'ready'
                    },
                    name: 'foreign'
                }),
                /container is not ready/
            )
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(agents)
                        .where(eq(agents.runtimeId, runtime.id))
                ).length,
                0
            )
            gate.release()
            await bounded(failed)
            assert.deepEqual(h.api.runtimeResources(), [])
        }
    )

test(
    'coding reconcile retains its single-write fence when a stale ready snapshot sees a fresh create',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const gate = barrier()
        t.after(() => gate.release())
        const h = await fixture(t)
        h.behavior.failAttach = false
        h.behavior.failDefaults = true
        h.behavior.beforeDefaults = async () => {
            gate.enter()
            await gate.released
        }
        const failed = assert.rejects(
            h.create(),
            (error) => error === h.failure
        )
        await bounded(gate.entered)
        const [runtime] = await h.runtimes.listByUser(h.userId)
        const [agent] = await h.db
            .select()
            .from(agents)
            .where(eq(agents.runtimeId, runtime.id))
        await h.db
            .update(agents)
            .set({ status: 'stopped' })
            .where(eq(agents.id, agent.id))
        const reconcile = new AgentReconcileService(h.db, {
            get: () => {
                throw new Error('coding reconcile must not list the adapter')
            }
        } as never)
        await reconcile.reconcileRuntime({
            ...runtime,
            status: 'ready',
            currentPhase: null
        })
        assert.equal(
            (await h.db.select().from(agents).where(eq(agents.id, agent.id)))[0]
                .status,
            'stopped'
        )
        gate.release()
        await bounded(failed)
    }
)

test(
    'cleanup deadline aborts an actual pending Kubernetes HTTP request and keeps ownership',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const gate = barrier()
        t.after(() => gate.release())
        const h = await fixture(t)
        const deadline = new AbortController()
        const realTimeout = AbortSignal.timeout.bind(AbortSignal)
        const budgets: number[] = []
        h.behavior.beforeAttach = async () => {
            t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
                if (milliseconds !== 30_000) return realTimeout(milliseconds)
                budgets.push(milliseconds)
                return deadline.signal
            })
        }
        h.api.beforeDelete = async (collection) => {
            if (collection === 'deployments') {
                gate.enter()
                await gate.released
            }
        }
        const failure = assert.rejects(
            h.create(),
            (error: any) =>
                error.getResponse?.().code === 'RUNTIME_CREATE_CLEANUP_PENDING'
        )
        await bounded(gate.entered)
        deadline.abort(
            new DOMException('fixture cleanup deadline', 'TimeoutError')
        )
        await bounded(failure)
        await bounded(
            (async () => {
                while (!h.api.abortedResponses)
                    await new Promise((resolve) => setTimeout(resolve, 5))
            })()
        )
        assert.deepEqual(budgets, [30_000])
        assert.equal(
            (await h.runtimes.listByUser(h.userId))[0].currentPhase,
            'create_cleanup_pending'
        )
        gate.release()
    }
)
