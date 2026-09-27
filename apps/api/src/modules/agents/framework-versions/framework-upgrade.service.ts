import {
    AgentFramework,
    AgentSummary,
    FrameworkBlockedVersionRange,
    FrameworkUpgradeStep,
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE,
    blockedVersionMessage,
    compareSemverPrecedence,
    findBlockedVersionRange,
    frameworkPrereleaseAllowed,
    frameworkRepoCandidates,
    frameworkUpgradeMode,
    isPrereleaseVersion,
    isVersionedFramework,
    upgradesInPlace
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import { type Agent, type Database, type RuntimeHostRow } from '@manyfold/db'
import { execSprite } from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { withRuntimeUpgradeLock } from '@/common/runtime-upgrade-lock'
import { AgentsService } from '@/modules/agents/agents.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { FrameworkVersionProbeService } from '@/modules/agents/framework-versions/framework-version-probe.service'
import {
    buildVersionInstallShell,
    frameworkVersionDescriptor
} from '@/modules/framework-versions/framework-version-registry'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'
import { FrameworkExecResolver } from '@/modules/agents/adapters/framework-exec'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import {
    hostsFrameworkCli,
    runOnRuntimeHost,
    upgradeLockTarget
} from './runtime-host-shell'
import { PodHostServices } from '@/modules/agent-runtimes/provisioning/pod-host-services'
import {
    podServiceRecipe,
    type PodServiceRecipe
} from '@/modules/agent-runtimes/provisioning/pod-service-frameworks'
import {
    HERMES_WEB_BUILD_SHELL,
    HERMES_WEB_BUILD_TIMEOUT_MS,
    SPRITE_HERMES_HOME
} from '@/modules/agents/bootstrap/hermes-sprite'
import {
    buildHermesRebuildShell,
    buildHermesRestoreShell
} from '@/modules/agents/bootstrap/hermes-shared'

// npm installs of the coding-agent CLIs can take a while (claude-code is a
// large package); keep the synchronous exec window generous.
const UPGRADE_TIMEOUT_MS = 180_000
// A git rebuild (clone + dependency sync + frontend build) measured 5–7 min in
// the probe; cap at 15 min for slow mirrors (matches the bootstrap install
// timeout).
const REBUILD_TIMEOUT_MS = 900_000
const RESTORE_TIMEOUT_MS = 120_000
const POD_SERVICE_READY_TIMEOUT_MS = 180_000

export interface FrameworkUpgradeEmitter {
    step(step: FrameworkUpgradeStep): void
}

type HostedRuntime = RuntimeContext & { host: RuntimeHostRow }

@Injectable()
export class FrameworkUpgradeService {
    private readonly log = new Logger(FrameworkUpgradeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly agents: AgentsService,
        private readonly versions: FrameworkVersionsService,
        private readonly probe: FrameworkVersionProbeService,
        private readonly adminSettings: AdminSettingsService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly execResolver: FrameworkExecResolver,
        private readonly hostClients: HostProviderClients,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry(),
        // Appended last + @Optional; absent, pod service frameworks cannot be
        // rebuilt.
        @Optional() private readonly podServices?: PodHostServices
    ) {}

    async upgrade(
        agentId: string,
        callerUserId: string,
        targetVersion: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        if (!isVersionedFramework(agent.framework))
            throw new BadRequestException(
                `${agent.framework} has no upgradeable framework version`
            )
        const descriptor = frameworkVersionDescriptor(agent.framework)
        // npm and release-binary frameworks upgrade in place. A rebuild one
        // needs a heavy re-clone / re-installer, streamed by upgradeStreaming.
        if (!upgradesInPlace(frameworkUpgradeMode(agent.framework)))
            throw new BadRequestException(
                `${agent.framework} upgrade is not supported yet`
            )
        const ctx = await this.hostedRuntime(agent)
        const { runtime, host } = ctx

        const catalog = await this.versions.getForFramework(agent.framework)
        // Blocked before "not in catalog": the denylist already removed the
        // release from `versions`, so without this the caller would be told the
        // version does not exist instead of why it is refused.
        this.assertNotBlocked(agent.framework, targetVersion, catalog.blocked)
        await this.assertPrereleaseAllowed(agent.framework, targetVersion)
        if (!catalog.versions.includes(targetVersion))
            throw new BadRequestException(
                `version "${targetVersion}" is not in the ${agent.framework} catalog`
            )
        await this.assertVersionPolicy(
            agent.framework,
            targetVersion,
            runtime.frameworkVersion ?? null,
            isAdmin,
            catalog.blocked
        )

        return withRuntimeUpgradeLock(
            this.db,
            upgradeLockTarget(runtime, agent.framework),
            async () => {
                const shell = buildVersionInstallShell(
                    descriptor,
                    targetVersion,
                    descriptor.binary
                        ? await this.versions.releaseArtifacts(
                              agent.framework,
                              targetVersion
                          )
                        : null
                )
                this.log.log(
                    `upgrading ${agent.framework} on agent ${agent.id} to ${targetVersion}`
                )
                const exec = await this.execResolver.forRuntime(runtime, this.log)
                const result = await runOnRuntimeHost(
                    exec,
                    shell,
                    UPGRADE_TIMEOUT_MS
                )
                if (result.exitCode !== 0)
                    throw new InternalServerErrorException(
                        `framework upgrade install failed (exit ${result.exitCode}): ${result.stderr.slice(0, 512)}`
                    )

                // Daemons run a long-lived service off the upgraded binary; restart it
                // so the new version takes effect. env is unchanged so a plain restart
                // is safe (the env-not-propagated caveat only bites on env changes).
                if (
                    ctx.placement === 'sprites' &&
                    descriptor.runtimeKind === 'daemon' &&
                    descriptor.serviceName
                ) {
                    const { client, spriteName } =
                        await this.hostClients.spritesClientForHost(host)
                    await client.restartService(spriteName, descriptor.serviceName)
                }
                const recipe = podServiceRecipe(agent.framework)
                if (ctx.placement === 'k8s' && recipe)
                    await this.restartPodService(host, recipe)

                // Re-probe persists the new version. Assert it actually changed —
                // catches the case where a pre-installed binary still shadows the
                // freshly npm-installed one (see buildNpmUpgradeShell). Daemons whose
                // CLI has no `--version` report null; don't hard-fail those (install +
                // restart already succeeded), but a NON-null mismatch is still a hard
                // failure for every framework.
                const installed = await this.probe.probeAndPersist(agent)
                const verifiedOk =
                    installed === targetVersion ||
                    (installed === null && descriptor.runtimeKind === 'daemon')
                if (!verifiedOk)
                    throw new InternalServerErrorException(
                        `framework upgrade verification mismatch: expected ${targetVersion}, the host reports ${installed ?? 'unknown'}`
                    )

                return this.agents.get(agentId, callerUserId, isAdmin)
            }
        )
    }

    // Heavy "rebuild" upgrade: stop service → re-clone+build at the target tag
    // → start service → verify. Streams phase events via `emitter`.
    // A failed rebuild rolls back to the pre-upgrade app so the agent is never
    // bricked.
    async upgradeStreaming(
        agentId: string,
        callerUserId: string,
        targetVersion: string,
        isAdmin: boolean,
        emitter: FrameworkUpgradeEmitter
    ): Promise<AgentSummary> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        if (frameworkUpgradeMode(agent.framework) !== 'rebuild')
            throw new BadRequestException(
                `${agent.framework} does not use the streamed rebuild upgrade`
            )
        if (!isVersionedFramework(agent.framework))
            throw new BadRequestException(
                `${agent.framework} has no upgradeable framework version`
            )
        const framework = agent.framework
        const ctx = await this.hostedRuntime(agent)
        const { runtime, host } = ctx
        const podRecipe =
            ctx.placement === 'k8s' ? podServiceRecipe(framework) : undefined
        if (ctx.placement === 'k8s' && !podRecipe)
            throw new BadRequestException(
                `${framework} rebuild upgrade is not available on cloud computers`
            )
        const serviceName = frameworkVersionDescriptor(framework).serviceName
        if (!serviceName)
            throw new InternalServerErrorException(
                `${framework} descriptor missing serviceName`
            )
        const catalog = await this.versions.getForFramework(framework)
        const sourceRepo = catalog.sourceRepo
        // Blocked before "not in catalog": the denylist already removed the
        // release from `versions`, so without this the caller would be told the
        // version does not exist instead of why it is refused.
        this.assertNotBlocked(agent.framework, targetVersion, catalog.blocked)
        await this.assertPrereleaseAllowed(agent.framework, targetVersion)
        if (!catalog.versions.includes(targetVersion))
            throw new BadRequestException(
                `version "${targetVersion}" is not in the ${agent.framework} catalog`
            )
        if (
            !frameworkRepoCandidates(framework).some(
                (entry) => entry.repo === sourceRepo
            )
        )
            throw new ServiceUnavailableException(
                `${framework} version catalog has no admitted repository; refresh it before upgrading`
            )
        await this.assertVersionPolicy(
            agent.framework,
            targetVersion,
            runtime.frameworkVersion ?? null,
            isAdmin,
            catalog.blocked
        )

        if (podRecipe)
            return withRuntimeUpgradeLock(
                this.db,
                upgradeLockTarget(runtime, agent.framework),
                async () => {
                    await this.rebuildOnPod({
                        agent,
                        ctx,
                        recipe: podRecipe,
                        targetVersion,
                        sourceRepo,
                        emitter
                    })
                    return this.agents.get(agentId, callerUserId, isAdmin)
                }
            )

        return withRuntimeUpgradeLock(
            this.db,
            upgradeLockTarget(runtime, agent.framework),
            async () => {
                emitter.step('validating')
                const { client, spriteName } =
                    await this.hostClients.spritesClientForHost(host)
                // Carry the admitted snapshot through the lock/client awaits;
                // re-reading settings here could pair this tag with another repo.
                const shells = this.rebuildShellsFor(
                    agent.framework,
                    targetVersion,
                    sourceRepo,
                    this.spriteHomeFor(agent.framework)
                )
                // Dashboard topology: proxy + dashboard serve out of (and route to)
                // the checkout the rebuild is about to replace — stop them first and
                // bring them back after, rebuilding web_dist which vanishes with the
                // old checkout.
                const dashboardTopology =
                    framework === 'hermes' && runtime.dashboardEnabled

                emitter.step('stopping_service')
                if (dashboardTopology) {
                    await client
                        .stopService(spriteName, HERMES_PROXY_SERVICE)
                        .catch(() => undefined)
                    await client
                        .stopService(spriteName, HERMES_DASHBOARD_SERVICE)
                        .catch(() => undefined)
                }
                await client
                    .stopService(spriteName, serviceName)
                    .catch(() => undefined)

                emitter.step('rebuilding')
                const rebuild = await execSprite(client, spriteName, {
                    cmd: ['bash', '-lc', shells.rebuild],
                    stdin: '',
                    timeoutMs: REBUILD_TIMEOUT_MS
                })
                if (rebuild.exitCode !== 0) {
                    // roll back to the pre-upgrade checkout, bring the old version back up
                    await execSprite(client, spriteName, {
                        cmd: ['bash', '-lc', shells.restore],
                        stdin: '',
                        timeoutMs: RESTORE_TIMEOUT_MS
                    }).catch(() => undefined)
                    await client
                        .startService(spriteName, serviceName)
                        .catch(() => undefined)
                    if (dashboardTopology) {
                        // Restored checkout still has its web_dist; just restart the
                        // stopped services so chat routing (proxy) comes back.
                        await client
                            .startService(spriteName, HERMES_DASHBOARD_SERVICE)
                            .catch(() => undefined)
                        await client
                            .startService(spriteName, HERMES_PROXY_SERVICE)
                            .catch(() => undefined)
                    }
                    throw new InternalServerErrorException(
                        `${agent.framework} rebuild failed (exit ${rebuild.exitCode}): ${rebuild.stderr.slice(0, 512)}`
                    )
                }

                emitter.step('starting_service')
                const state = await client.startService(spriteName, serviceName)
                if (state.state.status === 'failed')
                    throw new InternalServerErrorException(
                        `${agent.framework} service failed to start after upgrade: ${state.state.error ?? 'unknown'}`
                    )
                if (dashboardTopology) {
                    // The new checkout ships no web_dist — rebuild it, then bring the
                    // dashboard + proxy back. The proxy is started even if the UI
                    // build failed: it owns the public http_port, so chat routing
                    // must recover regardless; a dist-less dashboard just 404s.
                    const uiBuild = await execSprite(client, spriteName, {
                        cmd: ['bash', '-lc', HERMES_WEB_BUILD_SHELL],
                        stdin: '',
                        timeoutMs: HERMES_WEB_BUILD_TIMEOUT_MS
                    }).catch((err: unknown) => ({
                        exitCode: -1,
                        stderr: (err as Error).message
                    }))
                    await client
                        .startService(spriteName, HERMES_DASHBOARD_SERVICE)
                        .catch(() => undefined)
                    const proxyState = await client.startService(
                        spriteName,
                        HERMES_PROXY_SERVICE
                    )
                    if (proxyState.state.status === 'failed')
                        throw new InternalServerErrorException(
                            `hermes front proxy failed to start after upgrade: ${proxyState.state.error ?? 'unknown'}`
                        )
                    if (uiBuild.exitCode !== 0)
                        throw new InternalServerErrorException(
                            `hermes web UI rebuild failed after upgrade (exit ${uiBuild.exitCode}): ${uiBuild.stderr.slice(0, 512)}`
                        )
                }

                emitter.step('verifying')
                const installed = await this.probe.probeAndPersist(agent)
                // probe reports the git tag (e.g. 1.8.3 / 2026.6.5 / 1.15.1-rc.1); target
                // may carry a leading v. Precedence-aware, or a rebuild asked for a
                // prerelease and handed back its stable release would verify clean.
                if (
                    installed !== null &&
                    compareSemverPrecedence(installed, targetVersion) !== 0
                )
                    throw new InternalServerErrorException(
                        `${agent.framework} upgrade verification mismatch: expected ${targetVersion}, sprite reports ${installed}`
                    )

                return this.agents.get(agentId, callerUserId, isAdmin)
            }
        )
    }

    // Per-framework rebuild + rollback shells for the streamed upgrade. Both
    // re-clone the app at the target tag and rebuild; on failure the caller runs
    // `restore` to bring the pre-upgrade checkout back. Any 'rebuild'-mode
    // framework not wired here fails loud rather than silently no-op'ing.
    // `home` is the framework's home on the host being rebuilt.
    private rebuildShellsFor(
        framework: AgentFramework,
        targetVersion: string,
        repo: string | null,
        home: string
    ): { rebuild: string; restore: string } {
        // hermes pipes NousResearch's install.sh, which clones a repository
        // named inside that script, so `repo` cannot steer it — which is why
        // hermes is held to a single candidate.
        if (framework === 'hermes')
            return {
                rebuild: buildHermesRebuildShell(targetVersion, home),
                restore: buildHermesRestoreShell(home)
            }
        const shells = this.extensions.get(framework)?.version?.rebuildShells
        if (!shells)
            throw new BadRequestException(
                `${framework} rebuild upgrade is not implemented yet`
            )
        if (!repo)
            throw new InternalServerErrorException(
                `no ${framework} repository could be resolved`
            )
        return shells({ version: targetVersion, repo, home })
    }

    // A framework's home on a sandbox: hermes's own, or the one an edition's
    // sprite service declares.
    private spriteHomeFor(framework: AgentFramework): string {
        if (framework === 'hermes') return SPRITE_HERMES_HOME
        const home =
            this.extensions.get(framework)?.spriteService?.supervision.homeDir
        if (!home)
            throw new BadRequestException(
                `${framework} rebuild upgrade is not implemented yet`
            )
        return home
    }

    // A rebuilt service framework on a pod host: its daemon stops the
    // service, the checkout is replaced (restored on failure), and the service
    // comes back up before the version is read back (ADR-0035).
    private async rebuildOnPod(args: {
        agent: Agent
        ctx: HostedRuntime
        recipe: PodServiceRecipe
        targetVersion: string
        sourceRepo: string | null
        emitter: FrameworkUpgradeEmitter
    }): Promise<void> {
        const { agent, ctx, recipe, emitter } = args
        if (!this.podServices)
            throw new ServiceUnavailableException(
                'cloud computer services are not available'
            )
        const host = ctx.host
        const exec = await this.execResolver.forRuntime(ctx.runtime, this.log)
        emitter.step('validating')
        const shells = this.rebuildShellsFor(
            agent.framework,
            args.targetVersion,
            args.sourceRepo,
            recipe.home
        )
        emitter.step('stopping_service')
        await this.podServices.stop(host, recipe.serviceName)
        emitter.step('rebuilding')
        const rebuild = await runOnRuntimeHost(
            exec,
            shells.rebuild,
            REBUILD_TIMEOUT_MS
        )
        if (rebuild.exitCode !== 0) {
            await runOnRuntimeHost(
                exec,
                shells.restore,
                RESTORE_TIMEOUT_MS
            ).catch(() => undefined)
            await this.podServices
                .start(host, recipe.serviceName)
                .catch(() => undefined)
            throw new InternalServerErrorException(
                `${agent.framework} rebuild failed (exit ${rebuild.exitCode}): ${rebuild.stderr.slice(0, 512)}`
            )
        }
        emitter.step('starting_service')
        await this.podServices.start(host, recipe.serviceName)
        await this.podServices.waitHealthy(
            host,
            recipe.serviceName,
            POD_SERVICE_READY_TIMEOUT_MS
        )
        emitter.step('verifying')
        const installed = await this.probe.probeAndPersist(agent)
        if (
            installed !== null &&
            compareSemverPrecedence(installed, args.targetVersion) !== 0
        )
            throw new InternalServerErrorException(
                `${agent.framework} upgrade verification mismatch: expected ${args.targetVersion}, the host reports ${installed}`
            )
    }

    private async restartPodService(
        host: RuntimeHostRow,
        recipe: PodServiceRecipe
    ): Promise<void> {
        if (!this.podServices) return
        await this.podServices.restart(host, recipe.serviceName)
        await this.podServices.waitHealthy(
            host,
            recipe.serviceName,
            POD_SERVICE_READY_TIMEOUT_MS
        )
    }

    // A release inside a broken window is never installable, by anyone: an
    // admin override here would just reproduce the incident it exists to stop.
    private assertNotBlocked(
        framework: AgentFramework,
        targetVersion: string,
        blocked: FrameworkBlockedVersionRange[]
    ): void {
        const range = findBlockedVersionRange(targetVersion, blocked)
        if (range)
            throw new BadRequestException(
                blockedVersionMessage(framework, targetVersion, range)
            )
    }

    // Runs before the target∈catalog check for the same reason assertNotBlocked
    // does: withPolicy has already withheld prereleases when the opt-in is off,
    // so without this the caller would be told the version does not exist rather
    // than which switch to flip.
    private async assertPrereleaseAllowed(
        framework: AgentFramework,
        targetVersion: string
    ): Promise<void> {
        if (!isPrereleaseVersion(targetVersion)) return
        const settings =
            await this.adminSettings.getCachedFrameworkDefaultVersions()
        if (frameworkPrereleaseAllowed(framework, settings)) return
        throw new BadRequestException(
            `version "${targetVersion}" is a pre-release; enable pre-release versions for ${framework} first`
        )
    }

    // Enforce the admin framework-version policy: the minimum supported version
    // is a hard floor for everyone; the per-framework downgrade gate exempts
    // admins (their escape hatch). Runs after the target∈catalog check.
    //
    // Both comparisons are precedence-aware, so `1.15.1-rc.1` reads as below a
    // `1.15.1` floor and as a downgrade from an installed `1.15.1` — which is
    // what semver says and what an operator setting either policy means.
    private async assertVersionPolicy(
        framework: AgentFramework,
        targetVersion: string,
        installedVersion: string | null,
        isAdmin: boolean,
        blocked: FrameworkBlockedVersionRange[]
    ): Promise<void> {
        const policy =
            await this.adminSettings.getCachedFrameworkDefaultVersions()
        const min = policy.minVersions[framework]
        if (min && compareSemverPrecedence(targetVersion, min) === -1)
            throw new BadRequestException(
                `version "${targetVersion}" is below the minimum supported version ${min} for ${framework}`
            )
        // Escaping a blocked install is a downgrade whenever the fix ships
        // below what's running (#594: 0.53.1 -> 0.52.0). Holding a user on a
        // broken CLI to honour the downgrade gate would strand them, so the
        // gate yields when the installed version is itself blocked.
        if (
            !isAdmin &&
            policy.allowDowngrade[framework] === false &&
            installedVersion &&
            !findBlockedVersionRange(installedVersion, blocked) &&
            compareSemverPrecedence(targetVersion, installedVersion) === -1
        )
            throw new BadRequestException(
                `downgrading ${framework} below the installed version ${installedVersion} is not allowed`
            )
    }

    // The agent's runtime on a hosted machine (ADR-0037); a local machine's
    // CLI is the user's own to upgrade.
    private async hostedRuntime(agent: Agent): Promise<HostedRuntime> {
        const ctx = await this.runtimeContext.forRuntime(agent.runtimeId)
        if (!ctx || !ctx.host || !hostsFrameworkCli(ctx.placement))
            throw new BadRequestException(
                'framework upgrade is only supported on sprites and cloud computers'
            )
        if (ctx.host.status !== 'ready')
            throw new BadRequestException(
                `the machine is ${ctx.host.status}; retry once it is ready`
            )
        return ctx as HostedRuntime
    }
}
