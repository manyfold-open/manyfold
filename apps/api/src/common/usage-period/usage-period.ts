// Pure billing-period math for usage metering windows. No NestJS/DB deps so it
// unit-tests in isolation and can be imported from other pure modules (e.g.
// sandbox-active-duration-math).
//
// Every usage meter (sandbox active seconds, api requests, automation runs,
// model spend) resolves its window through resolveUsagePeriod so the "current
// period" semantics live in exactly one place:
//   - live subscription (active/past_due) with a the subscription provider period -> that period
//   - live subscription without one (admin_grant, pre-backfill) -> monthly
//     anniversaries of started_at
//   - no live subscription -> UTC calendar month
// The resolved window always satisfies start <= now < end: a stale period end
// (missed renewal webhook on a past_due row) rolls forward from the anchor
// rather than freezing every meter at zero or returning a moving [start, now)
// window.

export interface UsagePeriod {
    start: Date
    end: Date
    source: 'subscription' | 'calendar'
}

export interface SubscriptionPeriodAnchor {
    currentPeriodStartAt: Date | null
    currentPeriodEndAt: Date | null
    startedAt: Date
}

// Monthly boundary derived from the ORIGINAL anchor's day-of-month, clamped to
// the target month's length (the subscription provider semantics: Jan 31 -> Feb 28 -> Mar 31).
// Never iterate "previous boundary + 1 month" — that drifts to Mar 28.
export const addUtcMonthsClamped = (anchor: Date, months: number): Date => {
    const y = anchor.getUTCFullYear()
    const m = anchor.getUTCMonth() + months
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    return new Date(
        Date.UTC(
            y,
            m,
            Math.min(anchor.getUTCDate(), lastDay),
            anchor.getUTCHours(),
            anchor.getUTCMinutes(),
            anchor.getUTCSeconds(),
            anchor.getUTCMilliseconds()
        )
    )
}

const anniversaryPeriod = (
    anchor: Date,
    now: Date
): { start: Date; end: Date } => {
    // Skew guard: an anchor in the future has no containing period; report its
    // first period rather than inventing one before it.
    if (now < anchor)
        return { start: anchor, end: addUtcMonthsClamped(anchor, 1) }
    let months =
        (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - anchor.getUTCMonth())
    let start = addUtcMonthsClamped(anchor, months)
    if (start > now) start = addUtcMonthsClamped(anchor, --months)
    return { start, end: addUtcMonthsClamped(anchor, months + 1) }
}

export const resolveUsagePeriod = (
    sub: SubscriptionPeriodAnchor | null,
    now: Date
): UsagePeriod => {
    if (!sub) {
        const y = now.getUTCFullYear()
        const m = now.getUTCMonth()
        return {
            start: new Date(Date.UTC(y, m, 1)),
            end: new Date(Date.UTC(y, m + 1, 1)),
            source: 'calendar'
        }
    }
    const start = sub.currentPeriodStartAt
    const end = sub.currentPeriodEndAt
    if (start && end && start <= now && now < end)
        return { start, end, source: 'subscription' }
    // Missing or stale (end <= now) the subscription provider period: roll monthly boundaries
    // forward from the best anchor until the window contains now.
    const anchor = start ?? sub.startedAt
    return { ...anniversaryPeriod(anchor, now), source: 'subscription' }
}

export const utcDayBucket = (date: Date): string => {
    const y = date.getUTCFullYear()
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    const d = String(date.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

// Day-bucket window for a period: bucket day D belongs to the period iff
// startDay <= D < endDay. Consecutive periods share their boundary instant, so
// the boundary day is attributed entirely to the INCOMING period — no gaps, no
// double counting, at most one day of attribution fuzz per rollover (calendar
// months have midnight boundaries and are exact).
export const periodDayWindow = (
    period: UsagePeriod
): { startDay: string; endDay: string } => ({
    startDay: utcDayBucket(period.start),
    endDay: utcDayBucket(period.end)
})
