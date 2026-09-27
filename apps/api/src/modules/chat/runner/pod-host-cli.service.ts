import {
    cliChannelOfVersion,
    daemonOnline,
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
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'

const CLI_INSTALL_TIMEOUT_MS = 180_000
// A restarted daemon gets about three minutes to register again.
const REREGISTER_POLLS = 60
const REREGISTER_POLL_MS = 3_000

// What the caller needs of a pod host's daemon.
export interface PodHostCliNeed {
    feature?: string
    minVersion?: string
}

const meets = (daemon: HostDaemonRow, need: PodHostCliNeed): boolean =>
    (!need.feature || daemon.clientFeatures.includes(need.feature)) &&
    (!need.minVersion ||
        !isCliVersionTooOld(daemon.cliVersion, need.minVersion))

const tooOld = (message: string) =>
    new ServiceUnavailableException({
        code: 'POD_HOST_DAEMON_TOO_OLD',
        message
    })

// The mf CLI of a cloud computer's daemon (ADR-0035 §5): updated on request,
// and brought up to what a caller needs before it is used. The pod's daemon IS
// the host's daemon (ADR-0036): host_daemons for the host.
@Injectable()
export class PodHostCliService {
    private readonly log = new Logger(PodHostCliService.name)
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

    // A connected daemon that knows its host restarts it (startup method
    // 'container') updates itself and exits, and the host's boot loop starts
    // the new binary from the home volume. Any other one (baked into an image
    // from before that, or below the floor and so never online) is installed
    // over instead, and stopped so the boot loop starts the binary just
    // installed.
    async update(args: {
        host: RuntimeHostRow
        actorId: string
        targetVersion?: string
    }): Promise<void> {
        const daemon = await this.hostDaemons.findByHostId(args.host.id)
        if (
            daemon &&
            daemon.startupMethod === 'container' &&
            daemonOnline(daemon)
        )
            await this.daemonHosts.upgrade({
                host: args.host,
                actorId: args.actorId,
                targetVersion: args.targetVersion
            })
        else await this.installOver(args.host, args.targetVersion)
    }

    // The host's daemon, updated first when it lacks what `need` asks for,
    // and returned once its new registration has it.
    async ensure(
        host: RuntimeHostRow,
        need: PodHostCliNeed
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
            throw tooOld(
                `cloud computer ${host.id} now runs Manyfold CLI ${fresh.cliVersion ?? 'of an unknown version'}, which does not support this yet`
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
            throw tooOld(
                `cloud computer ${host.id} already runs the latest Manyfold CLI (${before}), which does not support this yet`
            )
        this.log.log(
            `pod host cli update host=${host.id} from=${before ?? 'unknown'} to=${latest.version ?? 'latest'}`
        )
        await this.update({ host, actorId: host.userId })
        for (let poll = 0; poll < REREGISTER_POLLS; poll++) {
            await this.delay(REREGISTER_POLL_MS)
            const fresh = await this.hostDaemons.findByHostId(host.id)
            if (fresh && fresh.cliVersion !== before && daemonOnline(fresh))
                return fresh
        }
        throw tooOld(
            `the Manyfold CLI on cloud computer ${host.id} was updated but its daemon did not come back; update it from the cloud computer's page`
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
