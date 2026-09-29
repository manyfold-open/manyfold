import {
    AgentFramework,
    AgentSummary,
    FrameworkBlockedVersionRange,
    FrameworkUpgradeStep,
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
import {
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
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
import { HostDaemonAccess } from '@/modules/agents/adapters/host-daemon-access'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import {
    hostsFrameworkCli,
    runOnRuntimeHost,
    upgradeLockTarget
} from './runtime-host-shell'
import { HostServices } from '@/modules/agent-runtimes/provisioning/host-services'
import {
    serviceFrameworkRecipe,
    type ServiceFrameworkRecipe
} from '@/modules/agents/bootstrap/service-frameworks'
import {
    buildHermesRebuildShell,
    buildHermesRestoreShell,
    HERMES_WEB_BUILD_TIMEOUT_MS,
    hermesWebBuildShell
} from '@/modules/agents/bootstrap/hermes-shared'

// npm installs of the coding-agent CLIs can take a while (claude-code is a
// large package); keep the synchronous exec window generous.
const UPGRADE_TIMEOUT_MS = 180_000
// A git rebuild (clone + dependency sync + frontend build) measured 5–7 min in
// the probe; cap at 15 min for slow mirrors (matches the bootstrap install
// timeout).
const REBUILD_TIMEOUT_MS = 900_000
const RESTORE_TIMEOUT_MS = 120_000

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
        private readonly hostServices: HostServices,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry(),
        // Appended last + @Optional; present, a sandbox is held awake for the
        // whole upgrade.
        @Optional() private readonly hostAccess?: HostDaemonAccess
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

        return this.held(host, () => withRuntimeUpgradeLock(
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

                // A service framework runs off the upgraded binary: the
                // host's daemon restarts it so the new version takes effect.
                const recipe = serviceFrameworkRecipe(agent.framework)
                if (recipe) await this.restartService(runtime, host, recipe)

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
        ))
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
        const recipe = serviceFrameworkRecipe(framework)
        if (!recipe)
            throw new BadRequestException(
                `${framework} rebuild upgrade is not available on this machine`
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

        return this.held(host, () =>
            withRuntimeUpgradeLock(
                this.db,
                upgradeLockTarget(runtime, agent.framework),
                async () => {
                    await this.rebuildOnHost({
                        agent,
                        ctx,
                        recipe,
                        targetVersion,
                        sourceRepo,
                        emitter
                    })
                    return this.agents.get(agentId, callerUserId, isAdmin)
                }
            )
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

    // A rebuilt service framework: the host's daemon stops its services, the
    // checkout is replaced (restored on failure), and the services come back
    // up before the version is read back. The hermes dashboard serves out of
    // the checkout the rebuild replaces, so its services stop first and its
    // web UI is built again for the new checkout; the front proxy comes back
    // even when that build fails, since it holds the public URL.
    private async rebuildOnHost(args: {
        agent: Agent
        ctx: HostedRuntime
        recipe: ServiceFrameworkRecipe
        targetVersion: string
        sourceRepo: string | null
        emitter: FrameworkUpgradeEmitter
    }): Promise<void> {
        const { agent, ctx, recipe, emitter } = args
        const { host, runtime } = ctx
        const exec = await this.execResolver.forRuntime(runtime, this.log)
        emitter.step('validating')
        const home = recipe.home(this.hostServices.serviceHost(host).home)
        const shells = this.rebuildShellsFor(
            agent.framework,
            args.targetVersion,
            args.sourceRepo,
            home
        )
        const running = new Set(
            (await this.hostServices.list(host))
                .filter((s) => s.state !== 'stopped')
                .map((s) => s.name)
        )
        const companions = recipe.companionNames.filter((name) =>
            running.has(name)
        )
        emitter.step('stopping_service')
        for (const name of [...companions].reverse())
            await this.hostServices.stop(host, name)
        await this.hostServices.stop(host, recipe.serviceName)
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
            for (const name of [recipe.serviceName, ...companions])
                await this.hostServices.start(host, name).catch(() => undefined)
            throw new InternalServerErrorException(
                `${agent.framework} rebuild failed (exit ${rebuild.exitCode}): ${rebuild.stderr.slice(0, 512)}`
            )
        }
        emitter.step('starting_service')
        await this.hostServices.start(host, recipe.serviceName)
        await this.hostServices.waitHealthy(host, recipe.serviceName)
        if (companions.length > 0) {
            const uiBuild = await runOnRuntimeHost(
                exec,
                hermesWebBuildShell(home),
                HERMES_WEB_BUILD_TIMEOUT_MS
            ).catch((err: unknown) => ({
                exitCode: -1,
                stdout: '',
                stderr: (err as Error).message
            }))
            for (const name of companions)
                await this.hostServices.start(host, name)
            if (uiBuild.exitCode !== 0)
                throw new InternalServerErrorException(
                    `hermes web UI rebuild failed after upgrade (exit ${uiBuild.exitCode}): ${uiBuild.stderr.slice(0, 512)}`
                )
        }
        await this.hostServices.markReady(runtime)
        emitter.step('verifying')
        const installed = await this.probe.probeAndPersist(agent)
        // The probe reports the tag (1.8.3 / 2026.6.5 / 1.15.1-rc.1); the
        // target may carry a leading v. Precedence-aware, or a rebuild asked
        // for a prerelease and handed back its stable release would verify
        // clean.
        if (
            installed !== null &&
            compareSemverPrecedence(installed, args.targetVersion) !== 0
        )
            throw new InternalServerErrorException(
                `${agent.framework} upgrade verification mismatch: expected ${args.targetVersion}, the host reports ${installed}`
            )
    }

    private async restartService(
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow,
        recipe: ServiceFrameworkRecipe
    ): Promise<void> {
        await this.hostServices.restart(host, recipe.serviceName)
        await this.hostServices.waitHealthy(host, recipe.serviceName)
        await this.hostServices.markReady(runtime)
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

    // The whole upgrade runs under the machine's awake hold (ADR-0038). A
    // command holds it only while it runs, and the service calls between
    // commands — the restart after an install, a rebuild's stop and start —
    // are no activity to a sprite: released, the machine froze under them.
    // Seen on staging [2026-09-28]: a hermes rebuild finished, then its
    // startService timed out after 15s and left the service down.
    private async held<T>(
        host: RuntimeHostRow,
        work: () => Promise<T>
    ): Promise<T> {
        if (!this.hostAccess) return work()
        const hold = this.hostAccess.hold(host, 'framework-upgrade')
        try {
            await hold.settled
            return await work()
        } finally {
            void hold.release()
        }
    }
}
