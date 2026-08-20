// Pure interval math for sandbox active-duration metering. No NestJS/DB deps so
// it unit-tests in isolation (the CAP/cross-day/skew edge cases live here).

import { utcDayBucket } from '@/common/usage-period/usage-period'

const startOfNextUtcDay = (ms: number): number => {
    const d = new Date(ms)
    return Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() + 1,
        0,
        0,
        0,
        0
    )
}

// Active seconds to credit per UTC day for an open running interval
// [sinceMs, nowMs). The CAP is applied first by advancing the start to
// nowMs - capMs (so a blackout can't book hours of phantom runtime), then the
// capped window is split at UTC day boundaries so a sprite running across
// midnight credits each day correctly — day buckets are what billing-period
// windows sum over. Returns [] for a zero/negative or non-finite interval
// (e.g. clock skew where now < since).
export const accrualBuckets = (
    sinceMs: number,
    nowMs: number,
    capMs: number
): Array<{ day: string; seconds: number }> => {
    if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return []
    const start = Math.max(sinceMs, nowMs - capMs)
    if (nowMs <= start) return []
    const out: Array<{ day: string; seconds: number }> = []
    let cursor = start
    while (cursor < nowMs) {
        const segEnd = Math.min(startOfNextUtcDay(cursor), nowMs)
        const seconds = Math.floor((segEnd - cursor) / 1000)
        if (seconds > 0)
            out.push({ day: utcDayBucket(new Date(cursor)), seconds })
        cursor = segEnd
    }
    return out
}
