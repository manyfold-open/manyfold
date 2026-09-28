import {
    DAEMON_FEATURE_SERVICES,
    type DaemonServiceSpec,
    type DaemonServiceStatus
} from '@manyfold/shared'
import {
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import type { RuntimeHostRow } from '@manyfold/db'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { PodHostCliService } from '@/modules/chat/runner/pod-host-cli.service'
import { podScriptRunner, type PodScriptRunner } from './pod-framework-setup'

const SERVICE_RPC_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 3_000

type PodHostRef = Pick<RuntimeHostRow, 'id' | 'userId'>

// The long-running processes of the service frameworks on a pod host, run by
// the host's own daemon (ADR-0035 §6) — the pod's counterpart of a sprite's
// Services API. The daemon is the host's (ADR-0037): host_daemons for the
// host, reached through the host's session (ADR-0038) so a daemon the API
// holds no socket to is brought up rather than refused.
@Injectable()
export class PodHostServices {
    private readonly log = new Logger(PodHostServices.name)

    constructor(
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly access: HostDaemonAccess,
        // Absent in tests that build the service positionally: a daemon
        // without services is then refused rather than updated.
        @Optional() private readonly cli?: PodHostCliService
    ) {}

    private async withDaemon<T>(
        host: PodHostRef,
        work: (session: HostSession) => Promise<T>
    ): Promise<T> {
        const row = await this.hosts.findById(host.id)
        if (!row || row.userId !== host.userId)
            throw new ServiceUnavailableException(
                `cloud computer ${host.id} has no connected daemon`
            )
        try {
            return await this.access.withHost(
                {
                    host: row,
                    daemon: await this.hostDaemons.findByHostId(host.id),
                    placement: 'k8s',
                    reason: 'services'
                },
                async (session) => {
                    if (session.daemon.clientFeatures.includes(DAEMON_FEATURE_SERVICES))
                        return work(session)
                    // A host started from an image whose CLI predates services
                    // has it updated in place first (ADR-0035 §5).
                    if (!this.cli)
                        throw new ServiceUnavailableException({
                            code: 'POD_HOST_DAEMON_TOO_OLD',
                            message: `the Manyfold CLI on cloud computer ${host.id} is too old to run services; update it first`
                        })
                    await this.cli.ensure(row, { feature: DAEMON_FEATURE_SERVICES })
                    return work(session)
                }
            )
        } catch (err) {
            if (!(err instanceof HostDaemonOfflineError)) throw err
            throw new ServiceUnavailableException(
                `cloud computer ${host.id} has no connected daemon`
            )
        }
    }

    private async call(
        host: PodHostRef,
        method:
            | 'service.upsert'
            | 'service.start'
            | 'service.stop'
            | 'service.delete'
            | 'service.list',
        payload: Record<string, unknown>
    ): Promise<Record<string, unknown> | undefined> {
        return this.withDaemon(host, (session) =>
            session.rpc({ method, payload, timeoutMs: SERVICE_RPC_TIMEOUT_MS })
        )
    }

    // Login-shell scripts on the pod, through its daemon and under the host's
    // hold, for as long as `work` runs: a recipe's configure, a credential
    // rewrite. Unlike the services calls they need no service support.
    async runScripts<T>(
        host: PodHostRef,
        reason: string,
        work: (runner: PodScriptRunner) => Promise<T>
    ): Promise<T> {
        const row = await this.hosts.findById(host.id)
        if (!row || row.userId !== host.userId)
            throw new ServiceUnavailableException(
                `cloud computer ${host.id} has no connected daemon`
            )
        try {
            return await this.access.withHost(
                { host: row, daemon: null, placement: 'k8s', reason },
                (session) =>
                    work(
                        podScriptRunner({ run: session.exec }, (event, fields) =>
                            this.log.warn(
                                `${event} ${JSON.stringify({ hostId: host.id, ...fields })}`
                            )
                        )
                    )
            )
        } catch (err) {
            if (!(err instanceof HostDaemonOfflineError)) throw err
            throw new ServiceUnavailableException(
                `cloud computer ${host.id} has no connected daemon`
            )
        }
    }

    // Throws unless the host's daemon runs services, updating its CLI first
    // when it predates them.
    async ready(host: PodHostRef): Promise<void> {
        await this.withDaemon(host, async () => undefined)
    }

    async upsert(host: PodHostRef, spec: DaemonServiceSpec): Promise<void> {
        await this.call(host, 'service.upsert', { spec })
    }

    async start(host: PodHostRef, name: string): Promise<void> {
        await this.call(host, 'service.start', { name })
    }

    async stop(host: PodHostRef, name: string): Promise<void> {
        await this.call(host, 'service.stop', { name })
    }

    // A changed env or config only takes effect in a new process.
    async restart(host: PodHostRef, name: string): Promise<void> {
        await this.stop(host, name)
        await this.start(host, name)
    }

    async remove(host: PodHostRef, name: string): Promise<void> {
        await this.call(host, 'service.delete', { name })
    }

    async list(host: PodHostRef): Promise<DaemonServiceStatus[]> {
        const result = await this.call(host, 'service.list', {})
        return (result?.services as DaemonServiceStatus[] | undefined) ?? []
    }

    // Until the service answers its health path: a framework runtime is
    // ready when its service is (ADR-0035 §9), not when its process exists.
    async waitHealthy(
        host: PodHostRef,
        name: string,
        timeoutMs: number
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs
        let last: DaemonServiceStatus | undefined
        while (Date.now() < deadline) {
            last = (await this.list(host)).find((s) => s.name === name)
            if (last?.healthy === true) return
            await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
        }
        throw new ServiceUnavailableException(
            `service ${name} on cloud computer ${host.id} did not become healthy (${last?.state ?? 'absent'}${last?.lastExit ? `, last exit: ${last.lastExit}` : ''})`
        )
    }
}
