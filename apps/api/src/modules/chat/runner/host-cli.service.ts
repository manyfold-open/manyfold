import {
    DAEMON_FEATURE_MANUAL_UPDATE,
    cliChannelOfVersion,
    isCliUpdateAvailable,
    isCliVersionTooOld,
    parseProbedSemver,
    type MfCliChannel
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
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'

const CLI_INSTALL_TIMEOUT_MS = 180_000
// A restarted daemon gets about three minutes to register again.
const REREGISTER_POLLS = 60
const REREGISTER_POLL_MS = 3_000

// What the caller needs of a hosted machine's daemon.
export interface HostCliNeed {
    features?: readonly string[]
    minVersion?: string
}

const meets = (daemon: HostDaemonRow, need: HostCliNeed): boolean =>
    (need.features ?? []).every((f) => daemon.clientFeatures.includes(f)) &&
    (!need.minVersion ||
        !isCliVersionTooOld(daemon.cliVersion, need.minVersion))

// A daemon that updates itself and comes back on its own: a pod host's is
// restarted by the boot loop, a sprite's hands off to its successor.
const updatesItself = (daemon: HostDaemonRow): boolean =>
    daemon.startupMethod === 'container' ||
    daemon.clientFeatures.includes(DAEMON_FEATURE_MANUAL_UPDATE)

const podHost = (host: RuntimeHostRow): boolean =>
    host.providerRef?.kind === 'k8s'

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

    constructor(
        private readonly daemonHosts: DaemonHostService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly hosts: HostsService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly clients: HostProviderClients,
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
    }): Promise<void> {
        const daemon = await this.hostDaemons.findByHostId(args.host.id)
        if (daemon && hasRpcLease(daemon) && updatesItself(daemon))
            await this.daemonHosts.upgrade({
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
        this.log.log(
            `host cli update host=${host.id} from=${before ?? 'unknown'} to=${latest.version ?? 'latest'}`
        )
        await this.update({ host, actorId: host.userId })
        for (let poll = 0; poll < REREGISTER_POLLS; poll++) {
            await this.delay(REREGISTER_POLL_MS)
            const fresh = await this.hostDaemons.findByHostId(host.id)
            if (fresh && fresh.cliVersion !== before && hasRpcLease(fresh))
                return fresh
        }
        throw new HostCliTooOldError(
            host,
            `the Manyfold CLI on ${host.name} was updated but its daemon did not come back; update it from its page`
        )
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
