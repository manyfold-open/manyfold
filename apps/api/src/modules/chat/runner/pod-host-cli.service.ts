import {
    cliChannelOfVersion,
    isCliUpdateAvailable,
    isCliVersionTooOld,
    parseProbedSemver,
    podRunnerHostName,
    type MfCliChannel
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { runtimeHosts, type Database, type RuntimeHostRow } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { buildCliInstallScript } from '@/modules/agent-self/sprite-shell-env.service'
import { resolvePodHostPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import { CliVersionCatalogService } from '@/modules/daemon/cli-version-catalog.service'
import { DaemonCliVersionService } from '@/modules/daemon/daemon-cli-version.service'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'

const CLI_INSTALL_TIMEOUT_MS = 180_000
// A restarted daemon gets about three minutes to register again.
const REREGISTER_POLLS = 60
const REREGISTER_POLL_MS = 3_000

// What the caller needs of a pod host's daemon.
export interface PodHostCliNeed {
    feature?: string
    minVersion?: string
}

const meets = (runner: RuntimeHostRow, need: PodHostCliNeed): boolean =>
    (!need.feature || runner.clientFeatures.includes(need.feature)) &&
    (!need.minVersion ||
        !isCliVersionTooOld(runner.cliVersion, need.minVersion))

const tooOld = (message: string) =>
    new ServiceUnavailableException({
        code: 'POD_HOST_DAEMON_TOO_OLD',
        message
    })

// The mf CLI of a cloud computer's daemon (ADR-0035 §5): updated on request,
// and brought up to what a caller needs before it is used, the way a sprite
// runner below the floor is reinstalled.
@Injectable()
export class PodHostCliService {
    private readonly log = new Logger(PodHostCliService.name)
    // One update per host at a time: concurrent callers share it.
    private readonly inFlight = new Map<string, Promise<RuntimeHostRow>>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly daemonHosts: DaemonHostService,
        private readonly cliVersion: DaemonCliVersionService,
        private readonly cliCatalog: CliVersionCatalogService,
        private readonly k8s: KubernetesService,
        private readonly podExec: PodExecFactory
    ) {}

    // A connected daemon that knows its host restarts it (startup method
    // 'container') updates itself and exits, and the host's boot loop starts
    // the new binary from the home volume. Any other one (baked into an image
    // from before that, or below the floor and so never online) is installed
    // over instead, and stopped so the boot loop starts the binary just
    // installed.
    async update(args: {
        host: RuntimeHostRow
        runner: RuntimeHostRow
        actorId: string
        targetVersion?: string
    }): Promise<void> {
        if (
            args.runner.startupMethod === 'container' &&
            this.daemonHosts.isOnline(args.runner)
        )
            await this.daemonHosts.upgrade({
                host: args.runner,
                actorId: args.actorId,
                targetVersion: args.targetVersion
            })
        else await this.installOver(args.host, args.targetVersion)
    }

    // The host's daemon, updated first when it lacks what `need` asks for,
    // and returned once its new registration has it.
    async ensure(
        host: RuntimeHostRow,
        runner: RuntimeHostRow,
        need: PodHostCliNeed
    ): Promise<RuntimeHostRow> {
        if (meets(runner, need)) return runner
        let pending = this.inFlight.get(host.id)
        if (!pending) {
            pending = this.updateAndWait(host, runner).finally(() =>
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

    async runnerOf(host: RuntimeHostRow): Promise<RuntimeHostRow | null> {
        const [runner] = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, host.userId),
                    eq(runtimeHosts.kind, 'daemon'),
                    eq(runtimeHosts.managed, true),
                    eq(runtimeHosts.name, podRunnerHostName(host.id))
                )
            )
            .limit(1)
        return runner ?? null
    }

    // Overridable in tests.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // Updates to the channel's latest and returns the daemon once it is back
    // on a newer CLI. A daemon already on the latest has nothing to update to.
    private async updateAndWait(
        host: RuntimeHostRow,
        runner: RuntimeHostRow
    ): Promise<RuntimeHostRow> {
        const latest = await this.cliVersion.getCachedLatest()
        if (
            latest.version &&
            !isCliUpdateAvailable(
                latest.channel,
                runner.cliVersion,
                latest.version
            )
        )
            throw tooOld(
                `cloud computer ${host.id} already runs the latest Manyfold CLI (${runner.cliVersion}), which does not support this yet`
            )
        this.log.log(
            `pod host cli update host=${host.id} from=${runner.cliVersion ?? 'unknown'} to=${latest.version ?? 'latest'}`
        )
        await this.update({ host, runner, actorId: host.userId })
        for (let poll = 0; poll < REREGISTER_POLLS; poll++) {
            await this.delay(REREGISTER_POLL_MS)
            const fresh = await this.runnerOf(host)
            if (
                fresh &&
                fresh.cliVersion !== runner.cliVersion &&
                this.daemonHosts.isOnline(fresh)
            )
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
        const pod = await resolvePodHostPod(this.k8s, {
            hostId: host.id,
            clusterId: host.clusterId,
            namespace: host.namespace
        })
        const exec = this.podExec.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const result = await exec
            .run({
                cmd: [
                    'bash',
                    '-lc',
                    [
                        buildCliInstallScript(channel, targetVersion),
                        'echo "mf-upgraded=$("$HOME/.local/bin/mf" --version 2>/dev/null | head -1)"',
                        'pkill -TERM -x mf || true'
                    ].join('\n')
                ],
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
