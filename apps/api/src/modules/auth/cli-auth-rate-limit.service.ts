import { HttpException, HttpStatus, Injectable } from '@nestjs/common'

interface Bucket {
    count: number
    resetAt: number
}

@Injectable()
export class CliAuthRateLimitService {
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
                    code: 'rate_limited',
                    message: 'rate limit exceeded',
                    // The HttpExceptionFilter reads `retryAfterSec` to emit the
                    // Retry-After header; keep `retryAfter` for back-compat.
                    retryAfter: retryAfterSec,
                    retryAfterSec
                },
                HttpStatus.TOO_MANY_REQUESTS
            )
        }
        existing.count += 1
    }

    sweep(now: number = Date.now()): void {
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= now) this.buckets.delete(key)
        }
    }
}
