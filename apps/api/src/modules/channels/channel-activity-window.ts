// The channel activity report counts rows in `channel_deliveries`, which the
// manager prunes on a retention window (CHANNEL_DELIVERY_RETENTION_DAYS,
// default 30, floor 7, <= 0 disables). Counting over a window longer than
// retention returns a partial count under a full-span label, so the resolved
// window is clamped and travels to the client in the DTO.

export const DEFAULT_ACTIVITY_WINDOW_DAYS = 30
export const MAX_ACTIVITY_WINDOW_DAYS = 90

export const resolveActivityWindowDays = (
    requested: number | undefined,
    retentionDays: number | null
): number => {
    const asked =
        requested === undefined || !Number.isFinite(requested) || requested < 1
            ? DEFAULT_ACTIVITY_WINDOW_DAYS
            : Math.min(Math.floor(requested), MAX_ACTIVITY_WINDOW_DAYS)
    if (retentionDays === null) return asked
    return Math.max(1, Math.min(asked, retentionDays))
}
