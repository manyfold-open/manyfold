import type { ChatTurnStatusPhase } from '@manyfold/shared'
import type { StreamStatus } from '@/lib/chatStreamStore'

// #674. Which of the two competing explanations for a quiet turn the user is
// shown: the transport state the tab already knows, or the recovery the server
// just announced.
//
// The tie-break is ORDER, and the store already encodes it. `recoveryPhase` is
// written by nothing but a `turn_status` row, and every `suspended` row clears
// it — so a non-null phase under `status === 'suspended'` is proof the server
// announced the recovery AFTER the device dropped. That is the production
// daemon sequence (`suspended` → `turn_status(resuming)`), and suppressing the
// label there left the user on a stale "waiting for this device" until the
// first real output. A later suspension clears the phase again and takes the
// presentation back, so this reads the newest fact either way.
//
// A cancel is the exception, and not because it is newer: the user asked for
// this turn to stop, and no server-side rebuild changes what they asked for.
export const recoveryLabelKey = (
    status: StreamStatus,
    recoveryPhase: ChatTurnStatusPhase | null
): 'web.chatStream.resuming' | 'web.chatStream.recovering' | null => {
    if (!recoveryPhase) return null
    if (status === 'cancelling' || status === 'cancelled') return null
    return recoveryPhase === 'resuming'
        ? 'web.chatStream.resuming'
        : 'web.chatStream.recovering'
}
