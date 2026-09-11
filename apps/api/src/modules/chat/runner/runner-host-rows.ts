// Two registrations racing each other leave two runner-host rows under one
// sprite's name; the process on the sprite holds the config of the last one
// and dials in on that. Every lookup by name has to agree on which row is
// the runner, or one surface sees it online while another waits on the twin
// nothing ever connected to. Seen on the local stack [2026-09-11]: the
// account list read "asleep" off the twin while the wake reported "live".
export interface RunnerHostRowLike {
    id: string
    createdAt: Date
    rpcConnectedAt: Date | null
    rpcLastSeenAt: Date | null
}

// The row the runner last answered on; among rows that never did, the
// newest (the process holds the last registration's config).
export const pickRunnerHostRow = <T extends RunnerHostRowLike>(
    rows: readonly T[]
): T | null =>
    [...rows].sort(
        (a, b) =>
            (b.rpcLastSeenAt?.getTime() ?? 0) -
                (a.rpcLastSeenAt?.getTime() ?? 0) ||
            b.createdAt.getTime() - a.createdAt.getTime()
    )[0] ?? null

// Long enough that a registration still dialling in for the first time
// (measured at 60-75s) is never mistaken for a twin.
export const STALE_TWIN_MIN_AGE_MS = 10 * 60_000

// Rows nothing ever connected to, old enough to be sure, while a sibling did
// connect: leftovers of a double registration, safe to drop (no daemon
// runtime hangs off a host that never reported).
export const staleRunnerTwins = <T extends RunnerHostRowLike>(
    rows: readonly T[],
    now = Date.now()
): T[] => {
    if (rows.length < 2 || !rows.some((r) => r.rpcConnectedAt !== null))
        return []
    return rows.filter(
        (r) =>
            r.rpcConnectedAt === null &&
            now - r.createdAt.getTime() >= STALE_TWIN_MIN_AGE_MS
    )
}
