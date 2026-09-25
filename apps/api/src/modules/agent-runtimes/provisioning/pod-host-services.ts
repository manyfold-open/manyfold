import {
    DAEMON_FEATURE_SERVICES,
    podRunnerHostName,
    type DaemonServiceSpec,
    type DaemonServiceStatus
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { runtimeHosts, type Database, type RuntimeHostRow } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'

const SERVICE_RPC_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 3_000

type PodHostRef = Pick<RuntimeHostRow, 'id' | 'userId'>

// The long-running processes of the service frameworks on a pod host, run by
// the host's own daemon (ADR-0035 §6) — the pod's counterpart of a sprite's
// Services API.
@Injectable()
export class PodHostServices {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly registry: DaemonRegistryService
    ) {}

    private async runnerId(host: PodHostRef): Promise<string> {
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
        if (!runner)
            throw new ServiceUnavailableException(
                `cloud computer ${host.id} has no registered daemon`
            )
        if (!runner.clientFeatures.includes(DAEMON_FEATURE_SERVICES))
            throw new ServiceUnavailableException({
                code: 'POD_HOST_DAEMON_TOO_OLD',
                message: `the Manyfold CLI on cloud computer ${host.id} is too old to run services; update it first`
            })
        return runner.id
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
