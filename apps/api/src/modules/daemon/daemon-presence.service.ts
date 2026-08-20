import {
    Inject,
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy
} from '@nestjs/common'
import { and, eq, lt } from 'drizzle-orm'
import { agents, agentRuntimes, runtimeHosts, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { DaemonRateLimitService } from './daemon-rate-limit.service'

const SWEEP_INTERVAL_MS = 15_000
const OFFLINE_THRESHOLD_MS = 45_000

@Injectable()
export class DaemonPresenceService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(DaemonPresenceService.name)
    private timer: NodeJS.Timeout | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly rateLimit: DaemonRateLimitService
    ) {}

    onModuleInit(): void {
        this.timer = setInterval(() => {
            void this.sweep().catch((err) =>
                this.log.warn(
                    `presence sweep failed: ${(err as Error).message}`
                )
            )
            this.rateLimit.sweep()
        }, SWEEP_INTERVAL_MS)
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

    async sweep(): Promise<void> {
        const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS)
        const stale = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'daemon'),
                    eq(runtimeHosts.status, 'active'),
                    lt(runtimeHosts.lastSeenAt, cutoff)
                )
            )
        if (stale.length === 0) return
        for (const host of stale) {
            await this.db
                .update(runtimeHosts)
                .set({ status: 'offline', updatedAt: new Date() })
                .where(eq(runtimeHosts.id, host.id))
            await this.db
                .update(agentRuntimes)
                .set({ status: 'stopped', updatedAt: new Date() })
                .where(eq(agentRuntimes.daemonId, host.id))
            await this.db
                .update(agents)
                .set({
                    status: 'stopped',
                    failureReason: 'daemon offline',
                    updatedAt: new Date()
                })
                .where(eq(agents.daemonId, host.id))
        }
        const summary = stale
            .slice(0, 5)
            .map(
                (h) =>
                    `${h.id}(user=${h.userId},cli=${h.cliVersion ?? 'unknown'},host=${h.hostname ?? 'unknown'})`
            )
            .join(' ')
        const more = stale.length > 5 ? ` ...+${stale.length - 5} more` : ''
        this.log.log(
            `presence sweep marked ${stale.length} daemon(s) offline: ${summary}${more}`
        )
    }
}
