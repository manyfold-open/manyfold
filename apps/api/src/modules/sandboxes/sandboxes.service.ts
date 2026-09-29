import {
    auditAction,
    cliChannelOfVersion,
    createObjectId,
    daemonOnline,
    isAwakeHoldTaskName,
    isCliUpdateAvailable,
    isPlatformTaskName,
    isPlatformServiceName,
    parseProbedSemver,
    isVersionedFramework,
    resolveFrameworkRepo,
    supportsRuntime,
    DAEMON_FEATURE_HERDR_AGY,
    DAEMON_FEATURE_HERDR_PI,
    DAEMON_FEATURE_HERDR_TERMINAL,
    DAEMON_DETECTABLE_FRAMEWORKS,
    SANDBOX_PREINSTALLED_FRAMEWORKS,
    frameworkCapability,
    herdrFrameworksFor
} from '@manyfold/shared'
import type {
    AgentRuntimeSummary,
    CreateSandboxBody,
    DetectedFramework,
    MfCliChannel,
    SandboxServiceSummary,
    SandboxStopResponse,
    SandboxSummary,
    SandboxTaskSummary,
    SetSandboxTerminalBody,
    SetSandboxTerminalModelCredentialsBody
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
    Optional
} from '@nestjs/common'
import {
    agentCredentials,
    auditLogs,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    AgentRuntimesService,
    type SandboxHostView
} from '@/modules/agent-runtimes/agent-runtimes.service'
import { HostedHostLifecycleService } from '@/modules/agent-runtimes/hosted-host-lifecycle.service'
import { providerRefLabel } from '@/modules/agent-runtimes/host-ref'
import { HostServices } from '@/modules/agent-runtimes/provisioning/host-services'
import {
    HostKeepAwakeService,
    KEEP_AWAKE_TTL_SEC
} from '@/modules/hosts/host-keep-awake.service'
import { DRIZZLE } from '@/db/tokens'
import { withRuntimeUpgradeLock } from '@/common/runtime-upgrade-lock'
import { HostPowerSyncService } from '@/modules/agents/sprite-status/host-power-sync.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { HostPlacementService } from '@/modules/hosts/providers/host-placement.service'
import {
    HostProviderResolver,
    type ResolvedHostProvider
} from '@/modules/hosts/providers/host-provider-resolver.service'
import {
    AwakeLeaseStillHeldError,
    type AwakeLease,
    type ProviderCall,
    type ProviderService
} from '@/modules/hosts/providers/sandbox-provider'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    type HostExecResult,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import { HostSessionRegistry } from '@/modules/agents/host-sessions/host-sessions.registry'
import {
    buildNpmLatestInstallShell,
    buildNpmUpgradeShell,
    frameworkVersionDescriptor
} from '@/modules/framework-versions/framework-version-registry'
import { FrameworkVersionsService } from '@/modules/framework-versions/framework-versions.service'
import {
    DaemonCliVersionService,
    type LatestCliVersion
} from '@/modules/daemon/daemon-cli-version.service'
import { CliVersionCatalogService } from '@/modules/daemon/cli-version-catalog.service'
import { HerdrVersionService } from '@/modules/daemon/herdr-version.service'
import { recordProbedEntries } from '@/modules/daemon/probed-inventory'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    HostCliService,
    updatesItself
} from '@/modules/hosts/bring-up/host-cli.service'

const DETECT_TIMEOUT_MS = 30_000
const DAEMON_UPDATE_RPC_TIMEOUT_MS = 60_000
// How long the hold outlasts daemon.update for the successor's first
// heartbeat, 3s a poll. Measured on staging [2026-09-28]: over 35 sandboxes
// the new version was reported 5s after the ack at the median, 25s at p90,
// 47s at most.
const CLI_SUCCESSOR_POLLS = 30
const FRAMEWORK_INSTALL_TIMEOUT_MS = 180_000
// How long a stopped sprite takes to read as asleep once nothing holds it
// awake. Measured on staging [2026-09-27]: a sprite with no exec and no task
// suspended about 1s after the last one. Measured on local [2026-09-28]: a
// dev-org sprite ran on for 10–13s. The status sync's 3s fast cadence comes
// on top before the listing shows it.
const SPRITES_AUTO_SLEEP_SEC = 16

export const SANDBOX_DAEMON_OFFLINE_CODE = 'SANDBOX_DAEMON_OFFLINE'

// One probe for everything a sandbox can host: each framework's own version
// probe (the one an agent's version refresh runs), the mf CLI's and herdr's.
// Shared by the post-install re-probe and the probe a user asks for, so
// "installed" always looks the same.
const frameworkProbeShell = (): string =>
    [
        ...DAEMON_DETECTABLE_FRAMEWORKS.map(
            (f) =>
                `echo "${f}=$( (${frameworkVersionDescriptor(f).probeShell}) 2>/dev/null | head -1)"`
        ),
        'export PATH="$HOME/.local/bin:$PATH"',
        'echo "mf=$(mf --version 2>/dev/null | head -1)"',
        'echo "herdr=$(herdr --version 2>/dev/null | head -1)"'
    ].join('; ')

@Injectable()
export class SandboxesService {
    private readonly log = new Logger(SandboxesService.name)

    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly spritesProvisioner: SpritesProvisioner,
        private readonly placement: HostPlacementService,
        private readonly hostProviders: HostProviderResolver,
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly powerSync: HostPowerSyncService,
        private readonly activeDuration: SandboxActiveDurationService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly hostServices: HostServices,
        private readonly lifecycle: HostedHostLifecycleService,
        private readonly sessions: HostSessionRegistry,
        @Inject(DRIZZLE) private readonly db: Database,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means "install npm's latest" for a framework.
        @Optional()
        private readonly frameworkVersions?: FrameworkVersionsService,
        // Same convention: only prepareRuntime for a service framework needs
        // it, to store the gateway tokens the bootstrap generated.
        @Optional()
        private readonly crypto?: CryptoService,
        // Same convention; absent, no herdr update is offered.
        @Optional()
        private readonly herdrVersions?: HerdrVersionService,
        // Same convention; present, the machine is held awake and its daemon
        // brought up (R11, ADR-0037) for an operation instead of being refused.
        @Optional()
        private readonly hostAccess?: HostDaemonAccess,
        // Same convention; present, a CLI upgrade holds the machine until the
        // updated daemon reports.
        @Optional()
        private readonly hostCli?: HostCliService,
        // Same convention; absent, the switch is recorded and the keep-awake
        // reconcile (on the status-sync leader) brings the machine in line.
        @Optional()
        private readonly keepAwake?: HostKeepAwakeService
    ) {}

    private async latestHerdr(): Promise<string | null> {
        return (await this.herdrVersions?.getCachedLatest())?.version ?? null
    }

    async list(
        userId: string,
        isAdmin = false
    ): Promise<SandboxSummary[]> {
        const rows = isAdmin
            ? await this.runtimes.listAllSandboxes()
            : await this.runtimes.listSandboxesForUser(userId)
        const latest = await this.cliVersion.getCachedLatest()
        const latestHerdr = await this.latestHerdr()
        const activeSeconds =
            await this.activeDuration.activeSecondsInPeriodByHost(
                rows.map((r) => ({ id: r.host.id, userId: r.host.userId }))
            )
        return rows.map((r) =>
            toSandboxSummary(
                r,
                latest,
                activeSeconds.get(r.host.id) ?? 0,
                latestHerdr
            )
        )
    }

    async get(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const latest = await this.cliVersion.getCachedLatest()
        const latestHerdr = await this.latestHerdr()
        const activeSeconds =
            await this.activeDuration.activeSecondsInPeriodByHost([
                { id: r.host.id, userId: r.host.userId }
            ])
        return toSandboxSummary(
            r,
            latest,
            activeSeconds.get(r.host.id) ?? 0,
            latestHerdr
        )
    }

    private async requireSandbox(
        userId: string,
        hostId: string,
        isAdmin: boolean
    ): Promise<SandboxHostView> {
        const r = isAdmin
            ? await this.runtimes.getSandboxById(hostId)
            : await this.runtimes.getSandboxForUser(userId, hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        return r
    }

    // Admin paths address sandboxes across all users. We resolve the real owner
    // once, then drive the existing user-scoped mutations with that owner id so
    // their ownership checks pass without duplicating every query.
    private async resolveOwner(
        userId: string,
        hostId: string,
        isAdmin: boolean
    ): Promise<string> {
        if (!isAdmin) return userId
        const r = await this.runtimes.getSandboxById(hostId)
        if (!r) throw new NotFoundException(`sandbox ${hostId} not found`)
        return r.host.userId
    }

    // A new sandbox: placement picks the provider, the host row is inserted
    // as `provisioning` under the user's quota, and the provisioner creates
    // the machine and brings its daemon up. A failed bring-up leaves the row
    // `failed` with the reason; the user deletes it.
    async create(
        userId: string,
        body: CreateSandboxBody,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const provider = await this.placement.selectProvider({
            kind: 'sprites',
            providerId: body.providerId ?? null,
            callerIsAdmin: isAdmin
        })
        this.spritesProvisioner.assertSandboxCanReachApi()
        const host = await this.runtimeAccess.reserveStandaloneSandbox({
            userId,
            name: body.name,
            providerId: provider.id
        })
        try {
            await this.spritesProvisioner.provisionSandbox({ host })
        } catch (err) {
            const current = await this.hosts.findById(host.id)
            if (current?.status === 'provisioning')
                await this.hosts.setStatus(
                    host.id,
                    'failed',
                    (err as Error).message.slice(0, 512)
                )
            throw err
        }
        return this.get(userId, host.id, isAdmin)
    }

    // R8: refused while agents exist, else deleting → destroy → gone.
    async delete(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<void> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        await this.lifecycle.deleteHost(r.host.id)
    }

    async setTerminal(
        userId: string,
        hostId: string,
        body: SetSandboxTerminalBody,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        const ok = await this.runtimes.setSandboxTerminalEnabled(
            owner,
            hostId,
            body.enabled
        )
        if (!ok) throw new NotFoundException(`sandbox ${hostId} not found`)
        return this.get(owner, hostId)
    }

    async setTerminalModelCredentials(
        userId: string,
        hostId: string,
        body: SetSandboxTerminalModelCredentialsBody,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        const ok = await this.runtimes.setSandboxTerminalModelCredentials(
            owner,
            hostId,
            body.enabled
        )
        if (!ok) throw new NotFoundException(`sandbox ${hostId} not found`)
        return this.get(owner, hostId)
    }

    async rename(
        userId: string,
        hostId: string,
        name: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const owner = await this.resolveOwner(userId, hostId, isAdmin)
        const ok = await this.runtimes.setSandboxHostName(owner, hostId, name)
        if (!ok) throw new NotFoundException(`sandbox ${hostId} not found`)
        return this.get(owner, hostId)
    }

    // The host's keep-awake switch (ADR-0037 R7). The flag write is the
    // commitment (enable is quota-gated and atomic in enableKeepAlive); the
    // hold on the machine follows best-effort, and the keep-awake reconcile
    // converges a degraded toggle on its next tick, so the API returns the
    // committed flag even when the provider call fails.
    async setKeepAwake(
        userId: string,
        hostId: string,
        enabled: boolean,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const owner = r.host.userId
        if (r.host.status !== 'ready')
            throw new ConflictException({
                message: `sandbox ${hostId} is not ready`,
                code: 'SANDBOX_NOT_READY'
            })
        // Caps + lease are driven against the OWNER, not an admin caller.
        if (enabled) await this.runtimeAccess.enableKeepAlive({ userId: owner, hostId })
        else await this.runtimes.setHostKeepAwake(owner, hostId, false)
        const fresh = await this.hosts.findById(hostId)
        if (!fresh) throw new NotFoundException(`sandbox ${hostId} not found`)
        const outcome = await this.keepAwake?.converge(fresh)
        if (outcome?.state === 'failed')
            this.log.warn(
                `keep-awake ${enabled ? 'enable' : 'disable'} degraded for host ${hostId}: ${outcome.message}`
            )
        return this.get(owner, hostId)
    }

    // The daemon's own inventory is the sandbox's framework list (R3): the
    // heartbeat keeps it current, and this folds the versions it reports into
    // the runtimes installed on the host.
    async detectFrameworks(
        userId: string,
        hostId: string,
        isAdmin = false,
        opts: { probe?: boolean } = {}
    ): Promise<SandboxSummary> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        if (opts.probe) return this.probeFrameworks(r)
        if (r.daemon)
            await this.runtimes.applyDetectedVersionsToHostRuntimes(
                hostId,
                r.daemon.detectedFrameworks
            )
        return this.get(r.host.userId, hostId)
    }

    // The detect a user asks for: every framework probed now, through the
    // daemon, instead of the inventory it last reported (it re-detects only
    // every few minutes, and not while the sandbox sleeps). The answers are
    // recorded as probed, so the daemon's cached report cannot write an older
    // one back (probed-inventory). Wakes the sandbox.
    private async probeFrameworks(r: SandboxHostView): Promise<SandboxSummary> {
        const { host } = r
        return this.withSandboxDaemon(
            r,
            'detect-frameworks',
            async (session) => {
                const { daemon } = session
                const probed = await this.daemonExec(session)({
                    cmd: ['bash', '-lc', frameworkProbeShell()],
                    stdin: '',
                    timeoutMs: DETECT_TIMEOUT_MS
                }).catch((err: Error) => {
                    throw new ServiceUnavailableException(
                        `framework probe failed: ${err.message}`
                    )
                })
                const probe = parseSpriteFrameworkProbe(
                    `${probed.stdout}\n${probed.stderr}`
                )
                await this.hostDaemons.patch(host.id, {
                    detectedFrameworks: recordProbedEntries(
                        daemon.detectedFrameworks,
                        probe.frameworks,
                        new Date()
                    )
                })
                await this.runtimes.applyDetectedVersionsToHostRuntimes(
                    host.id,
                    probe.frameworks
                )
                return this.get(host.userId, host.id)
            }
        )
    }

    // On-demand refresh of the sandbox's provider power state, backing the
    // host detail "Refresh" button. The periodic sync lags (up to 30s while
    // suspended); this reads the sprite directly and persists it, so the
    // returned summary carries the fresh state.
    async refreshStatus(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        if (r.host.providerRef)
            await this.powerSync
                .refreshHost(r.host)
                .catch((err: Error) => {
                    throw new ServiceUnavailableException(
                        `failed to refresh sandbox status: ${err.message}`
                    )
                })
        return this.get(r.host.userId, hostId)
    }

    // Everything inside the machine goes through its daemon (R6), and every
    // operation on it runs under the machine's awake hold with the daemon
    // brought up when it is not connected (R11, ADR-0037).
    private async withSandboxDaemon<T>(
        r: SandboxHostView,
        reason: string,
        work: (session: HostSession) => Promise<T>
    ): Promise<T> {
        if (!this.hostAccess)
            throw new ServiceUnavailableException({
                message: `sandbox ${r.host.id} has no daemon online`,
                code: SANDBOX_DAEMON_OFFLINE_CODE
            })
        try {
            return await this.hostAccess.withHost(
                { host: r.host, daemon: r.daemon, placement: 'sprites', reason },
                work
            )
        } catch (err) {
            if (!(err instanceof HostDaemonOfflineError)) throw err
            throw new ServiceUnavailableException({
                message: err.message,
                code: SANDBOX_DAEMON_OFFLINE_CODE,
                hostId: r.host.id,
                reason: err.reason
            })
        }
    }

    private upgradeLockKey(
        host: RuntimeHostRow,
        component: string
    ): { hostId: string; component: string } {
        return { hostId: host.id, component }
    }

    // Upgrade the mf CLI on the sandbox through the daemon's own updater
    // (ADR-0029 §5): it downloads, prechecks, swaps and rolls back on its own,
    // then exits for its supervised loop to start the new binary (a daemon an
    // older bring-up started by hand hands off to a successor instead). The
    // version it lands on reaches host_daemons through its next heartbeat.
    async upgradeCli(
        userId: string,
        hostId: string,
        targetVersion?: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        // No target = the deploy channel's latest. A pinned target must be a
        // version we actually list, and its channel comes from the version
        // string (so a dev build installs from the dev CDN).
        let channel: MfCliChannel
        if (targetVersion) {
            if (!(await this.cliCatalog.isInstallableVersion(targetVersion)))
                throw new BadRequestException(
                    `unknown mf CLI version ${targetVersion}`
                )
            channel = cliChannelOfVersion(targetVersion)
        } else {
            channel = (await this.cliVersion.getCachedLatest()).channel
        }
        return this.withSandboxDaemon(r, 'upgrade-cli', async (session) => {
            if (!updatesItself(session.daemon))
                throw new ConflictException({
                    message:
                        'the sandbox daemon cannot update itself; it is below the supported floor',
                    code: 'SANDBOX_DAEMON_TOO_OLD'
                })
            return withRuntimeUpgradeLock(
                this.db,
                this.upgradeLockKey(host, 'mf-cli'),
                async () => {
                    const payload: Record<string, unknown> = { channel }
                    if (targetVersion) payload.targetVersion = targetVersion
                    const before = session.daemon.cliVersion
                    const ack = await session
                        .rpc({
                            method: 'daemon.update',
                            payload,
                            timeoutMs: DAEMON_UPDATE_RPC_TIMEOUT_MS
                        })
                        .catch((err: Error) => {
                            throw new ServiceUnavailableException(
                                `mf CLI upgrade failed: ${err.message}`
                            )
                        })
                    const toVersion =
                        typeof ack?.toVersion === 'string' ? ack.toVersion : null
                    this.log.log(
                        `sandbox cli upgrade via daemon.update host=${hostId} to=${toVersion ?? targetVersion ?? 'latest'} deferred=${ack?.deferred === true}`
                    )
                    // The daemon hands off to its successor and exits, which is
                    // no platform activity: released on the ack, the machine
                    // froze before the successor dialed in, and the sandbox
                    // read the old CLI until its next wake. Seen on staging
                    // [2026-09-28]: daemon.log had the handoff while
                    // host_daemons kept the old version.
                    if (ack?.restarting === true && this.hostCli) {
                        const back = await this.hostCli.awaitSuccessor(
                            host,
                            before,
                            CLI_SUCCESSOR_POLLS
                        )
                        if (!back)
                            this.log.warn(
                                `sandbox cli upgrade host=${hostId}: the updated daemon did not report while held; it reports on the next wake`
                            )
                    }
                    return this.get(host.userId, hostId)
                }
            )
        })
    }

    // Install or upgrade herdr inside the sandbox (ADR-0031) through the
    // daemon's `herdr.update`; the version it lands on reaches host_daemons
    // through the daemon's next heartbeat.
    async upgradeHerdr(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        return this.withSandboxDaemon(r, 'upgrade-herdr', async (session) => {
            if (
                !session.daemon.clientFeatures.includes(
                    DAEMON_FEATURE_HERDR_TERMINAL
                )
            )
                throw new ConflictException({
                    message:
                        'the sandbox daemon cannot install herdr; update the mf CLI first',
                    code: 'SANDBOX_DAEMON_TOO_OLD'
                })
            return withRuntimeUpgradeLock(
                this.db,
                this.upgradeLockKey(host, 'herdr'),
                async () => {
                    const ack = await session
                        .rpc({
                            method: 'herdr.update',
                            payload: {},
                            timeoutMs: DAEMON_UPDATE_RPC_TIMEOUT_MS
                        })
                        .catch((err: Error) => {
                            throw new ServiceUnavailableException(
                                `herdr install failed: ${err.message}`
                            )
                        })
                    this.log.log(
                        `sandbox herdr upgrade via herdr.update host=${hostId} to=${typeof ack?.toVersion === 'string' ? ack.toVersion : 'unknown'}`
                    )
                    return this.get(host.userId, hostId)
                }
            )
        })
    }

    // Install (or move to a version of) one of the sprite image's coding CLIs
    // on a sandbox that has no runtime for it yet, so the create form can show
    // and fix the framework before the agent exists. Same staged npm shell as
    // the agent-level upgrade, run through the host daemon: the candidate is
    // validated in its own prefix and swapped in atomically, so a failed
    // install never breaks the CLI on PATH. No target = the catalog's latest;
    // with no catalog at all, npm's own latest minus the known-broken releases.
    async installFramework(
        userId: string,
        hostId: string,
        framework: string,
        targetVersion?: string,
        isAdmin = false
    ): Promise<SandboxSummary> {
        if (
            !isVersionedFramework(framework) ||
            !SANDBOX_PREINSTALLED_FRAMEWORKS.includes(
                framework as DetectedFramework['framework']
            )
        )
            throw new BadRequestException(
                `${framework} cannot be installed on a sandbox`
            )
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        const descriptor = frameworkVersionDescriptor(framework)
        const catalog = this.frameworkVersions
            ? await this.frameworkVersions.getForFramework(framework)
            : null
        const target =
            targetVersion?.trim().replace(/^v/, '') || catalog?.latest || null
        if (target && catalog && !catalog.versions.includes(target))
            throw new BadRequestException(
                `version "${target}" is not in the ${framework} catalog`
            )
        const shell = target
            ? buildNpmUpgradeShell(descriptor, target)
            : buildNpmLatestInstallShell(descriptor)
        return this.withSandboxDaemon(r, `install-${framework}`, (session) =>
            withRuntimeUpgradeLock(
            this.db,
            this.upgradeLockKey(host, framework),
            async () => {
                const { daemon } = session
                const exec = this.daemonExec(session)
                const result = await exec({
                    cmd: ['bash', '-lc', shell],
                    stdin: '',
                    timeoutMs: FRAMEWORK_INSTALL_TIMEOUT_MS
                }).catch((err: Error) => {
                    throw new ServiceUnavailableException(
                        `${framework} install failed: ${err.message}`
                    )
                })
                if (result.exitCode !== 0)
                    throw new ServiceUnavailableException(
                        `${framework} install failed (exit ${result.exitCode}): ${result.stderr.slice(0, 512)}`
                    )
                // Re-probe over the same seam and persist. The version has to
                // be there now: a pre-installed binary still shadowing the
                // fresh one is exactly what the staged shell guards against, so
                // a mismatch is a failure, not a note.
                const probed = await exec({
                    cmd: ['bash', '-lc', frameworkProbeShell()],
                    stdin: '',
                    timeoutMs: DETECT_TIMEOUT_MS
                })
                const probe = parseSpriteFrameworkProbe(
                    `${probed.stdout}\n${probed.stderr}`
                )
                const installed =
                    probe.frameworks.find((f) => f.framework === framework)
                        ?.version ?? null
                if (!installed || (target && installed !== target))
                    throw new ServiceUnavailableException(
                        `${framework} install did not complete on ${providerRefLabel(host) ?? host.id}: sandbox reports ${installed ?? 'nothing'}`
                    )
                // The probe's answer goes in now, stamped: the daemon re-reports
                // its cached inventory with every heartbeat and re-detects only
                // every few minutes (probed-inventory).
                const others = daemon.detectedFrameworks.filter(
                    (f) =>
                        !SANDBOX_PREINSTALLED_FRAMEWORKS.includes(f.framework)
                )
                await this.hostDaemons.patch(host.id, {
                    detectedFrameworks: recordProbedEntries(
                        others,
                        probe.frameworks,
                        new Date()
                    ),
                    ...(probe.cliVersion ? { cliVersion: probe.cliVersion } : {})
                })
                await this.runtimes.applyDetectedVersionsToHostRuntimes(
                    hostId,
                    probe.frameworks
                )
                this.log.log(
                    `sandbox framework installed host=${hostId} framework=${framework} version=${installed}`
                )
                return this.get(host.userId, hostId)
            }
            )
        )
    }

    // Bring a framework up on a sandbox that has no agent for it yet, as an
    // agent-less runtime: a coding CLI is installed (or left as found) and gets
    // its runtime row, which is what the create form's account list needs to
    // add a subscription before any agent exists; a service framework is
    // installed and started, its provider filled in by the first agent's pick.
    // The first agent joins through the attach path like any later one.
    // Idempotent: a live runtime for the framework on this host is returned.
    async prepareRuntime(
        userId: string,
        hostId: string,
        framework: string,
        isAdmin = false
    ): Promise<AgentRuntimeSummary> {
        if (
            !isVersionedFramework(framework) ||
            !supportsRuntime(framework, 'sprites')
        )
            throw new BadRequestException(
                `${framework} cannot run on a sandbox`
            )
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        if (host.status !== 'ready' || !host.providerRef)
            throw new BadRequestException('sandbox is not provisioned')
        const existing = await this.runtimes.findRuntimeOnHost(
            hostId,
            framework,
            host.userId
        )
        if (existing && existing.status !== 'failed')
            return this.runtimes.toSummary(existing)
        const coding = SANDBOX_PREINSTALLED_FRAMEWORKS.includes(
            framework as DetectedFramework['framework']
        )
        if (!coding && !this.crypto)
            throw new ServiceUnavailableException(
                `${framework} cannot be prepared here: credential storage is not wired`
            )
        // A CLI the sandbox already reports is registered as found; moving it
        // to another version is the icon menu's explicit Upgrade, never a side
        // effect of picking the sandbox in the create form. Only an absent
        // CLI (or a service framework) gets the version agent create would.
        const detected = (r.daemon?.detectedFrameworks ?? []).some(
            (f) => f.framework === framework
        )
        if (!this.frameworkVersions && resolveFrameworkRepo(framework))
            throw new ServiceUnavailableException(
                `${framework} cannot be prepared without its version catalog`
            )
        const version =
            coding && detected
                ? null
                : this.frameworkVersions
                  ? await this.frameworkVersions.resolveInstallVersion(
                        framework
                    )
                  : null
        const prepared = await this.spritesProvisioner.prepareRuntime({
            userId: host.userId,
            framework,
            hostId,
            frameworkVersion: version?.selection.version ?? null,
            frameworkVersionSource: version?.selection.source ?? 'none',
            frameworkRepo: version?.repo ?? null,
            frameworkArtifacts: version?.artifacts ?? null
        })
        if (prepared.generatedCredentials && this.crypto) {
            // The gateway tokens the bootstrap minted are the only way to reach
            // the service; without the row the first agent could not attach.
            const enc = this.crypto.encrypt(
                JSON.stringify(prepared.generatedCredentials)
            )
            await this.db.insert(agentCredentials).values({
                id: createObjectId('agentCredential'),
                runtimeId: prepared.runtime.id,
                framework,
                payloadCiphertext: enc.ciphertext,
                keyVersion: enc.keyVersion
            })
        }
        this.log.log(
            `sandbox runtime prepared host=${hostId} framework=${framework} runtime=${prepared.runtime.id}`
        )
        return this.runtimes.toSummary(prepared.runtime)
    }

    // The services the sandbox provider's own supervisor keeps on the
    // machine. A service registered by the agent (e.g. an http.server serving
    // its workspace) keeps the VM running outside keep-awake accounting —
    // surfacing them here lets the owner see and remove the ones holding the
    // sprite awake.
    async listServices(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxServiceSummary[]> {
        const on = await this.requireProvisionedSandbox(userId, hostId, isAdmin)
        const services = await this.readServices(on)
        return services.map(toServiceSummary)
    }

    private async readServices(
        on: ResolvedHostProvider & { call: Omit<ProviderCall, 'generation'> }
    ): Promise<ProviderService[]> {
        if (!on.adapter.listServices) return []
        return on.adapter.listServices(on.call).catch((err: Error) => {
            throw new ServiceUnavailableException(
                `failed to list services: ${err.message}`
            )
        })
    }

    async deleteService(
        userId: string,
        hostId: string,
        name: string,
        isAdmin = false
    ): Promise<void> {
        // The daemon's loop (every framework service runs under it) and the
        // public port stub are platform infrastructure, never deletable
        // from this surface.
        if (isPlatformServiceName(name))
            throw new BadRequestException(
                `service '${name}' is managed by Manyfold and cannot be deleted`
            )
        const on = await this.requireProvisionedSandbox(userId, hostId, isAdmin)
        if (!on.adapter.removeService)
            throw new BadRequestException('this sandbox has no services')
        await on.adapter
            .removeService(on.call, name)
            .catch((err: Error) => {
                throw new ServiceUnavailableException(
                    `failed to delete service '${name}': ${err.message}`
                )
            })
    }

    // The machine's activity leases — the holds that keep it running; the
    // keep-awake switch places one of these. Reading them runs inside the
    // machine and would wake an idle one, but a held lease forces the running
    // state, so a machine that is not running has none by definition: the
    // read is skipped and never wakes a sleeping sandbox.
    async listTasks(
        userId: string,
        hostId: string,
        isAdmin = false
    ): Promise<SandboxTaskSummary[]> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        if (host.powerState !== 'running' || !host.providerRef) return []
        const leases = await this.readAwakeLeases(await this.onProvider(host))
        return leases.map((lease) => ({
            ...lease,
            keepAlive: isPlatformTaskName(lease.name)
        }))
    }

    private async readAwakeLeases(
        on: ResolvedHostProvider & { call: Omit<ProviderCall, 'generation'> }
    ): Promise<AwakeLease[]> {
        if (!on.adapter.listAwake) return []
        return on.adapter.listAwake(on.call).catch((err: Error) => {
            throw new ServiceUnavailableException(
                `failed to read tasks: ${err.message}`
            )
        })
    }

    async deleteTask(
        userId: string,
        hostId: string,
        name: string,
        isAdmin = false
    ): Promise<void> {
        // The platform's holds are the API's to place and release: the
        // keep-awake switch's and the ones work in progress takes. Deleting one
        // here would only be undone by the next reconcile or renewal.
        if (isPlatformTaskName(name))
            throw new BadRequestException(
                `task '${name}' belongs to Manyfold: keep-awake or work in progress holds the sandbox with it — turn keep-awake off, or let the work finish`
            )
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        // An active task forces the running state, so a non-running sprite has
        // no tasks to delete — and the exec would wake it.
        if (host.powerState !== 'running' || !host.providerRef)
            throw new ConflictException(
                `sandbox ${hostId} is not running — it has no active tasks to delete`
            )
        const stillHeld = await this.releaseAwakeLease(
            await this.onProvider(host),
            name
        )
        if (stillHeld)
            throw new ConflictException(
                `task '${name}' is still registered — a process inside the sandbox re-registered it or the delete failed`
            )
    }

    // True when the lease is still listed after its release; a release that
    // could not be confirmed either way is an error.
    private async releaseAwakeLease(
        on: ResolvedHostProvider & { call: Omit<ProviderCall, 'generation'> },
        name: string
    ): Promise<boolean> {
        if (!on.adapter.releaseAwake)
            throw new BadRequestException('this sandbox has no tasks')
        try {
            await on.adapter.releaseAwake(on.call, { name })
            return false
        } catch (err) {
            if (err instanceof AwakeLeaseStillHeldError) return true
            throw new ServiceUnavailableException(
                `failed to delete task '${name}': ${(err as Error).message}`
            )
        }
    }

    // Sandbox-wide stop: removes every wake cause so the VM can suspend —
    // exec sessions closed, keep-awake off and its lease released, framework
    // services stopped, then non-managed services stopped, then agent-
    // registered activity tasks deleted. Agents wake again on their next
    // message; keep-awake stays off until re-enabled. Host-level terminal
    // sessions are not closed here and can still hold the VM awake until they
    // end. A user's stop leaves the platform's own awake holds in place, so a
    // turn in progress finishes before the VM sleeps; `force` (the
    // active-hours enforcer) deletes those too, since a task name inside the
    // VM is only a claim.
    async stop(
        userId: string,
        hostId: string,
        isAdmin = false,
        opts: { force?: boolean } = {}
    ): Promise<SandboxStopResponse> {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        const { host } = r
        // The switch goes off first, a sleeping machine included (a flag, no
        // exec): a stopped sandbox must not be woken again by the reconcile.
        if (host.keepAwake)
            await this.runtimes.setHostKeepAwake(host.userId, hostId, false)
        // A non-running sprite has nothing pinning it awake, and the task
        // sweep's exec would wake it — the one thing a stop must never do.
        if (host.powerState !== 'running' || !host.providerRef)
            return {
                status: 'noop',
                stoppedAgents: 0,
                stoppedServices: [],
                deletedTasks: [],
                estimatedReadyInSec: 0,
                warnings: []
            }
        const machine = providerRefLabel(host)
        const warnings: string[] = []
        let estimate = SPRITES_AUTO_SLEEP_SEC

        const agentsOnHost = await this.runtimes.listAgentsByHost(hostId)
        const closedSessions = this.sessions.closeForHost(hostId, 'sandbox-stop')

        // The switch is already off, so nothing holds again what this lets go;
        // a release that failed is a warning, and the hold ends with its TTL.
        const released = await this.keepAwake?.converge(host)
        if (released?.state === 'failed') {
            estimate = Math.max(estimate, KEEP_AWAKE_TTL_SEC)
            warnings.push(`keep-awake: ${released.message}`)
        }

        const runtimesOnHost = await this.runtimes.listRuntimesByHost(hostId)
        for (const rt of runtimesOnHost) {
            if (frameworkCapability(rt.framework).kind !== 'service') continue
            try {
                await this.hostServices.stopRuntime(rt, host)
            } catch (err) {
                warnings.push(
                    `runtime ${rt.id} service stop failed: ${(err as Error).message}`
                )
            }
        }

        // Stop (not delete) non-managed services. The supervisor refuses to
        // stop a service another one `needs`, so sweep in passes (each pass
        // can unblock the next) and surface whatever still refuses as
        // warnings.
        const on = await this.onProvider(host)
        const stoppedServices: string[] = []
        const services = await this.readServices(on)
        const userServices = services.filter(
            (s) => !isPlatformServiceName(s.name)
        )
        let pending = userServices.filter((s) => s.status !== 'stopped')
        for (
            let pass = 0;
            pending.length > 0 && pass < userServices.length;
            pass++
        ) {
            const refused: typeof pending = []
            for (const svc of pending) {
                try {
                    if (await on.adapter.stopService?.(on.call, svc.name))
                        stoppedServices.push(svc.name)
                    else refused.push(svc)
                } catch (err) {
                    warnings.push(
                        `failed to stop service '${svc.name}': ${(err as Error).message}`
                    )
                }
            }
            if (refused.length === pending.length) {
                pending = refused
                break
            }
            pending = refused
        }
        for (const svc of pending)
            warnings.push(
                `service '${svc.name}' refused to stop (another service may depend on it)`
            )

        // Delete non-platform activity tasks. The keep-awake hold was let go
        // above; a work hold stays unless the stop is forced. Tasks that could
        // not be read are unknown, not absent: the rest of the stop still runs.
        const deletedTasks: string[] = []
        let leases: AwakeLease[] | null = null
        try {
            leases = await this.readAwakeLeases(on)
        } catch (err) {
            warnings.push(`tasks were not checked: ${(err as Error).message}`)
        }
        const heldForWork = (leases ?? []).filter(
            (t) => isAwakeHoldTaskName(t.name) && !opts.force
        )
        for (const t of leases ?? []) {
            if (
                isPlatformTaskName(t.name) &&
                !(opts.force && isAwakeHoldTaskName(t.name))
            )
                continue
            if (await this.releaseAwakeLease(on, t.name))
                warnings.push(
                    `task '${t.name}' is still registered — a process inside the sandbox re-registered it`
                )
            else deletedTasks.push(t.name)
        }
        if (heldForWork.length > 0)
            warnings.push(
                'work in progress is holding the sandbox awake; it sleeps once that work finishes'
            )

        await this.powerSync
            .refreshHost(host)
            .catch((err: Error) => {
                warnings.push(`status refresh failed: ${err.message}`)
            })

        // Sessions, the lease, runtimes, services and tasks are the complete
        // set of levers a stop has, and none of them existed on this running
        // VM. Whatever is keeping it awake is out of reach, so this stop cannot
        // put it to sleep however successful its counters look. Said out loud
        // last, as a verdict on the whole attempt, because a caller retrying on
        // a timer otherwise never learns it is powerless — Seen on prod
        // [2026-09-03]: a free-plan sandbox with a deleted agent and two leaked
        // exec sessions absorbed 60 of these in one day, each audited as
        // `pending` with empty arrays, while it billed 52h against a 5h quota.
        const hasNoLevers =
            closedSessions === 0 &&
            !host.keepAwake &&
            runtimesOnHost.length === 0 &&
            userServices.length === 0 &&
            leases?.length === 0
        if (hasNoLevers) {
            warnings.push(
                'nothing on this sandbox could be stopped: it is running with no sessions, runtimes, services or tasks registered on it, so something out of reach is holding it awake and it will not sleep'
            )
            this.log.warn(
                `sandbox stop has no levers host=${hostId} machine=${machine} user=${host.userId} — running with nothing registered on it`
            )
        }

        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: userId,
                action: auditAction.SANDBOX_STOP,
                subject: hostId,
                meta: {
                    machine,
                    closedSessions,
                    agentsOnHost: agentsOnHost.length,
                    stoppedServices,
                    deletedTasks,
                    hasNoLevers,
                    warnings: warnings.length,
                    onBehalfOf:
                        isAdmin && host.userId !== userId ? host.userId : null
                }
            })
        } catch (err) {
            this.log.warn(
                `audit write failed for sandbox.stop host=${hostId}: ${(err as Error).message}`
            )
        }
        return {
            status: 'pending',
            stoppedAgents: agentsOnHost.length,
            stoppedServices,
            deletedTasks,
            estimatedReadyInSec: estimate,
            warnings
        }
    }

    private async requireProvisionedSandbox(
        userId: string,
        hostId: string,
        isAdmin: boolean
    ): Promise<
        ResolvedHostProvider & { call: Omit<ProviderCall, 'generation'> }
    > {
        const r = await this.requireSandbox(userId, hostId, isAdmin)
        if (!r.host.providerRef)
            throw new BadRequestException('sandbox is not provisioned')
        return this.onProvider(r.host)
    }

    private async onProvider(
        host: RuntimeHostRow
    ): Promise<
        ResolvedHostProvider & { call: Omit<ProviderCall, 'generation'> }
    > {
        const resolved = await this.hostProviders.resolve(host)
        return {
            ...resolved,
            call: { host, provider: resolved.provider }
        }
    }

    // Seam so tests can fake the daemon exec: the session's, under the hold
    // withSandboxDaemon took.
    protected daemonExec(
        session: HostSession
    ): (args: {
        cmd: string[]
        stdin?: string
        timeoutMs: number
    }) => Promise<HostExecResult> {
        return (args) => session.exec(args)
    }
}

/**
 * Read the `<framework>=<--version output>` / `mf=<--version output>` lines the
 * probe shell above prints.
 *
 * Exported, and split out of the probe, because the parser this picks is the
 * whole contract: every version it returns is PERSISTED (host_daemons.cli_version
 * and agent_runtimes.framework_version), so it must keep the full string —
 * prerelease suffix included. parseProbedVersion would truncate
 * `0.22.5-staging.<stamp>.<sha>` to `0.22.5`, and the staging update check
 * compares by string equality (isCliUpdateAvailable, since build stamps are not
 * semver-comparable), so a sandbox on the exact latest build was told to update
 * forever (#777).
 */
export const parseSpriteFrameworkProbe = (
    output: string
): {
    frameworks: DetectedFramework[]
    cliVersion: string | null
    herdrVersion: string | null
} => {
    const lines = output.split('\n')
    const frameworks: DetectedFramework[] = []
    for (const f of DAEMON_DETECTABLE_FRAMEWORKS) {
        const line = lines.find((l) => l.startsWith(`${f}=`))
        const version = parseProbedSemver(line ? line.slice(f.length + 1) : '')
        if (version)
            frameworks.push({
                framework: f,
                version,
                path: `~/.local/bin/${frameworkVersionDescriptor(f).binName}`
            })
    }
    const mfLine = lines.find((l) => l.startsWith('mf='))
    const cliVersion = parseProbedSemver(
        mfLine ? mfLine.slice('mf='.length) : ''
    )
    const herdrLine = lines.find((l) => l.startsWith('herdr='))
    const herdrVersion = parseHerdrVersionLine(
        herdrLine ? herdrLine.slice('herdr='.length) : ''
    )
    return { frameworks, cliVersion, herdrVersion }
}

// `herdr --version` prints "herdr 0.9.1"; the version is what is kept.
export const parseHerdrVersionLine = (output: string): string | null => {
    const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(output)
    return match ? match[1] : null
}

// What a daemon brought up now — on the current CLI — starts in herdr.
const NEW_DAEMON_HERDR = herdrFrameworksFor([
    DAEMON_FEATURE_HERDR_TERMINAL,
    DAEMON_FEATURE_HERDR_PI,
    DAEMON_FEATURE_HERDR_AGY
])

const toSandboxSummary = (
    view: SandboxHostView,
    latest: LatestCliVersion,
    activeSecondsThisPeriod: number,
    latestHerdrVersion: string | null
): SandboxSummary => {
    const { host, daemon } = view
    const cliVersion = daemon?.cliVersion ?? null
    const herdrVersion = daemon?.herdrVersion ?? null
    // A sandbox with no daemon yet gets one on the current CLI, which starts
    // every herdr framework.
    const herdrFrameworks = daemon
        ? herdrFrameworksFor(daemon.clientFeatures ?? [])
        : NEW_DAEMON_HERDR
    return {
        id: host.id,
        userId: host.userId,
        name: host.name,
        status: host.status,
        failureReason: host.failureReason,
        providerId: host.providerId,
        providerName: view.provider?.name ?? null,
        providerRefLabel: providerRefLabel(host),
        powerState: host.powerState,
        registered: daemon !== null,
        daemonOnline: daemonOnline(daemon),
        keepAwake: host.keepAwake,
        terminalEnabled: host.terminalEnabled,
        terminalModelCredentials: host.terminalModelCredentials,
        agentsCount: view.agentsCount,
        detectedFrameworks: daemon?.detectedFrameworks ?? [],
        cliVersion,
        latestCliVersion: latest.version,
        cliUpdateAvailable: isCliUpdateAvailable(
            latest.channel,
            cliVersion,
            latest.version
        ),
        herdrVersion,
        latestHerdrVersion,
        // An absent herdr is offered as an install to the latest.
        herdrUpdateAvailable:
            latestHerdrVersion !== null &&
            (herdrVersion === null ||
                HerdrVersionService.updateAvailable(
                    herdrVersion,
                    latestHerdrVersion
                )),
        canOpenInHerdr: herdrVersion !== null && herdrFrameworks.length > 0,
        herdrFrameworks: herdrVersion !== null ? herdrFrameworks : [],
        activeSecondsThisPeriod,
        emptiedAt: host.emptiedAt ? host.emptiedAt.toISOString() : null,
        createdAt: host.createdAt.toISOString(),
        updatedAt: host.updatedAt.toISOString()
    }
}

const toServiceSummary = (s: ProviderService): SandboxServiceSummary => ({
    ...s,
    managed: isPlatformServiceName(s.name)
})
