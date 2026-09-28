import { DAEMON_FRAMEWORK_DETECT_INTERVAL_MS } from '@manyfold/shared'
import type { DetectedFramework } from '@manyfold/shared'

// A daemon detects its frameworks every DAEMON_FRAMEWORK_DETECT_INTERVAL_MS and
// sends that cached list with each 15s heartbeat, so right after the API moved
// a CLI through it, the heartbeats still carry the version from before. An
// entry the API probed holds until every report must postdate a detection: the
// interval (the daemon's clock ran on while it was asleep, so a thawed daemon
// re-detects at its first heartbeat) and a heartbeat's margin on top.
// Seen on a local stack [2026-09-28]: Codex moved to 0.158.0 in place read
// 0.151.0 again on the next heartbeat and stayed that way.
export const PROBED_ENTRY_HOLD_MS = DAEMON_FRAMEWORK_DETECT_INTERVAL_MS + 60_000

const held = (entry: DetectedFramework, now: Date): boolean =>
    entry.probedAt !== undefined &&
    now.getTime() - Date.parse(entry.probedAt) < PROBED_ENTRY_HOLD_MS

// What a heartbeat's inventory becomes once the entries the API probed and
// still holds are laid over it.
export const withProbedEntries = (
    stored: DetectedFramework[],
    reported: DetectedFramework[],
    now: Date
): DetectedFramework[] => {
    const holding = new Map(
        stored
            .filter((entry) => held(entry, now))
            .map((entry) => [entry.framework, entry])
    )
    if (holding.size === 0) return reported
    const merged = reported.map(
        (entry) => holding.get(entry.framework) ?? entry
    )
    for (const entry of holding.values())
        if (!reported.some((r) => r.framework === entry.framework))
            merged.push(entry)
    return merged
}

// The stored inventory with fresh probe results stamped in, replacing the
// entries for the same frameworks.
export const recordProbedEntries = (
    stored: DetectedFramework[],
    probed: DetectedFramework[],
    now: Date
): DetectedFramework[] => {
    const probedAt = now.toISOString()
    const fresh = new Map(
        probed.map((entry) => [entry.framework, { ...entry, probedAt }])
    )
    return [
        ...stored.filter((entry) => !fresh.has(entry.framework)),
        ...fresh.values()
    ]
}
