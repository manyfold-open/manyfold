import type { ProvisionableContainerSku } from '@/common/ports/cloud-computer.ports'
import {
    createObjectId,
    K8S_HOME_BASE,
    type AgentFramework,
    type AgentModelConfigSource,
    type FrameworkVersionSelection
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    GatewayTimeoutException,
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, sql } from 'drizzle-orm'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    hostDaemons,
    serviceLeases,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow,
    type RuntimeProvider
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { PodRunnerProvisioner } from './pod-runner-provisioner'
import { K8sProvisioner } from './k8s-provisioner'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import type { FrameworkReleaseArtifacts } from '@/modules/framework-versions/framework-version-registry'
import { HostsService } from '@/modules/hosts/hosts.service'
import {
    HostDaemonsService,
    hasRpcLease
} from '@/modules/hosts/host-daemons.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { HostPlacementService } from '@/modules/hosts/providers/host-placement.service'
import {
    SandboxProviderRegistry,
    type ProviderCall
} from '@/modules/hosts/providers/sandbox-provider'
import { recordPower } from '@/modules/hosts/providers/generation'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import {
    isCodingHostFramework,
    sessionScriptRunner,
    setUpHostFramework
} from '@/modules/agents/bootstrap/host-framework-setup'
import { serviceFrameworkRecipe } from '@/modules/agents/bootstrap/service-frameworks'
import { HostServices } from './host-services'
import {
    describeK8sCreateError,
    K8S_CREATE_INITIAL_AGENT,
    K8sCreateCleanupService
} from './k8s-create-cleanup.service'
import {
    insertK8sCreateLease,
    K8sCreateOwnership,
    k8sCreateLeaseName
} from './k8s-create-ownership'

const DEFAULT_READINESS_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000
// Parent of every agent workspace on a pod host, and the directory the host's
// daemon declared as its workspace root when it registered.
export const POD_HOST_WORKSPACE_BASE = `${K8S_HOME_BASE}/.manyfold/workspaces`
const INSTALLING_FRAMEWORK = 'installing_framework'

export interface PodHostResources {
    cpuMillicores: number
    memoryMb: number
    diskGb: number
}

export interface ProvisionContainerInput {
    userId: string
    sku: ProvisionableContainerSku
    // The host's first framework runtime.
    framework: AgentFramework
    // The framework runtime's name; the host gets `hostName`, else the next
    // computer-NNN.
    name: string
    hostName?: string | null
    credentials: unknown
    // 'runtime-local' keeps provider keys out of the platform's hands: no
    // config pinned to a platform provider and no key-based login.
    modelConfigSource?: AgentModelConfigSource | null
    // Self-serve (BYO) creates name their k8s provider; purchased SKUs pick
    // by region. Ignored when null/undefined.
    providerId?: string | null
    // Internal capability: a self-serve create owns this fresh runtime until
    // its one preallocated agent and runtime-local config have committed.
    agentCreateId?: string
    // The version the framework installs, resolved by the caller from what the
    // user asked for; absent means the default (admin pin, else latest).
    frameworkVersion?: FrameworkVersionSelection | null
    // The repository that version was admitted from, resolved with it.
    frameworkRepo?: string | null
    frameworkArtifacts?: FrameworkReleaseArtifacts | null
}

export interface ProvisionContainerResult {
    runtime: AgentRuntimeRow
}

export interface ProvisionAgentContainerResult extends ProvisionContainerResult {
    assertAgentCreateActive(): Promise<void>
    runAgentCreate<T>(work: () => Promise<T>): Promise<T>
    completeAgentCreate(): Promise<void>
    rollbackAgentCreate(error: unknown): Promise<void>
}

// What a pod host can run: the coding CLIs, and the service frameworks its
// daemon keeps up from a recipe (ADR-0035 P2).
export const podHostCanRun = (framework: AgentFramework): boolean =>
    isCodingHostFramework(framework) ||
    serviceFrameworkRecipe(framework) !== undefined

// A refusal with its own code (the host's CLI is too old for services, …)
// tells the user what to do; it is not a provisioning failure.
const isTypedRefusal = (err: unknown): err is HttpException =>
    err instanceof HttpException &&
    typeof (err.getResponse() as { code?: unknown }).code === 'string'

export function assertPodHostFramework(framework: AgentFramework): void {
    if (!podHostCanRun(framework))
        throw new BadRequestException({
            code: 'FRAMEWORK_NOT_ON_POD_HOST',
            message: `${framework} cannot run on a cloud computer yet`,
            framework
        })
}

interface FrameworkOnHost {
    frameworkVersion: string | null
    // A service framework's: minted tokens, and where it lives.
    generatedCredentials?: Record<string, string>
    mountPath?: string
}

interface PodFrameworkInstall {
    host: RuntimeHostRow
    provider: RuntimeProvider
    runtimeId: string
    framework: AgentFramework
    credentials: unknown
    modelConfigSource: AgentModelConfigSource | null
    requested: FrameworkVersionSelection | null
    requestedRepo?: string | null
    requestedArtifacts?: FrameworkReleaseArtifacts | null
}

// A Kubernetes pod host (ADR-0035, ADR-0037): one pod running the generic host
// image, whose PVC is the home directory every framework on it is installed
// into. The host row is `hosted` on a k8s runtime provider; the k8s adapter
// makes the pod, the pod's boot loop registers the host's daemon with the
// token bound to it, and every framework install runs through that daemon.
// provision() makes a host together with its first framework runtime (the
// self-serve agent create and a purchased container); createHost() makes a
// bare one; addFrameworkRuntime() installs another framework on a ready host.
@Injectable()
export class K8sContainerProvisioner {
    private readonly log = new Logger(K8sContainerProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly clients: HostProviderClients,
        private readonly placement: HostPlacementService,
        private readonly providers: SandboxProviderRegistry,
        private readonly hostAccess: HostDaemonAccess,
        private readonly config: ConfigService,
        private readonly crypto: CryptoService,
        private readonly podRunner: PodRunnerProvisioner,
        private readonly createCleanup: K8sCreateCleanupService,
        private readonly frameworkVersions: FrameworkVersionsService,
        private readonly k8sProvisioner: K8sProvisioner,
        private readonly hostServices: HostServices
    ) {}

    async provision(
        input: ProvisionContainerInput & { agentCreateId: string }
    ): Promise<ProvisionAgentContainerResult>
    async provision(
        input: ProvisionContainerInput
    ): Promise<ProvisionContainerResult>
    async provision(
        input: ProvisionContainerInput
    ): Promise<ProvisionContainerResult | ProvisionAgentContainerResult> {
        const { userId, sku, name, framework } = input
        assertPodHostFramework(framework)

        const provider = await this.placement.selectProvider({
            kind: 'k8s',
            providerId: input.providerId ?? null,
            region: sku.region
        })
        if (input.agentCreateId)
            await this.createCleanup.assertProviderAvailable(userId, provider.id)
        const runtimeId = createObjectId('agentRuntime')
        const host = await this.db.transaction(async (tx) => {
            const [inserted] = await tx
                .insert(runtimeHosts)
                .values(
                    await this.hostRow(
                        tx,
                        userId,
                        provider,
                        sku,
                        input.hostName ?? null
                    )
                )
                .returning()
            await tx.insert(agentRuntimes).values({
                id: runtimeId,
                userId,
                name,
                framework,
                hostId: inserted.id,
                status: 'installing',
                currentPhase: input.agentCreateId
                    ? K8S_CREATE_INITIAL_AGENT
                    : INSTALLING_FRAMEWORK,
                mountPath: POD_HOST_WORKSPACE_BASE
            })
            if (input.agentCreateId)
                await insertK8sCreateLease(tx, runtimeId, input.agentCreateId)
            return inserted
        })

        const ownership = input.agentCreateId
            ? new K8sCreateOwnership(this.db, runtimeId, input.agentCreateId)
            : undefined
        try {
            await ownership?.start()
            const provision = async (): Promise<
                ProvisionContainerResult | ProvisionAgentContainerResult
            > => {
                const ready = await this.bringUpHost({ host, provider, ownership })
                const installed = await this.installFramework({
                    host: ready,
                    provider,
                    runtimeId,
                    framework,
                    credentials: input.credentials,
                    modelConfigSource: input.modelConfigSource ?? null,
                    requested: input.frameworkVersion ?? null,
                    requestedRepo: input.frameworkRepo ?? null,
                    requestedArtifacts: input.frameworkArtifacts ?? null
                })
                const frameworkVersion = installed.frameworkVersion
                const credentials = withGenerated(
                    input.credentials,
                    installed.generatedCredentials
                )
                if (ownership)
                    await ownership.mutate((tx) =>
                        this.persistRuntimeCredentials(
                            runtimeId,
                            framework,
                            credentials,
                            tx
                        )
                    )
                else
                    await this.persistRuntimeCredentials(
                        runtimeId,
                        framework,
                        credentials
                    )

                await ownership?.assertActive()
                const readyAt = new Date()
                const updateReady = (db: Pick<Database, 'update'>) =>
                    db
                        .update(agentRuntimes)
                        .set({
                            status: input.agentCreateId ? 'installing' : 'ready',
                            currentPhase: input.agentCreateId
                                ? K8S_CREATE_INITIAL_AGENT
                                : null,
                            failureReason: null,
                            frameworkVersion,
                            frameworkVersionCheckedAt: readyAt,
                            lastBootstrappedAt: readyAt,
                            updatedAt: readyAt,
                            ...(installed.mountPath
                                ? { mountPath: installed.mountPath }
                                : {})
                        })
                        .where(
                            and(
                                eq(agentRuntimes.id, runtimeId),
                                input.agentCreateId
                                    ? eq(agentRuntimes.status, 'installing')
                                    : undefined,
                                input.agentCreateId
                                    ? eq(
                                          agentRuntimes.currentPhase,
                                          K8S_CREATE_INITIAL_AGENT
                                      )
                                    : undefined
                            )
                        )
                        .returning()
                const [updated] = ownership
                    ? await ownership.mutate(updateReady)
                    : await updateReady(this.db)
                if (!updated)
                    throw new Error('container provisioning ownership changed')
                const agentId = input.agentCreateId
                if (agentId)
                    return {
                        runtime: updated,
                        assertAgentCreateActive: () =>
                            ownership!.assertActive(),
                        runAgentCreate: (work) => ownership!.run(work),
                        completeAgentCreate: async () => {
                            await this.db.transaction(async (tx) => {
                                await ownership!.assertInTx(tx)
                                const rows = await tx
                                    .update(agentRuntimes)
                                    .set({
                                        status: 'ready',
                                        currentPhase: null,
                                        failureReason: null,
                                        updatedAt: new Date()
                                    })
                                    .where(
                                        and(
                                            eq(agentRuntimes.id, runtimeId),
                                            eq(agentRuntimes.userId, userId),
                                            eq(agentRuntimes.status, 'installing'),
                                            eq(
                                                agentRuntimes.currentPhase,
                                                K8S_CREATE_INITIAL_AGENT
                                            ),
                                            eq(
                                                agentRuntimes.primaryAgentId,
                                                agentId
                                            )
                                        )
                                    )
                                    .returning({ id: agentRuntimes.id })
                                if (rows.length !== 1)
                                    throw new Error(
                                        'fresh container creation ownership changed'
                                    )
                                const published = await tx
                                    .update(agents)
                                    .set({
                                        status: 'ready',
                                        updatedAt: new Date()
                                    })
                                    .where(
                                        and(
                                            eq(agents.id, agentId),
                                            eq(agents.runtimeId, runtimeId),
                                            eq(agents.userId, userId),
                                            eq(agents.status, 'pending')
                                        )
                                    )
                                    .returning({ id: agents.id })
                                if (published.length !== 1)
                                    throw new Error(
                                        'fresh agent creation ownership changed'
                                    )
                                await tx
                                    .delete(serviceLeases)
                                    .where(
                                        eq(
                                            serviceLeases.name,
                                            k8sCreateLeaseName(runtimeId)
                                        )
                                    )
                            })
                            await ownership!.stop()
                        },
                        rollbackAgentCreate: async (error) =>
                            this.createCleanup.rollback({
                                requestsSettled: await ownership!.stop(),
                                runtimeId,
                                userId,
                                agentId,
                                error,
                                host: ready,
                                provider
                            })
                    }
                return { runtime: updated }
            }
            return ownership
                ? await ownership.run(provision)
                : await provision()
        } catch (err) {
            const reason = input.agentCreateId
                ? describeK8sCreateError(err, this.providers)
                : sanitizeReason(err)
            this.log.warn(
                `pod host provision failed hostId=${host.id} runtimeId=${runtimeId} framework=${framework}: ${reason}`
            )
            const current = (await this.hosts.findById(host.id)) ?? host
            if (input.agentCreateId) {
                await this.createCleanup.rollback({
                    requestsSettled: await ownership!.stop(),
                    runtimeId,
                    userId,
                    agentId: input.agentCreateId,
                    error: err,
                    host: current,
                    provider
                })
                if (err instanceof GatewayTimeoutException || isTypedRefusal(err))
                    throw err
                throw new InternalServerErrorException({
                    message: 'container provisioning failed',
                    reason
                })
            }
            await this.discardHost(current, provider, reason)
            if (err instanceof GatewayTimeoutException || isTypedRefusal(err))
                throw err
            throw new InternalServerErrorException({
                message: 'container provisioning failed',
                reason
            })
        }
    }

    // A bare host with no framework yet (ADR-0035 §2): frameworks are added to
    // it with addFrameworkRuntime. Returns once the host is recorded; the pod
    // comes up in the background, and the row says how that went — ready, or
    // failed with the reason, its objects removed.
    async createHost(input: {
        userId: string
        name?: string | null
        resources: PodHostResources
        region?: string | null
        providerId?: string | null
    }): Promise<RuntimeHostRow> {
        const provider = await this.placement.selectProvider({
            kind: 'k8s',
            providerId: input.providerId ?? null,
            region: input.region ?? null
        })
        const sku = { ...input.resources, region: input.region ?? null }
        const [host] = await this.db.transaction(async (tx) =>
            tx
                .insert(runtimeHosts)
                .values(
                    await this.hostRow(
                        tx,
                        input.userId,
                        provider,
                        sku,
                        input.name ?? null
                    )
                )
                .returning()
        )
        void inBackgroundContext(() =>
            this.bringUpBareHost(host, provider)
        )()
        return host
    }

    private async bringUpBareHost(
        host: RuntimeHostRow,
        provider: RuntimeProvider
    ): Promise<void> {
        try {
            await this.bringUpHost({ host, provider })
        } catch (err) {
            const reason = sanitizeReason(err)
            this.log.warn(
                `pod host create failed hostId=${host.id}: ${reason}`
            )
            const current = (await this.hosts.findById(host.id)) ?? host
            await this.discardHost(current, provider, reason, {
                keepRow: true
            }).catch((cleanupErr: Error) =>
                this.log.error(
                    `pod host cleanup crashed hostId=${host.id}: ${cleanupErr.message}`
                )
            )
        }
    }

    // Install `framework` on a ready pod host as a new runtime. The host keeps
    // whatever else it runs; the runtime row is the (host, framework) slot —
    // a failed install keeps it as `failed` for the next try to reuse.
    async addFrameworkRuntime(input: {
        userId: string
        host: RuntimeHostRow
        framework: AgentFramework
        name: string
        credentials: unknown
        modelConfigSource?: AgentModelConfigSource | null
        frameworkVersion?: FrameworkVersionSelection | null
        frameworkRepo?: string | null
        frameworkArtifacts?: FrameworkReleaseArtifacts | null
    }): Promise<AgentRuntimeRow> {
        const { host, framework, userId } = input
        assertPodHostFramework(framework)
        if (
            host.kind !== 'hosted' ||
            host.userId !== userId ||
            host.providerRef?.kind !== 'k8s'
        )
            throw new NotFoundException(`cloud computer ${host.id} not found`)
        if (host.status !== 'ready')
            throw new ConflictException({
                code: 'POD_HOST_NOT_READY',
                message: `cloud computer ${host.id} is not ready`,
                status: host.status
            })
        const [claimed] = await this.db
            .insert(agentRuntimes)
            .values({
                id: createObjectId('agentRuntime'),
                userId,
                name: input.name,
                framework,
                hostId: host.id,
                status: 'installing',
                currentPhase: INSTALLING_FRAMEWORK,
                mountPath: POD_HOST_WORKSPACE_BASE
            })
            .onConflictDoUpdate({
                target: [agentRuntimes.hostId, agentRuntimes.framework],
                targetWhere: sql`${agentRuntimes.hostId} is not null`,
                set: {
                    status: 'installing',
                    currentPhase: INSTALLING_FRAMEWORK,
                    failureReason: null,
                    updatedAt: new Date()
                },
                setWhere: sql`${agentRuntimes.status} = 'failed'`
            })
            .returning()
        if (!claimed)
            throw new ConflictException({
                code: 'POD_HOST_FRAMEWORK_EXISTS',
                message: `cloud computer ${host.id} already runs ${framework}`,
                framework
            })
        const runtimeId = claimed.id
        try {
            const provider = await this.clients.providerForHost(host)
            const installed = await this.installFramework({
                host,
                provider,
                runtimeId,
                framework,
                credentials: input.credentials,
                modelConfigSource: input.modelConfigSource ?? null,
                requested: input.frameworkVersion ?? null,
                requestedRepo: input.frameworkRepo ?? null,
                requestedArtifacts: input.frameworkArtifacts ?? null
            })
            await this.persistRuntimeCredentials(
                runtimeId,
                framework,
                withGenerated(input.credentials, installed.generatedCredentials)
            )
            const readyAt = new Date()
            const [updated] = await this.db
                .update(agentRuntimes)
                .set({
                    status: 'ready',
                    currentPhase: null,
                    failureReason: null,
                    frameworkVersion: installed.frameworkVersion,
                    frameworkVersionCheckedAt: readyAt,
                    lastBootstrappedAt: readyAt,
                    updatedAt: readyAt,
                    ...(installed.mountPath
                        ? { mountPath: installed.mountPath }
                        : {})
                })
                .where(eq(agentRuntimes.id, runtimeId))
                .returning()
            return updated
        } catch (err) {
            const reason = sanitizeReason(err)
            this.log.warn(
                `framework install failed hostId=${host.id} framework=${framework}: ${reason}`
            )
            await this.db
                .update(agentRuntimes)
                .set({
                    status: 'failed',
                    currentPhase: null,
                    failureReason: reason,
                    updatedAt: new Date()
                })
                .where(eq(agentRuntimes.id, runtimeId))
            if (isTypedRefusal(err)) throw err
            throw new InternalServerErrorException({
                message: `installing ${framework} failed`,
                reason
            })
        }
    }

    // Removes one framework runtime (its credentials cascade); the host stays.
    // See K8sProvisioner for both deletes.
    async teardown(runtime: AgentRuntimeRow): Promise<void> {
        await this.k8sProvisioner.teardownRuntime(runtime)
    }

    async teardownHost(host: RuntimeHostRow): Promise<void> {
        await this.k8sProvisioner.teardownHost(host)
    }

    private async hostRow(
        tx: Pick<Database, 'execute'>,
        userId: string,
        provider: RuntimeProvider,
        sku: PodHostResources & { region: string | null },
        name: string | null
    ) {
        return {
            id: createObjectId('podHost'),
            userId,
            kind: 'hosted' as const,
            providerId: provider.id,
            providerRef: null,
            name: name?.trim() || (await this.nextHostName(tx, userId)),
            status: 'provisioning' as const,
            generation: 1,
            powerState: 'unknown' as const,
            cpuMillicores: sku.cpuMillicores,
            memoryMb: sku.memoryMb,
            diskGb: sku.diskGb,
            region: sku.region,
            homeDir: K8S_HOME_BASE,
            workspaceBaseDir: POD_HOST_WORKSPACE_BASE
        }
    }

    // computer-001, computer-002, … per user. Names are display labels, not
    // addresses, so a race that repeats one costs nothing.
    private async nextHostName(
        tx: Pick<Database, 'execute'>,
        userId: string
    ): Promise<string> {
        const rows = (await tx.execute(sql`
            select coalesce(
                max((regexp_match(name, '^computer-([0-9]+)$'))[1]::int),
                0
            ) as max
            from runtime_hosts
            where user_id = ${userId} and kind = 'hosted'
        `)) as unknown as Array<{ max: number | string | null }>
        const next = Number(rows[0]?.max ?? 0) + 1
        return `computer-${String(next).padStart(3, '0')}`
    }

    // Creates the host's Secret, PVC and Deployment through the adapter, then
    // waits until the pod runs and its daemon has registered: only then can
    // anything be installed on it or a turn reach it. Returns the host as it
    // is once its daemon made it ready.
    private async bringUpHost(args: {
        host: RuntimeHostRow
        provider: RuntimeProvider
        ownership?: K8sCreateOwnership
    }): Promise<RuntimeHostRow> {
        const { host, provider, ownership } = args
        const adapter = this.providers.for(provider.kind)
        const mintInput = { userId: host.userId, hostId: host.id }
        const podRunner = ownership
            ? await ownership.mutate((tx) => this.podRunner.mint(mintInput, tx))
            : await this.podRunner.mint(mintInput)
        const generation = await this.hosts.bumpGeneration(host.id)
        const call: ProviderCall = {
            host,
            provider,
            generation,
            ...(ownership ? { fence: ownership } : {})
        }
        await ownership?.assertActive()
        await adapter.create({
            ...call,
            spec: {
                name: host.name,
                region: host.region,
                cpuMillicores: host.cpuMillicores,
                memoryMb: host.memoryMb,
                diskGb: host.diskGb,
                env: podRunner.env
            }
        })
        await ownership?.assertActive()
        const timeoutMs =
            Number(this.config.get<string>('K8S_CONTAINER_PROVISION_TIMEOUT_MS')) ||
            DEFAULT_READINESS_TIMEOUT_MS
        await this.waitForHost({
            ownership,
            call,
            deadline: Date.now() + timeoutMs
        })
        const ready = await this.hosts.findById(host.id)
        if (!ready) throw new Error(`host ${host.id} disappeared`)
        if (ready.status === 'provisioning')
            return (await this.hosts.setStatus(ready.id, 'ready')) ?? ready
        return ready
    }

    private async installFramework(
        args: PodFrameworkInstall
    ): Promise<FrameworkOnHost> {
        assertPodHostFramework(args.framework)
        const { host } = args
        const { selection, repo, artifacts } = args.requested
            ? {
                  selection: args.requested,
                  repo: args.requestedRepo ?? null,
                  artifacts: args.requestedArtifacts ?? null
              }
            : await this.frameworkVersions.resolveInstallVersion(args.framework)
        // Everything inside the machine goes through its daemon (ADR-0037
        // R6): the install is a login-shell script the daemon runs, all of it
        // in one session on the machine.
        try {
            return await this.hostAccess.withHost(
                {
                    host,
                    daemon: null,
                    placement: 'k8s',
                    reason: `install-${args.framework}`
                },
                (session) =>
                    this.installFrameworkOn(session, args, {
                        selection,
                        repo,
                        artifacts
                    })
            )
        } catch (err) {
            if (!(err instanceof HostDaemonOfflineError)) throw err
            throw new ServiceUnavailableException({
                code: 'POD_HOST_DAEMON_OFFLINE',
                message: `cloud computer ${host.id} has no connected daemon (${err.reason})`
            })
        }
    }

    private async installFrameworkOn(
        session: HostSession,
        args: PodFrameworkInstall,
        resolved: {
            selection: FrameworkVersionSelection
            repo: string | null
            artifacts: FrameworkReleaseArtifacts | null
        }
    ): Promise<FrameworkOnHost> {
        const { host } = args
        const { selection, repo, artifacts } = resolved
        const runner = sessionScriptRunner({ run: session.exec }, (event, fields) =>
            this.log.warn(
                `${event} ${JSON.stringify({ hostId: host.id, ...fields })}`
            )
        )
        const install = {
            frameworkVersion: selection.version,
            frameworkVersionSource: selection.source,
            frameworkRepo: repo,
            frameworkArtifacts: artifacts
        }
        const recipe = serviceFrameworkRecipe(args.framework)
        if (!recipe) {
            if (!isCodingHostFramework(args.framework))
                throw new Error(`${args.framework} has no pod recipe`)
            return setUpHostFramework({
                runner,
                framework: args.framework,
                workspaceBase: POD_HOST_WORKSPACE_BASE,
                credentials: args.credentials,
                modelConfigSource: args.modelConfigSource,
                install
            })
        }
        // A service framework: installed and kept up by the host's daemon,
        // and routed to a hostname of its own (the adapter's publishPort).
        const setup = await this.hostServices.setUp({
            host,
            session,
            runtimeId: args.runtimeId,
            framework: args.framework,
            credentials: args.credentials,
            envText: null,
            install
        })
        return {
            frameworkVersion: setup.frameworkVersion,
            generatedCredentials: setup.generatedCredentials,
            mountPath: setup.home
        }
    }

    private async persistRuntimeCredentials(
        runtimeId: string,
        framework: AgentFramework,
        credentials: unknown,
        db: Pick<Database, 'insert'> = this.db
    ): Promise<void> {
        if (!credentials) return
        const enc = this.crypto.encrypt(JSON.stringify(credentials))
        await db.insert(agentCredentials).values({
            id: createObjectId('agentCredential'),
            runtimeId,
            framework,
            payloadCiphertext: enc.ciphertext,
            keyVersion: enc.keyVersion
        })
    }

    // The pod is up when the adapter observes it running; the host is ready
    // when its daemon has registered onto it (the register flips the row).
    private async waitForHost(args: {
        ownership?: K8sCreateOwnership
        call: ProviderCall
        deadline: number
    }): Promise<void> {
        const { call } = args
        const adapter = this.providers.for(call.provider.kind)
        let running = false
        while (Date.now() < args.deadline) {
            await args.ownership?.assertActive()
            try {
                if (!running) {
                    const current =
                        (await this.hosts.findById(call.host.id)) ?? call.host
                    const power = await adapter.power({
                        host: current,
                        provider: call.provider
                    })
                    if (power !== 'gone')
                        await recordPower(this.hosts, call.host.id, power)
                    running = power === 'running'
                }
                if (running && (await this.daemonRegistered(call.host.id)))
                    return
            } catch (err) {
                this.log.debug?.(
                    `pod host readiness poll error hostId=${call.host.id}: ${(err as Error).message}`
                )
            }
            await sleep(POLL_INTERVAL_MS)
        }
        throw new GatewayTimeoutException(
            running
                ? 'cloud computer daemon did not register in time'
                : 'cloud computer readiness timeout'
        )
    }

    // Registered AND connected: the boot loop's daemon holds an rpc lease.
    private async daemonRegistered(hostId: string): Promise<boolean> {
        return hasRpcLease(await this.hostDaemons.findByHostId(hostId))
    }

    // Undo a host whose creation failed: its Kubernetes objects and — once
    // they are confirmed gone — its rows (the bound token and the daemon row
    // cascade with the host). Best effort per step; a failure here must not
    // replace the provisioning error the caller gets. A host whose objects
    // may outlive the attempt keeps its row, failed, so deleting it retries
    // the teardown; so does one the user asked for on its own (keepRow),
    // which shows the reason.
    private async discardHost(
        host: RuntimeHostRow,
        provider: RuntimeProvider,
        reason: string,
        options: { keepRow?: boolean } = {}
    ): Promise<void> {
        const adapter = this.providers.for(provider.kind)
        let objectsGone = true
        try {
            const generation = await this.hosts.bumpGeneration(host.id)
            await adapter.destroy({ host, provider, generation })
        } catch (err) {
            objectsGone = false
            this.log.warn(
                `pod host rollback failed hostId=${host.id}: ${(err as Error).message}`
            )
        }
        await this.db
            .delete(agentRuntimes)
            .where(eq(agentRuntimes.hostId, host.id))
        if (objectsGone && !options.keepRow)
            await this.db.transaction(async (tx) => {
                await tx.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id))
                await tx.delete(runtimeHosts).where(eq(runtimeHosts.id, host.id))
            })
        else await this.hosts.setStatus(host.id, 'failed', reason)
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const sanitizeReason = (err: unknown): string => {
    const message = (err as Error)?.message ?? 'unknown error'
    return message
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
}

const withGenerated = (
    credentials: unknown,
    generated: Record<string, string> | undefined
): unknown =>
    generated ? { ...((credentials as object | null) ?? {}), ...generated } : credentials
