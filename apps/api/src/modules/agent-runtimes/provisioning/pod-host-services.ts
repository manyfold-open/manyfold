import {
    DAEMON_FEATURE_SERVICES,
    daemonOnline,
    type DaemonServiceSpec,
    type DaemonServiceStatus
} from '@manyfold/shared'
import {
    Injectable,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import type { RuntimeHostRow } from '@manyfold/db'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { PodHostCliService } from '@/modules/chat/runner/pod-host-cli.service'

const SERVICE_RPC_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 3_000

type PodHostRef = Pick<RuntimeHostRow, 'id' | 'userId'>

// The long-running processes of the service frameworks on a pod host, run by
// the host's own daemon (ADR-0035 §6) — the pod's counterpart of a sprite's
// Services API. The daemon is the host's (ADR-0036): host_daemons for the host.
@Injectable()
export class PodHostServices {
    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        // Absent in tests that build the service positionally: a daemon
        // without services is then refused rather than updated.
        @Optional() private readonly cli?: PodHostCliService
    ) {}

    private async runnerId(host: PodHostRef): Promise<string> {
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (!daemon || !daemonOnline(daemon))
            throw new ServiceUnavailableException(
                `cloud computer ${host.id} has no connected daemon`
            )
        if (daemon.clientFeatures.includes(DAEMON_FEATURE_SERVICES))
            return host.id
        // A host started from an image whose CLI predates services has it
        // updated in place first (ADR-0035 §5).
        const podHost = this.cli ? await this.hosts.findById(host.id) : null
        if (!this.cli || !podHost || podHost.userId !== host.userId)
            throw new ServiceUnavailableException({
                code: 'POD_HOST_DAEMON_TOO_OLD',
                message: `the Manyfold CLI on cloud computer ${host.id} is too old to run services; update it first`
            })
        await this.cli.ensure(podHost, { feature: DAEMON_FEATURE_SERVICES })
        return host.id
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
        return this.registry.rpc({
            daemonId: await this.runnerId(host),
            method,
            payload,
            timeoutMs: SERVICE_RPC_TIMEOUT_MS
        })
    }

    // Throws unless the host's daemon runs services, updating its CLI first
    // when it predates them.
    async ready(host: PodHostRef): Promise<void> {
        await this.runnerId(host)
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
