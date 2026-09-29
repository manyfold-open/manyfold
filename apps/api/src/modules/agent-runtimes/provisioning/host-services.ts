import {
    DAEMON_FEATURE_SERVICES,
    K8S_HOME_BASE,
    SPRITE_HOME_BASE,
    type AgentFramework,
    type DaemonServiceSpec,
    type DaemonServiceStatus
} from '@manyfold/shared'
import {
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { AgentRuntimeRow, RuntimeHostRow } from '@manyfold/db'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { AppEventsService } from '@/common/events/app-events.service'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import {
    sessionScriptRunner,
    type SessionScriptRunner
} from '@/modules/agents/bootstrap/host-framework-setup'
import { BootstrapError } from '@/modules/agents/bootstrap/framework-bootstrap'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import {
    serviceFrameworkRecipe,
    type ServiceFrameworkRecipe,
    type ServiceFrameworkSetup,
    type ServiceHost,
    type ServiceInstallRequest
} from '@/modules/agents/bootstrap/service-frameworks'

const SERVICE_RPC_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 3_000
export const SERVICE_READY_TIMEOUT_MS = 180_000

type HostRef = Pick<RuntimeHostRow, 'id' | 'userId'>

export interface ServiceSettings {
    credentials: unknown
    envText: string | null
    controlUiEnabled: boolean
    dashboardEnabled: boolean
}

// The long-running processes of the service frameworks on a hosted machine,
// run by the machine's own daemon (services.v1) on a sandbox and a cloud
// computer alike: it starts them, restarts them after a crash, keeps them
// across its own updates and starts them again after the machine restarts.
// The daemon is the host's (ADR-0037), reached through the host's session
// (ADR-0038). The provider routes the framework's public entry to the port
// it serves (publishPort): a sandbox's URL, a cloud computer's ingress host.
@Injectable()
export class HostServices {
    private readonly log = new Logger(HostServices.name)

    constructor(
        private readonly hosts: HostsService,
        private readonly access: HostDaemonAccess,
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderResolver,
        private readonly runtimes: AgentRuntimesService,
        private readonly config: ConfigService,
        @Optional() private readonly events?: AppEventsService
    ) {}

    private async hostRow(ref: HostRef): Promise<RuntimeHostRow> {
        const row = await this.hosts.findById(ref.id)
        if (!row || row.userId !== ref.userId)
            throw new ServiceUnavailableException(
                `host ${ref.id} has no connected daemon`
            )
        return row
    }

    private placement(host: RuntimeHostRow): 'k8s' | 'sprites' {
        return host.providerRef?.kind === 'k8s' ? 'k8s' : 'sprites'
    }

    private label(host: RuntimeHostRow): string {
        return `${this.placement(host) === 'k8s' ? 'cloud computer' : 'sandbox'} ${host.id}`
    }

    // Where a recipe installs on this host and whether the host sleeps.
    serviceHost(host: RuntimeHostRow): ServiceHost {
        const placement = this.placement(host)
        return {
            home:
                host.homeDir ??
                (placement === 'k8s' ? K8S_HOME_BASE : SPRITE_HOME_BASE),
            suspends: placement === 'sprites'
        }
    }

    private offline(host: RuntimeHostRow, err: unknown): never {
        if (!(err instanceof HostDaemonOfflineError)) throw err
        throw new ServiceUnavailableException(
            `${this.label(host)} has no connected daemon (${err.reason})`
        )
    }

    // A daemon that does not run services is brought to one that does by
    // the admission: a sandbox's is handed to its supervised loop, an older
    // CLI is updated.
    private async withDaemon<T>(
        ref: HostRef,
        reason: string,
        work: (session: HostSession) => Promise<T>,
        opts: { wake?: boolean } = {}
    ): Promise<T> {
        const host = await this.hostRow(ref)
        try {
            return await this.access.withHost(
                {
                    host,
                    daemon: null,
                    placement: this.placement(host),
                    reason,
                    requiredFeatures: [DAEMON_FEATURE_SERVICES],
                    ...(opts.wake === false ? { wake: false } : {})
                },
                work
            )
        } catch (err) {
            return this.offline(host, err)
        }
    }

    private call(
        session: HostSession,
        method:
            | 'service.upsert'
            | 'service.start'
            | 'service.stop'
            | 'service.delete'
            | 'service.list',
        payload: Record<string, unknown>
    ): Promise<Record<string, unknown> | undefined> {
        return session.rpc({ method, payload, timeoutMs: SERVICE_RPC_TIMEOUT_MS })
    }

    // Login-shell scripts on the machine, through its daemon and under the
    // host's hold, for as long as `work` runs: a recipe's configure, a
    // credential rewrite. Unlike the services calls they need no service
    // support.
    async runScripts<T>(
        ref: HostRef,
        reason: string,
        work: (runner: SessionScriptRunner) => Promise<T>
    ): Promise<T> {
        const host = await this.hostRow(ref)
        try {
            return await this.access.withHost(
                { host, daemon: null, placement: this.placement(host), reason },
                (session) => work(this.runnerFor(host, session))
            )
        } catch (err) {
            return this.offline(host, err)
        }
    }

    runnerFor(host: HostRef, session: HostSession): SessionScriptRunner {
        return sessionScriptRunner({ run: session.exec }, (event, fields) =>
            this.log.warn(`${event} ${JSON.stringify({ hostId: host.id, ...fields })}`)
        )
    }

    // Throws unless the host's daemon runs services, bringing it there first.
    async ready(ref: HostRef): Promise<void> {
        await this.withDaemon(ref, 'services', async () => undefined)
    }

    async upsert(ref: HostRef, spec: DaemonServiceSpec): Promise<void> {
        await this.withDaemon(ref, 'services', (s) =>
            this.call(s, 'service.upsert', { spec })
        )
    }

    async start(ref: HostRef, name: string): Promise<void> {
        await this.withDaemon(ref, 'services', (s) =>
            this.call(s, 'service.start', { name })
        )
    }

    async stop(ref: HostRef, name: string): Promise<void> {
        await this.withDaemon(ref, 'services', (s) =>
            this.call(s, 'service.stop', { name })
        )
    }

    // A changed env or config only takes effect in a new process.
    async restart(ref: HostRef, name: string): Promise<void> {
        await this.withDaemon(ref, 'services', async (s) => {
            await this.call(s, 'service.stop', { name })
            await this.call(s, 'service.start', { name })
        })
    }

    async remove(ref: HostRef, name: string): Promise<void> {
        await this.withDaemon(ref, 'services', (s) =>
            this.call(s, 'service.delete', { name })
        )
    }

    async list(ref: HostRef): Promise<DaemonServiceStatus[]> {
        return this.withDaemon(ref, 'services', (s) => this.listIn(s))
    }

    private async listIn(session: HostSession): Promise<DaemonServiceStatus[]> {
        const result = await this.call(session, 'service.list', {})
        return (result?.services as DaemonServiceStatus[] | undefined) ?? []
    }

    // Until the service answers its health path: a framework runtime is
    // ready when its service is (ADR-0035 §9), not when its process exists.
    async waitHealthy(
        ref: HostRef,
        name: string,
        timeoutMs: number = SERVICE_READY_TIMEOUT_MS
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs
        let last: DaemonServiceStatus | undefined
        while (Date.now() < deadline) {
            last = (await this.list(ref)).find((s) => s.name === name)
            if (last?.healthy === true) return
            await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
        }
        const host = await this.hostRow(ref)
        throw new ServiceUnavailableException(
            `service ${name} on ${this.label(host)} did not become healthy (${last?.state ?? 'absent'}${last?.lastExit ? `, last exit: ${last.lastExit}` : ''})`
        )
    }

    // Routes a framework's public entry to a port inside the host; a null
    // port withdraws it.
    async publish(
        ref: HostRef,
        route: { framework: string; port: number | null }
    ): Promise<void> {
        const host = await this.hostRow(ref)
        const provider = await this.clients.providerForHost(host)
        const adapter = this.providers.for(provider.kind)
        await adapter.publishPort?.({ host, provider }, route)
    }

    // A setup's services running as it describes them: the main service up
    // and healthy first, then its companions in order, the ones it no longer
    // has removed, and the public entry on its port. `restart` for a changed
    // config or env, which only a new process picks up.
    async apply(
        ref: HostRef,
        recipe: ServiceFrameworkRecipe,
        setup: ServiceFrameworkSetup,
        opts: { restart: boolean }
    ): Promise<void> {
        const keep = new Set(setup.companions.map((c) => c.name))
        await this.withDaemon(ref, 'services', async (s) => {
            const present = new Set((await this.listIn(s)).map((x) => x.name))
            for (const name of recipe.companionNames)
                if (!keep.has(name) && present.has(name))
                    await this.call(s, 'service.delete', { name })
            await this.call(s, 'service.upsert', { spec: setup.spec })
            if (opts.restart && present.has(setup.spec.name))
                await this.call(s, 'service.stop', { name: setup.spec.name })
            await this.call(s, 'service.start', { name: setup.spec.name })
        })
        await this.waitHealthy(ref, setup.spec.name)
        for (const companion of setup.companions) {
            await this.withDaemon(ref, 'services', async (s) => {
                await this.call(s, 'service.upsert', { spec: companion })
                await this.call(s, 'service.stop', { name: companion.name })
                await this.call(s, 'service.start', { name: companion.name })
            })
            if (companion.healthPath)
                await this.waitHealthy(ref, companion.name)
        }
        await this.publish(ref, {
            framework: recipe.framework,
            port: setup.publicPort
        })
    }

    // A service framework's first setup on a host, through the session the
    // caller already holds: installed, configured, running, healthy and
    // published.
    async setUp(args: {
        host: RuntimeHostRow
        session: HostSession
        runtimeId: string
        framework: AgentFramework
        credentials: unknown
        envText: string | null
        install: ServiceInstallRequest
        onInstalled?: () => void
    }): Promise<{
        frameworkVersion: string | null
        generatedCredentials: Record<string, string>
        home: string
    }> {
        const recipe = this.recipeFor(args.framework)
        const serviceHost = this.serviceHost(args.host)
        await this.ready(args.host)
        const runner = this.runnerFor(args.host, args.session)
        const frameworkVersion = await this.install(
            recipe,
            runner,
            serviceHost,
            args.install
        )
        args.onInstalled?.()
        const setup = await recipe.configure(runner, {
            host: serviceHost,
            runtimeId: args.runtimeId,
            credentials: args.credentials,
            envText: args.envText,
            controlUiEnabled: true,
            dashboardEnabled: false,
            apiBaseUrl: this.apiBaseUrl()
        })
        await this.apply(args.host, recipe, setup, { restart: false })
        await this.markReady({ id: args.runtimeId, framework: args.framework })
        return {
            frameworkVersion,
            generatedCredentials: setup.generatedCredentials,
            home: recipe.home(serviceHost.home)
        }
    }

    // An implicit latest that will not install is retried unpinned, on the
    // framework's own dist-tag: a machine getting its first service framework
    // has no earlier install to fall back on, and "create an agent" must not
    // hinge on the newest release installing. The version is then left
    // unknown rather than guessed; the next probe fills it in. An asked-for
    // version fails loud.
    private async install(
        recipe: ServiceFrameworkRecipe,
        runner: SessionScriptRunner,
        host: ServiceHost,
        request: ServiceInstallRequest
    ): Promise<string | null> {
        try {
            return await recipe.install(runner, { ...request, host })
        } catch (err) {
            const retryable =
                frameworkVersionDescriptor(recipe.framework).source.kind === 'npm' &&
                !!request.frameworkVersion &&
                request.frameworkVersionSource === 'latest' &&
                err instanceof BootstrapError &&
                err.step === `${recipe.framework}-install-version`
            if (!retryable) throw err
            this.log.warn(
                `${recipe.framework} latest ${request.frameworkVersion} did not install, retrying unpinned: ${(err as Error).message}`
            )
            await recipe.install(runner, {
                ...request,
                frameworkVersion: null,
                frameworkVersionSource: 'none',
                host
            })
            return null
        }
    }

    // The framework's config rewritten for these settings and its services
    // restarted on them: a credential or env change, the control UI or the
    // dashboard switched.
    async reconfigure(
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow,
        settings: ServiceSettings
    ): Promise<ServiceFrameworkSetup> {
        const recipe = this.recipeFor(runtime.framework)
        const setup = await this.runScripts(host, 'service-configure', (runner) =>
            recipe.configure(runner, {
                host: this.serviceHost(host),
                runtimeId: runtime.id,
                credentials: settings.credentials,
                envText: settings.envText,
                controlUiEnabled: settings.controlUiEnabled,
                dashboardEnabled: settings.dashboardEnabled,
                apiBaseUrl: this.apiBaseUrl()
            })
        )
        await this.apply(host, recipe, setup, { restart: true })
        await this.markReady(runtime)
        return setup
    }

    // The runtime's services started again where a stop left them stopped:
    // chat activity on a sandbox. A service the daemon already runs is left
    // alone; it restarts crashed ones itself.
    async ensureRunning(runtime: AgentRuntimeRow, host: RuntimeHostRow): Promise<boolean> {
        const recipe = serviceFrameworkRecipe(runtime.framework)
        if (!recipe) return false
        const names = [recipe.serviceName, ...recipe.companionNames]
        const started = await this.withDaemon(host, 'service-wake', async (s) => {
            const listed = await this.listIn(s)
            const stopped = names.filter((name) =>
                listed.some((x) => x.name === name && x.state === 'stopped')
            )
            for (const name of stopped)
                await this.call(s, 'service.start', { name })
            return stopped.length > 0
        })
        if (!started) return false
        await this.runtimes.applyServiceReportPatch(runtime.id, {
            serviceStatus: 'starting',
            serviceStatusAt: new Date()
        })
        void this.waitHealthy(host, recipe.serviceName)
            .then(inBackgroundContext(() => this.markReady(runtime)))
            .catch((err: Error) =>
                this.log.warn(
                    `service of runtime ${runtime.id} did not come back: ${err.message}`
                )
            )
        return true
    }

    // The runtime's services stopped, companions first, on a machine that is
    // up (a sandbox stop): never woken for it. The only downward writer of
    // service_status.
    async stopRuntime(runtime: AgentRuntimeRow, host: RuntimeHostRow): Promise<void> {
        const recipe = serviceFrameworkRecipe(runtime.framework)
        if (!recipe) return
        const names = [recipe.serviceName, ...recipe.companionNames].reverse()
        await this.withDaemon(
            host,
            'service-stop',
            async (s) => {
                const listed = await this.listIn(s)
                for (const name of names)
                    if (listed.some((x) => x.name === name && x.state !== 'stopped'))
                        await this.call(s, 'service.stop', { name })
            },
            { wake: false }
        )
        await this.runtimes.applyServiceReportPatch(runtime.id, {
            serviceStatus: 'stopped',
            serviceStatusAt: new Date()
        })
    }

    // A runtime leaving its host takes its services and the host's public
    // route with it.
    async removeRuntime(runtime: AgentRuntimeRow, host: RuntimeHostRow): Promise<void> {
        const recipe = serviceFrameworkRecipe(runtime.framework)
        if (!recipe) return
        const names = [recipe.serviceName, ...recipe.companionNames].reverse()
        await this.withDaemon(host, 'service-remove', async (s) => {
            const listed = await this.listIn(s)
            for (const name of names)
                if (listed.some((x) => x.name === name))
                    await this.call(s, 'service.delete', { name })
        })
        await this.publish(host, { framework: runtime.framework, port: null })
    }

    // A service that answered its health check: the runtime's status, and
    // anything that waits for the framework to be up (a framework module's
    // sync, the reconcile).
    async markReady(runtime: Pick<AgentRuntimeRow, 'id' | 'framework'>): Promise<void> {
        await this.runtimes.applyServiceReportPatch(runtime.id, {
            serviceStatus: 'ready',
            serviceStatusAt: new Date()
        })
        this.events?.emit('runtime.service.ready', {
            runtimeId: runtime.id,
            framework: runtime.framework
        })
    }

    recipeFor(framework: AgentFramework): ServiceFrameworkRecipe {
        const recipe = serviceFrameworkRecipe(framework)
        if (!recipe)
            throw new ServiceUnavailableException(
                `${framework} runs no service on a hosted machine`
            )
        return recipe
    }

    apiBaseUrl(): string | null {
        return this.config.get<string>('PUBLIC_API_BASE_URL') ?? null
    }
}
