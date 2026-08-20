import { HttpException, HttpStatus, Injectable } from '@nestjs/common'

interface Bucket {
    count: number
    resetAt: number
}

/**
 * In-memory fixed-window rate limiter for daemon endpoints.
 * v1 single-instance assumption (matches plan Phase 2). For multi-instance
 * deploys we'd back this with Redis via the BrokerAdapter interface.
 */
@Injectable()
export class DaemonRateLimitService {
    private readonly buckets = new Map<string, Bucket>()

    consume(args: { key: string; limit: number; windowMs: number }): void {
        const now = Date.now()
        const existing = this.buckets.get(args.key)
        if (!existing || existing.resetAt <= now) {
            this.buckets.set(args.key, {
                count: 1,
                resetAt: now + args.windowMs
            })
            return
        }
        if (existing.count >= args.limit) {
            const retryAfterSec = Math.max(
                1,
                Math.ceil((existing.resetAt - now) / 1000)
            )
            throw new HttpException(
                {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: 'rate limit exceeded',
                    retryAfter: retryAfterSec
                },
                HttpStatus.TOO_MANY_REQUESTS
            )
        }
        existing.count += 1
    }

    /**
     * Periodic GC of expired buckets so the map doesn't grow unbounded.
     */
    sweep(): void {
        const now = Date.now()
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= now) this.buckets.delete(key)
        }
    }
}
