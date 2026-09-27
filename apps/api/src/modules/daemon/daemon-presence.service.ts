import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { DaemonRateLimitService } from './daemon-rate-limit.service'
import { inBackgroundContext } from '@/common/telemetry/background-context'

const SWEEP_INTERVAL_MS = 15_000

// Presence is derived from host_daemons.last_seen_at (ADR-0036): there is
// nothing to flip when a daemon goes quiet, so the only periodic work left
// here is the rate limiter's bucket GC.
@Injectable()
export class DaemonPresenceService implements OnModuleInit, OnModuleDestroy {
    private timer: NodeJS.Timeout | null = null

    constructor(private readonly rateLimit: DaemonRateLimitService) {}

    onModuleInit(): void {
        this.timer = setInterval(
            inBackgroundContext(() => {
                this.rateLimit.sweep()
            }),
            SWEEP_INTERVAL_MS
        )
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }
}
