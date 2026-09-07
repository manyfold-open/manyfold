import type {
    ChannelFinalMessageMode,
    ChannelProgressMode
} from '@manyfold/shared'

const MAX_RESET_ON_IDLE_MINS = 60 * 24 * 7

// One Discord getMessages page is 1-100 messages; the default matches Hermes.
export const HISTORY_BACKFILL_LIMIT_DEFAULT = 50

export const parseHistoryBackfillLimit = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return HISTORY_BACKFILL_LIMIT_DEFAULT
    return Math.min(100, Math.max(1, Math.floor(value)))
}

export const parseResetOnIdleMins = (value: unknown): number | null => {
    if (typeof value !== 'number') return null
    if (!Number.isFinite(value)) return null
    if (value <= 0) return null
    return Math.min(Math.floor(value), MAX_RESET_ON_IDLE_MINS)
}

// fallback lets a provider whose platform can't afford streaming default to
// something quieter (Google Chat bills a message edit against a 1-write-per-
// second-per-space budget). 'preview' is matched explicitly rather than left to
// the fallthrough so an operator who picked it still gets it.
export const parseProgressMode = (
    value: unknown,
    fallback: ChannelProgressMode = 'preview'
): ChannelProgressMode => {
    if (value === 'final' || value === 'activity' || value === 'preview')
        return value
    return fallback
}

export const parseFinalMessageMode = (
    value: unknown
): ChannelFinalMessageMode => (value === 'fresh' ? 'fresh' : 'edit')

export const shouldAutoResetOnIdle = (
    mins: number | null | undefined,
    lastActivity: Date | null,
    now: Date = new Date()
): boolean => {
    if (mins === null || mins === undefined || mins <= 0) return false
    if (!lastActivity) return false
    return now.getTime() - lastActivity.getTime() >= mins * 60_000
}

export const mostRecentDate = (
    ...dates: Array<Date | null | undefined>
): Date | null => {
    let max: Date | null = null
    for (const d of dates) {
        if (!d) continue
        if (!max || d.getTime() > max.getTime()) max = d
    }
    return max
}
