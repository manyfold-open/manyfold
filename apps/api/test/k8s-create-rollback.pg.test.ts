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
import { eq, and, inArray, sql } from 'drizzle-orm'
import {
    schema,
    users,
    runtimeProviders,
    agentRuntimes,
    agents,
    daemonTokens,
    hostDaemons,
    runtimeHosts,
    chatSessions,
    serviceLeases,
    type Database,
    type AgentRuntimeRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import type { ConfigService } from '@nestjs/config'
import {
    ForbiddenException,
    GatewayTimeoutException,
    Logger,
    NotFoundException,
    UnauthorizedException
} from '@nestjs/common'
import { CryptoService } from '../src/modules/secrets/crypto.service'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import { DaemonTokenService } from '../src/modules/daemon/daemon-token.service'
import { KubernetesService } from '../src/modules/k8s/kubernetes.service'
import { PodExecFactory } from '../src/modules/k8s/pod-exec'
import { GatewayExecClient } from '../src/modules/k8s/gateway-exec.client'
import { HostsService } from '../src/modules/hosts/hosts.service'
import { HostDaemonsService } from '../src/modules/hosts/host-daemons.service'
import { RuntimeContextService } from '../src/modules/hosts/runtime-context.service'
import { RuntimeProvidersService } from '../src/modules/hosts/runtime-providers.service'
import { SandboxProviderRegistry } from '../src/modules/hosts/providers/sandbox-provider'
import { HostProviderClients } from '../src/modules/hosts/providers/host-provider-clients.service'
import { HostPlacementService } from '../src/modules/hosts/providers/host-placement.service'
import { K8sProvider } from '../src/modules/hosts/providers/k8s.provider'
import { K8sContainerProvisioner } from '../src/modules/agent-runtimes/provisioning/k8s-container-provisioner'
import { K8sCreateCleanupService } from '../src/modules/agent-runtimes/provisioning/k8s-create-cleanup.service'
import { k8sCreateLeaseName } from '../src/modules/agent-runtimes/provisioning/k8s-create-ownership'
import { K8sProvisioner } from '../src/modules/agent-runtimes/provisioning/k8s-provisioner'
import { PodRunnerProvisioner } from '../src/modules/agent-runtimes/provisioning/pod-runner-provisioner'
import { podHostResourceName } from '../src/modules/agent-runtimes/provisioning/pod-host-resources'
import { RunnerManagerService } from '../src/modules/chat/runner/runner-manager.service'
import { HostDaemonAccess } from '../src/modules/agents/adapters/host-daemon-access'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'
import { ChatService } from '../src/modules/chat/chat.service'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { RuntimeAgentsController } from '../src/modules/agents/runtime-agents.controller'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { openCloudComputerPort } from '../src/common/ports/cloud-computer.ports'
import { K8sLifecycleFixture } from './helpers/k8s-lifecycle-fixture'
import { CLI_AT_FLOOR } from './helpers/cli-floor'

// A self-serve k8s create (ADR-0035, ADR-0037): a hosted host on a k8s runtime
// provider, made by the k8s adapter, whose pod registers the host's daemon
// with the token minted bound to it; the framework is installed through that
// daemon and the fresh agent published last. Every failure between those
// steps has to leave nothing behind — no rows, no remote objects, no
// credential — or a visible recovery row that an explicit DELETE finishes.
//
// Real Postgres and a real HTTP fixture for the Kubernetes API, because the
// invariants are lock order, FK fences and which remote requests happen.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test --
const RUN = process.env.RUN_PG_E2E === '1'

const fixture = async (t: TestContext) => {
    const framework = 'codex'
    assert(process.env.DATABASE_URL)
    const client = postgres(process.env.DATABASE_URL, { max: 4 })
    const db: Database = drizzle(client, { schema })
    const api = new K8sLifecycleFixture()
    await api.start()
    const userId = createObjectId('user')
    const providerId = createObjectId('runtimeProvider')
    const providerIds = [providerId]
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
            // Runtimes RESTRICT their host, and hosts RESTRICT their provider.
            await db
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.userId, userId))
            await db
                .delete(runtimeHosts)
                .where(eq(runtimeHosts.userId, userId))
            await db.delete(users).where(eq(users.id, userId))
            await db
                .delete(runtimeProviders)
                .where(inArray(runtimeProviders.id, providerIds))
        } finally {
            await client.end({ timeout: 5 })
        }
    })
    const configValues: Record<string, string> = {
        API_CRYPTO_KEY: randomBytes(32).toString('base64'),
        K8S_CONTAINER_PROVISION_TIMEOUT_MS: '2000',
        K8S_RUNTIME_IMAGE: 'fixture-only',
        PUBLIC_API_BASE_URL: 'https://api.fixture.invalid'
    }
    const config = { get: (key: string) => configValues[key] } as ConfigService
    const crypto = new CryptoService(config)
    const kubeconfig = crypto.encrypt(api.kubeconfig())
    await db
        .insert(users)
        .values({ id: userId, email: `${userId}@fixture.invalid` })
    await db.insert(runtimeProviders).values({
        id: providerId,
        kind: 'k8s',
        name: `fixture-${providerId}`,
        lastHealthStatus: 'ok',
        credentialCiphertext: kubeconfig.ciphertext,
        credentialKeyVersion: kubeconfig.keyVersion,
        config: { hostSuffix: 'fixture.invalid' }
    })
    const k8s = new KubernetesService(config, db, crypto)
    const hosts = new HostsService(db)
    const hostDaemonsService = new HostDaemonsService(db)
    const runtimeContext = new RuntimeContextService(db)
    const podExec = new PodExecFactory(new GatewayExecClient(config))
    const clients = new HostProviderClients(
        new RuntimeProvidersService(db),
        hosts,
        crypto,
        k8s,
        podExec
    )
    const providers = new SandboxProviderRegistry()
    new K8sProvider(providers, hosts, config, k8s, podExec, clients)
    const cleanup = new K8sCreateCleanupService(db, hosts, clients, providers)
    const runtimes = new AgentRuntimesService(db, { event() {} } as never)
    const tokens = new DaemonTokenService(db)
    const podRunner = new PodRunnerProvisioner(tokens, config)
    // Everything inside the pod goes through its daemon: the fixture's daemon
    // answers every exec as a host that already runs the requested version.
    const daemonRegistry = {
        isOnline: () => true,
        rpc: async () => ({}),
        streamRpc: (args: {
            onEvent?: (kind: string, data: string) => void
        }) => {
            args.onEvent?.('stdout', '1.0.0\n')
            return {
                refId: randomUUID(),
                result: Promise.resolve({ exitCode: 0 }),
                cancel() {}
            }
        }
    }
    const runnerManager = new RunnerManagerService(
        hosts,
        hostDaemonsService,
        providers,
        clients,
        tokens,
        daemonRegistry as never,
        { hold: () => ({ settled: Promise.resolve(true), release: async () => {}, detach: () => {} }) } as never
    )
    const failure = new Error('owned fixture attach timeout')
    const behavior: {
        failAttach: boolean
        failConfig: boolean
        failDefaults: boolean
        // The host's daemon registering the moment its pod runs; the
        // provisioner waits for it before installing anything.
        registerDaemon: boolean
        beforeAttach?: (runtime: AgentRuntimeRow) => Promise<void>
        afterDaemon?: (host: RuntimeHostRow) => Promise<void>
        beforeDefaults?: () => Promise<void>
    } = {
        failAttach: true,
        failConfig: false,
        failDefaults: false,
        registerDaemon: true
    }
    const registered = new Set<string>()
    // What the pod's boot loop does with the bound token in its Secret: the
    // host's one daemon row, online.
    const registerDaemon = async (host: RuntimeHostRow): Promise<void> => {
        const [token] = await db
            .select({ id: daemonTokens.id })
            .from(daemonTokens)
            .where(eq(daemonTokens.hostId, host.id))
        const now = new Date()
        await hostDaemonsService.upsert(host.id, {
            userId,
            daemonUuid: randomUUID(),
            tokenId: token?.id ?? null,
            cliVersion: CLI_AT_FLOOR,
            startupMethod: 'container',
            clientFeatures: [],
            detectedFrameworks: [],
            lastSeenAt: now,
            rpcInstanceId: 'fixture-api',
            rpcInbox: 'fixture-inbox',
            rpcConnectedAt: now,
            rpcLastSeenAt: now
        })
    }
    const hostByResourceName = async (
        name: string
    ): Promise<RuntimeHostRow | undefined> =>
        (
            await db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.userId, userId))
        ).find((host) => podHostResourceName(host.id) === name)
    const hooks: {
        afterCreate?: (collection: string, name: string) => Promise<void>
    } = {}
    api.afterCreate = async (collection, name) => {
        await hooks.afterCreate?.(collection, name)
        if (collection !== 'deployments' || !behavior.registerDaemon) return
        const host = await hostByResourceName(name)
        if (!host || registered.has(host.id)) return
        registered.add(host.id)
        await registerDaemon(host)
        await behavior.afterDaemon?.(host)
    }
    const frameworkVersions = {
        resolveInstallVersion: async () => ({
            selection: { version: '1.0.0', source: 'latest' },
            repo: null,
            artifacts: null
        })
    }
    // Coding frameworks only: nothing here runs as a host service.
    const podServices = {} as never
    const k8sProvisioner = new K8sProvisioner(
        db,
        hosts,
        clients,
        providers,
        tokens,
        runtimes,
        cleanup,
        podServices
    )
    const provisioner = new K8sContainerProvisioner(
        db,
        hosts,
        hostDaemonsService,
        clients,
        new HostPlacementService(db),
        providers,
        new HostDaemonAccess(
            hostDaemonsService,
            daemonRegistry as never,
            undefined,
            runnerManager
        ),
        config,
        crypto,
        podRunner,
        cleanup,
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
        } as never,
        runtimeContext
    )
    const orchestrator = Object.assign(
        Object.create(AgentOrchestratorService.prototype),
        {
            db,
            runtimes,
            attach,
            runtimeContext,
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
                    providerId,
                    ...(runtimeId ? { runtimeId } : {}),
                    ...(behavior.failConfig
                        ? { modelConfigSource: 'runtime-local' }
                        : {}),
                    ...overrides
                }
            },
            { step() {} }
        )
    // What the runtime DELETE route ends in: the provisioner's teardown, which
    // finishes a pending create cleanup or refuses while its owner is alive.
    const remove = async (runtimeId: string): Promise<void> => {
        const runtime = await runtimes.findById(runtimeId)
        if (!runtime)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        await k8sProvisioner.teardownRuntime(runtime)
    }
    const provision = () =>
        provisioner.provision({
            userId,
            name: 'existing fixture',
            credentials: {},
            providerId,
            framework: 'codex',
            sku: {
                id: null,
                region: null,
                cpuMillicores: 1000,
                memoryMb: 2048,
                diskGb: 10
            }
        })
    const hostOf = async (runtime: AgentRuntimeRow): Promise<RuntimeHostRow> => {
        const host = runtime.hostId ? await hosts.findById(runtime.hostId) : null
        assert(host, `runtime ${runtime.id} has no host`)
        return host
    }
    const userRows = async () => ({
        runtimes: await db
            .select({ id: agentRuntimes.id })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.userId, userId)),
        hosts: await db
            .select({ id: runtimeHosts.id })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.userId, userId)),
        daemons: await db
            .select({ hostId: hostDaemons.hostId })
            .from(hostDaemons)
            .where(eq(hostDaemons.userId, userId)),
        tokens: await db
            .select({ id: daemonTokens.id })
            .from(daemonTokens)
            .where(eq(daemonTokens.userId, userId))
    })
    const addProvider = async () => {
        const nextApi = new K8sLifecycleFixture()
        await nextApi.start()
        nextApi.afterCreate = api.afterCreate
        apis.push(nextApi)
        const id = createObjectId('runtimeProvider')
        providerIds.push(id)
        const encrypted = crypto.encrypt(nextApi.kubeconfig())
        await db.insert(runtimeProviders).values({
            id,
            kind: 'k8s',
            name: `fixture-${id}`,
            lastHealthStatus: 'ok',
            credentialCiphertext: encrypted.ciphertext,
            credentialKeyVersion: encrypted.keyVersion,
            config: { hostSuffix: 'fixture.invalid' }
        })
        return { id, api: nextApi }
    }
    return {
        db,
        client,
        api,
        hooks,
        userId,
        providerId,
        config,
        create,
        failure,
        behavior,
        provisioner,
        k8sProvisioner,
        runtimes,
        attach,
        hosts,
        hostDaemons: hostDaemonsService,
        tokens,
        runtimeContext,
        k8s,
        cleanup,
        remove,
        provision,
        hostOf,
        userRows,
        credentials,
        addProvider
    }
}

test(
    'failed self-serve creates leave no runtime, host, credential or remote resources across retries',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        for (let attempt = 0; attempt < 2; attempt++)
            await assert.rejects(h.create(), (error) => error === h.failure)
        assert.deepEqual(await h.userRows(), {
            runtimes: [],
            hosts: [],
            daemons: [],
            tokens: []
        })
        assert.deepEqual(h.api.runtimeResources(), [])
    }
)

test(
    'an attach failure on an existing runtime does not destroy its resources',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        const { runtime } = await h.provision()
        const resourcesBefore = h.api.runtimeResources()
        await assert.rejects(
            h.create(runtime.id),
            (error) => error === h.failure
        )
        assert.equal((await h.runtimes.findById(runtime.id))?.status, 'ready')
        assert.equal((await h.hostOf(runtime)).status, 'ready')
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
                'installing'
            )
        }
        const summary = (await h.create()) as { id: string; runtimeId: string }
        const [row] = await h.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.userId, h.userId))
        assert.equal(row.status, 'ready')
        assert.equal((await h.hostOf(row)).status, 'ready')
        assert.deepEqual(
            await h.db
                .select()
                .from(serviceLeases)
                .where(eq(serviceLeases.name, k8sCreateLeaseName(row.id))),
            []
        )
        assert.equal(row.currentPhase, null)
        assert.equal(row.primaryAgentId, summary.id)
        const [agent] = await h.db
            .select()
            .from(agents)
            .where(eq(agents.id, summary.id))
        assert.equal(agent.status, 'ready')
        assert(h.api.runtimeResources().length > 0)
    }
)

for (const phase of ['failConfig', 'failDefaults'] as const)
    test(
        `a ${phase} after agent insertion rolls back the fresh runtime and its host`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const h = await fixture(t)
            h.behavior.failAttach = false
            h.behavior[phase] = true
            await assert.rejects(h.create(), (error) => error === h.failure)
            assert.deepEqual(await h.userRows(), {
                runtimes: [],
                hosts: [],
                daemons: [],
                tokens: []
            })
            assert.deepEqual(
                await h.db
                    .select()
                    .from(agents)
                    .where(eq(agents.userId, h.userId)),
                []
            )
            assert.deepEqual(h.api.runtimeResources(), [])
        }
    )

test(
    'provision failure cleans partial resources and the bound credential',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const h = await fixture(t)
        h.api.failCreate = 'deployments'
        await assert.rejects(h.create(), /container provisioning failed/)
        assert.deepEqual(await h.userRows(), {
            runtimes: [],
            hosts: [],
            daemons: [],
            tokens: []
        })
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
            const [runtime] = await h.runtimes.listByUser(h.userId)
            assert.equal(runtime.status, 'failed')
            assert.equal(runtime.currentPhase, 'create_cleanup_pending')
            assert.match(runtime.failureReason ?? '', /cleanup/)
            // The host stays as the retry record, with its bound credential.
            assert.equal((await h.userRows()).hosts.length, 1)
            assert.equal((await h.userRows()).tokens.length, 1)
            assert(
                h.api
                    .runtimeResources()
                    .some(
                        (resource) => resource.kind === 'PersistentVolumeClaim'
                    )
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
            assert.equal((await h.runtimes.listByUser(h.userId)).length, 1)
            h.api.failDelete = null
            await h.remove(runtime.id)
            assert.deepEqual(await h.runtimes.listByUser(h.userId), [])
            assert.deepEqual(await h.userRows(), {
                runtimes: [],
                hosts: [],
                daemons: [],
                tokens: []
            })
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
    return { enter, entered, release, released }
}

const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('owned fixture barrier timed out')),
                    15_000
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
        const { runtime } = await h.provision()
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
        // The owner's fence stamps every create with its deadline, and a
        // lost owner makes no further one.
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

test(
    'DELETE cannot remove ownership while a Kubernetes create request is in flight',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        const gate = barrier()
        const h = await fixture(t)
        h.api.beforeCreate = async (creating) => {
            if (creating !== 'secrets') return
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
            deletionError = await h.remove(runtime.id).then(
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
    'a registration racing the cleanup of its host waits for it and is refused; nothing is left behind',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        // The pod's daemon registers just as the create gives up waiting for
        // it. Cleanup holds the host row; the registration (bound token →
        // that host) queues behind it and, once the host is gone, is refused
        // rather than resurrecting a daemon row for a deleted machine.
        const h = await fixture(t)
        h.behavior.registerDaemon = false
        const daemonHosts = new DaemonHostService(
            h.db,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            h.config,
            h.hosts,
            h.hostDaemons,
            h.tokens
        )
        let registering: Promise<unknown> | undefined
        let deletesBeforeRegistrationQueued = -1
        h.api.beforeDelete = async (collection) => {
            if (collection !== 'deployments' || registering) return
            const [host] = await h.db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.userId, h.userId))
            const [token] = await h.db
                .select()
                .from(daemonTokens)
                .where(eq(daemonTokens.hostId, host.id))
            registering = daemonHosts.upsertOnRegister({
                tokenId: token.id,
                lastIp: null,
                request: {
                    daemonUuid: randomUUID(),
                    name: 'whatever the pod says',
                    hostname: null,
                    os: 'linux',
                    arch: 'x64',
                    cliVersion: CLI_AT_FLOOR,
                    homeDir: '/home/node',
                    workspaceBaseDir: '/home/node/.manyfold/workspaces',
                    detectedFrameworks: []
                }
            })
            void registering.catch(() => undefined)
            // Until the registration is queued behind the cleanup's host lock.
            await bounded(
                (async () => {
                    while (true) {
                        const [blocked] =
                            await h.client`select pid from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%"runtime_hosts"%for update%'`
                        if (blocked) return
                        await new Promise((resolve) => setTimeout(resolve, 10))
                    }
                })()
            )
            deletesBeforeRegistrationQueued = h.api.requests.filter(
                (request) => request.method === 'DELETE'
            ).length
        }
        await assert.rejects(
            h.create(),
            (error) => error instanceof GatewayTimeoutException
        )
        assert(registering, 'the cleanup reached the deployment delete')
        const registration = await bounded(
            registering.then(
                () => null,
                (error: unknown) => error
            )
        )
        // Refused either way: the host is gone by the time the registration
        // gets its lock, and with it the token (403 if the host row went
        // first, 401 once its tokens cascaded).
        const witness = {
            registration:
                registration instanceof ForbiddenException ||
                registration instanceof UnauthorizedException
                    ? 'refused'
                    : String(registration),
            deletesBeforeRegistrationQueued,
            ...Object.fromEntries(
                Object.entries(await h.userRows()).map(([key, rows]) => [
                    key,
                    rows.length
                ])
            ),
            resources: h.api.runtimeResources().length
        }
        t.diagnostic(JSON.stringify(witness))
        // The one DELETE counted is the deployment's own, the request the
        // hook is answering: nothing else had gone before the registration
        // was queued behind the host lock.
        assert.deepEqual(witness, {
            registration: 'refused',
            deletesBeforeRegistrationQueued: 1,
            runtimes: 0,
            hosts: 0,
            daemons: 0,
            tokens: 0,
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
        const reconcile = new AgentReconcileService(
            h.db,
            {
                get: () => ({
                    listAgents: async () => {
                        listed = true
                        return []
                    }
                })
            } as never,
            h.runtimeContext
        )
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
                status: 'ready'
            })
        }
        await assert.rejects(h.create(), (error: any) =>
            /another agent attached/.test(error.getResponse?.().cleanupError)
        )
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

for (const target of ['parent', 'pod host'] as const)
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
            const [runtime] = await h.runtimes.listByUser(h.userId)
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
                          hostId: runtime.hostId
                      })
                    : writerDb.insert(agents).values({
                          id: createObjectId('agent'),
                          userId: h.userId,
                          runtimeId: runtime.id,
                          name: 'racing fixture',
                          internalId: 'racing-fixture',
                          framework: 'codex'
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
    'a framework added to the fresh host meanwhile keeps the host through the failed create',
    { skip: !RUN, timeout: 30_000 },
    async (t) => {
        // Another (host, framework) slot with an agent of its own means the
        // machine is in use: the failed create takes only its own runtime.
        const h = await fixture(t)
        const foreignId = createObjectId('agent')
        const siblingId = createObjectId('agentRuntime')
        h.behavior.afterDaemon = async (host) => {
            await h.db.insert(agentRuntimes).values({
                id: siblingId,
                userId: h.userId,
                name: 'sibling framework',
                framework: 'claude-code',
                hostId: host.id,
                status: 'ready'
            })
            await h.db.insert(agents).values({
                id: foreignId,
                userId: h.userId,
                runtimeId: siblingId,
                name: 'foreign sibling fixture',
                internalId: 'foreign-sibling',
                framework: 'claude-code',
                status: 'ready'
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
        const [parent] = (await h.runtimes.listByUser(h.userId)).filter(
            (row) => row.id !== siblingId
        )
        assert.equal(parent.currentPhase, 'create_cleanup_pending')
        await h.remove(parent.id)
        assert.equal(await h.runtimes.findById(parent.id), null)
        assert.equal(
            (await h.runtimes.findById(siblingId))?.status,
            'ready',
            'the sibling keeps the host'
        )
        assert.equal(
            (await h.db.select().from(agents).where(eq(agents.id, foreignId)))
                .length,
            1
        )
        assert.equal((await h.userRows()).hosts.length, 1)
        assert(h.api.runtimeResources().length > 0)
    }
)

test(
    'agents can be added to a published runtime and to a self-owned computer alike',
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
            h.runtimeContext,
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
            kind: 'local',
            status: 'ready'
        })
        await h.db.insert(agentRuntimes).values({
            id: runtimeId,
            userId: h.userId,
            name: 'standalone',
            framework: 'codex',
            status: 'ready',
            hostId
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
    'cleanup guard uses the one selected provider and leaves other providers available',
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
        const other = await h.addProvider()
        await h.db
            .update(runtimeProviders)
            .set({ priority: 10 })
            .where(eq(runtimeProviders.id, h.providerId))
        const check = h.cleanup.assertProviderAvailable.bind(h.cleanup)
        let selected: string | undefined
        h.cleanup.assertProviderAvailable = async (userId, providerId) => {
            selected = providerId
            await h.db
                .update(runtimeProviders)
                .set({ priority: 20 })
                .where(eq(runtimeProviders.id, other.id))
            await check(userId, providerId)
        }
        await assert.rejects(
            h.create(undefined, { providerId: null }),
            (error: any) => error.getResponse?.().runtimeId === pending.id
        )
        assert.equal(selected, h.providerId)
        assert.equal(other.api.requests.length, 0)
        h.cleanup.assertProviderAvailable = check
        h.behavior.failAttach = false
        await h.create(undefined, { providerId: null })
        const rows = await h.runtimes.listByUser(h.userId)
        const providerOf = async (row: AgentRuntimeRow) =>
            (await h.hostOf(row)).providerId
        const byProvider = new Map<string | null, AgentRuntimeRow>()
        for (const row of rows) byProvider.set(await providerOf(row), row)
        assert.equal(byProvider.get(other.id)?.status, 'ready')
        assert.equal(
            byProvider.get(h.providerId)?.currentPhase,
            'create_cleanup_pending'
        )
        await check(createObjectId('user'), h.providerId)
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

const creationChat = (db: Database, runtimeContext: RuntimeContextService) => {
    const repo = new ChatRepository(db)
    const chat = Object.assign(Object.create(ChatService.prototype), {
        db,
        repo,
        runtimeContext,
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
        const { chat, repo } = creationChat(h.db, h.runtimeContext)
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
                .set({ status: 'ready' })
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
        assert.equal(summary.status, 'ready')
        const { chat, repo } = creationChat(h.db, h.runtimeContext)
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
    'cleanup-pending parent rejects Chat even if the agent appears ready',
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
            .set({ status: 'ready' })
            .where(eq(agents.id, agent.id))
        const { chat } = creationChat(h.db, h.runtimeContext)
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
            `create trigger fixture_k8s_publish_fail before update on agents for each row when (old.status = 'pending' and new.status = 'ready') execute function fixture_k8s_publish_fail()`
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
            assert.equal(runtime.status, 'installing')
            let listed = false
            const reconcile = new AgentReconcileService(
                h.db,
                {
                    get: () => ({
                        listAgents: async () => {
                            listed = true
                            return []
                        }
                    })
                } as never,
                h.runtimeContext
            )
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

// The fence the old managed-runner model needed between a pod host and the
// separate host row its daemon registered as no longer has a subject: the
// pod's daemon IS the host's, and its bound token cascades with the host.
test('a pod host and its daemon share one row set', { skip: !RUN }, async (t) => {
    const h = await fixture(t)
    const { runtime } = await h.provision()
    const host = await h.hostOf(runtime)
    assert.equal(host.kind, 'hosted')
    assert.equal(host.providerId, h.providerId)
    const [daemon] = await h.db
        .select()
        .from(hostDaemons)
        .where(eq(hostDaemons.hostId, host.id))
    const [token] = await h.db
        .select()
        .from(daemonTokens)
        .where(and(eq(daemonTokens.userId, h.userId), eq(daemonTokens.hostId, host.id)))
    assert.equal(daemon.tokenId, token.id)
    await h.k8sProvisioner.teardownRuntime(runtime)
    await h.k8sProvisioner.teardownHost(host)
    assert.deepEqual(await h.userRows(), {
        runtimes: [],
        hosts: [],
        daemons: [],
        tokens: []
    })
    assert.deepEqual(h.api.runtimeResources(), [])
})
