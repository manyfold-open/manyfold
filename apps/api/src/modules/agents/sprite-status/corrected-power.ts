import type { RuntimeHostPowerState } from '@manyfold/db'

// A daemon heartbeats every 15s and a frozen VM sends none, so one heard this
// recently is running on its machine whatever the listing says. Seen on a
// local stack [2026-09-28]: sprites.dev reported a sprite `cold`, with no
// last_running_at, for minutes while its daemon kept heartbeating; every turn
// published `running` and the next pass flipped it back.
export const HEARTBEAT_PROVES_RUNNING_MS = 20_000

// The one power state a hosted machine has: the provider's listing, raised to
// running while the machine's own daemon proves it is up. Availability, the
// concurrency caps and active-hours metering all read this value, so a
// sandbox that holds a slot is also a sandbox that accrues.
export const correctedPower = (args: {
    listed: RuntimeHostPowerState
    heartbeatAt: Date | null
    now: Date
}): RuntimeHostPowerState => {
    if (args.listed === 'running' || args.heartbeatAt === null)
        return args.listed
    return args.now.getTime() - args.heartbeatAt.getTime() <
        HEARTBEAT_PROVES_RUNNING_MS
        ? 'running'
        : args.listed
}
