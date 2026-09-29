import {
    DAEMON_FEATURE_MANUAL_UPDATE,
    cliChannelOfVersion,
    isCliUpdateAvailable,
    isCliVersionTooOld,
    parseProbedSemver,
    type MfCliChannel,
    type UpgradeDaemonHostResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException
} from '@nestjs/common'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import { buildCliInstallScript } from '@/modules/agent-self/sprite-shell-env.service'
import { CliVersionCatalogService } from '@/modules/daemon/cli-version-catalog.service'
import { DaemonCliVersionService } from '@/modules/daemon/daemon-cli-version.service'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import {
    HostDaemonsService,
    hasRpcLease
} from '@/modules/hosts/host-daemons.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'

const CLI_INSTALL_TIMEOUT_MS = 180_000
// A restarted daemon gets about three minutes to register again.
const REREGISTER_POLLS = 60
const REREGISTER_POLL_MS = 3_000
// A daemon with work in progress defers an update until that work ends, or
// until its own drain deadline (10 minutes) passes; it takes no new work in
// between. The update it was asked for is not asked for again inside that
// window: re-asking re-armed the deadline, and a busy sandbox put the update
// off for good. A caller waits a moment for the successor, then is told to
// retry.
// Seen on local [2026-09-29]: five requests three minutes apart, each
// deferred behind the sessions still open, and the update never ran.
const DRAIN_WINDOW_MS = 11 * 60_000
const DRAINING_POLLS = 7

// What the caller needs of a hosted machine's daemon.
export interface HostCliNeed {
    features?: readonly string[]
    minVersion?: string
}

const meets = (daemon: HostDaemonRow, need: HostCliNeed): boolean =>
    (need.features ?? []).every((f) => daemon.clientFeatures.includes(f)) &&
    (!need.minVersion ||
        !isCliVersionTooOld(daemon.cliVersion, need.minVersion))

// A daemon that updates itself and comes back on its own: one under a
// supervisor's loop (a pod's boot script, a sprite's service) exits and is
// restarted, one started by hand hands off to its successor.
export const updatesItself = (daemon: HostDaemonRow): boolean =>
    daemon.startupMethod === 'container' ||
    daemon.clientFeatures.includes(DAEMON_FEATURE_MANUAL_UPDATE)

const podHost = (host: RuntimeHostRow): boolean =>
    host.providerRef?.kind === 'k8s'

// The machine's daemon is finishing the work it has before it updates: the
// caller retries in a few minutes instead of reading it as an outage.
export class HostCliUpdatingError extends ServiceUnavailableException {
    constructor(host: RuntimeHostRow) {
        super({
            code: podHost(host) ? 'POD_HOST_DAEMON_UPDATING' : 'SANDBOX_DAEMON_UPDATING',
            message: `${host.name} is updating its Manyfold CLI once its current work finishes; retry in a few minutes`
        })
    }
}

// The CLI a need asks for is not there after everything the platform can do
// to get it: callers report it as "update the CLI", not as an outage.
export class HostCliTooOldError extends ServiceUnavailableException {
    constructor(host: RuntimeHostRow, message: string) {
        super({
            code: podHost(host) ? 'POD_HOST_DAEMON_TOO_OLD' : 'SANDBOX_DAEMON_TOO_OLD',
            message
        })
    }
}

// The mf CLI of a hosted machine's daemon (ADR-0035 §5, ADR-0038): updated on
// request, and brought up to what a caller needs before it is used. The
// machine's daemon IS the host's daemon (ADR-0037): host_daemons for the host.
@Injectable()
export class HostCliService {
    private readonly log = new Logger(HostCliService.name)
    // One update per host at a time: concurrent callers share it.
    private readonly inFlight = new Map<string, Promise<HostDaemonRow>>()
    // Hosts whose daemon deferred an update, and since when.
    private readonly draining = new Map<string, number>()

    constructor(
        private readonly daemonHosts: DaemonHostService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly hosts: HostsService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly clients: HostProviderResolver,
        private readonly providers: SandboxProviderRegistry
    ) {}

    // A connected daemon that updates itself does: a pod host's exits and the
    // boot loop starts the new binary from the home volume, a sprite's hands
    // off to its successor. A pod host's daemon that cannot (baked into an
    // image from before that, or below the floor and so never online) is
    // installed over instead, and stopped so the boot loop starts the binary
    // just installed. A sprite has no loop to start it again, so there is no
    // install-over to fall back to there.
    async update(args: {
        host: RuntimeHostRow
        actorId: string
        targetVersion?: string
    }): Promise<UpgradeDaemonHostResponse | undefined> {
        const daemon = await this.hostDaemons.findByHostId(args.host.id)
        if (daemon && hasRpcLease(daemon) && updatesItself(daemon))
            return this.daemonHosts.upgrade({
                host: args.host,
                actorId: args.actorId,
                targetVersion: args.targetVersion
            })
        else if (podHost(args.host))
            await this.installOver(args.host, args.targetVersion)
        else
            throw new HostCliTooOldError(
                args.host,
                `the Manyfold CLI on ${args.host.name} cannot update itself; update it from the sandbox's page`
            )
    }

    // The host's daemon, updated first when it lacks what `need` asks for,
    // and returned once its new registration has it. A sprite's caller holds
    // the machine awake across the update: the handoff is not platform
    // activity.
    async ensure(
        host: RuntimeHostRow,
        need: HostCliNeed
    ): Promise<HostDaemonRow> {
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (daemon && meets(daemon, need)) return daemon
        let pending = this.inFlight.get(host.id)
        if (!pending) {
            pending = this.updateAndWait(host, daemon).finally(() =>
                this.inFlight.delete(host.id)
            )
            this.inFlight.set(host.id, pending)
        }
        const fresh = await pending
        if (!meets(fresh, need))
            throw new HostCliTooOldError(
                host,
                `${host.name} now runs Manyfold CLI ${fresh.cliVersion ?? 'of an unknown version'}, which does not support this yet`
            )
        return fresh
    }

    async runnerOf(host: RuntimeHostRow): Promise<HostDaemonRow | null> {
        return this.hostDaemons.findByHostId(host.id)
    }

    // The daemon once the successor of an update is back on another CLI: the
    // new version arrives with the successor's first heartbeat, over a live
    // lease. null when it is not back within `polls`.
    async awaitSuccessor(
        host: RuntimeHostRow,
        before: string | null,
        polls = REREGISTER_POLLS
    ): Promise<HostDaemonRow | null> {
        for (let poll = 0; poll < polls; poll++) {
            await this.delay(REREGISTER_POLL_MS)
            const fresh = await this.hostDaemons.findByHostId(host.id)
            if (fresh && fresh.cliVersion !== before && hasRpcLease(fresh))
                return fresh
        }
        return null
    }

    // Overridable in tests.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // Updates to the channel's latest and returns the daemon once it is back
    // on a newer CLI. A daemon already on the latest has nothing to update to.
    private async updateAndWait(
        host: RuntimeHostRow,
        daemon: HostDaemonRow | null
    ): Promise<HostDaemonRow> {
        const latest = await this.cliVersion.getCachedLatest()
        const before = daemon?.cliVersion ?? null
        if (
            latest.version &&
            !isCliUpdateAvailable(latest.channel, before, latest.version)
        )
            throw new HostCliTooOldError(
                host,
                `${host.name} already runs the latest Manyfold CLI (${before}), which does not support this yet`
            )
        const drainingSince = this.draining.get(host.id)
        if (drainingSince && Date.now() - drainingSince < DRAIN_WINDOW_MS)
            return this.awaitDrained(host, before)
        this.log.log(
            `host cli update host=${host.id} from=${before ?? 'unknown'} to=${latest.version ?? 'latest'}`
        )
        const outcome = await this.update({ host, actorId: host.userId })
        if (outcome?.deferred) {
            this.draining.set(host.id, Date.now())
            return this.awaitDrained(host, before)
        }
        const back = await this.awaitSuccessor(host, before)
        if (back) return back
        throw new HostCliTooOldError(
            host,
            `the Manyfold CLI on ${host.name} was updated but its daemon did not come back; update it from its page`
        )
    }

    private async awaitDrained(
        host: RuntimeHostRow,
        before: string | null
    ): Promise<HostDaemonRow> {
        const back = await this.awaitSuccessor(host, before, DRAINING_POLLS)
        if (!back) throw new HostCliUpdatingError(host)
        this.draining.delete(host.id)
        return back
    }

    private async installOver(
        host: RuntimeHostRow,
        targetVersion?: string
    ): Promise<void> {
        let channel: MfCliChannel
        if (targetVersion) {
            if (!(await this.cliCatalog.isInstallableVersion(targetVersion)))
                throw new BadRequestException(
                    `unknown mf CLI version ${targetVersion}`
                )
            channel = cliChannelOfVersion(targetVersion)
        } else channel = (await this.cliVersion.getCachedLatest()).channel
        const provider = await this.clients.providerForHost(host)
        const adapter = this.providers.for(provider.kind)
        const generation = await this.hosts.bumpGeneration(host.id)
        const result = await adapter
            .bootstrap({
                host,
                provider,
                generation,
                script: [
                    buildCliInstallScript(channel, targetVersion),
                    'echo "mf-upgraded=$("$HOME/.local/bin/mf" --version 2>/dev/null | head -1)"',
                    'pkill -TERM -x mf || true'
                ].join('\n'),
                timeoutMs: CLI_INSTALL_TIMEOUT_MS
            })
            .catch((err: Error) => {
                throw new ServiceUnavailableException(
                    `mf CLI upgrade failed: ${err.message}`
                )
            })
        const line = `${result.stdout}\n${result.stderr}`
            .split('\n')
            .find((l) => l.startsWith('mf-upgraded='))
        const installed = parseProbedSemver(
            line ? line.slice('mf-upgraded='.length) : ''
        )
        if (result.exitCode !== 0 || !installed)
            throw new ServiceUnavailableException(
                `mf CLI upgrade did not complete on ${host.name}`
            )
        this.log.log(
            `pod host cli installed host=${host.id} version=${installed}`
        )
    }
}
