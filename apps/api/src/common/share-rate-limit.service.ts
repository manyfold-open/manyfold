import {
    HttpException,
    HttpStatus,
    Injectable,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'

interface Bucket {
    count: number
    resetAt: number
}

// In-memory fixed-window limiter for the unauthenticated share previews
// (skill shares, chat session shares; mirrors A2aRateLimitService).
// ApiQuotaService is userId-keyed and post-auth, so it cannot cover anonymous
// share-link requests. Each consuming module registers its own provider
// instance, so buckets are naturally isolated per module.
@Injectable()
export class ShareRateLimitService implements OnModuleInit, OnModuleDestroy {
    private readonly buckets = new Map<string, Bucket>()
    private timer: NodeJS.Timeout | null = null

    onModuleInit(): void {
        this.timer = setInterval(() => this.sweep(), 60_000)
        this.timer.unref()
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

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
                    retryAfterSec
                },
                HttpStatus.TOO_MANY_REQUESTS
            )
        }
        existing.count += 1
    }

    sweep(now: number = Date.now()): void {
        for (const [key, bucket] of this.buckets)
            if (bucket.resetAt <= now) this.buckets.delete(key)
    }
}

export const clientKey = (req: {
    headers: Record<string, unknown>
    ip?: string
}): string => {
    const forwarded = req.headers['x-forwarded-for']
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
    return (
        (typeof first === 'string' ? first.split(',')[0]?.trim() : '') ||
        req.ip ||
        'unknown'
    )
}
