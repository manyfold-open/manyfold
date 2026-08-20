// What a writer must still BE for its write to be allowed. Sampled at the
// instant the writer claimed the turn and re-checked inside every owned write,
// so a carrier that lost the turn between two events is stopped by Postgres
// rather than by whether the stale process happens to notice.
//
// owner_id alone cannot fence. The same instance legitimately re-owns a turn —
// an adoption handing over to the matched daemon resume next to it — and a
// process that lost the turn mid-stream still believes it is the owner it
// always was. turn_executions.generation is the monotonic half: every
// ownership transition bumps it in the same UPDATE that moves owner_id.
//
// A turn with no execution row carries no token. Resume refuses to manufacture
// ownership for it, while first-stamp and unfenced terminal paths serialize on
// the session advisory lock so an owner cannot appear inside that absence gap.
export interface TurnExecutionFence {
    messageId: string
    ownerId: string
    generation: number
}

// A write rejected because the fence no longer holds, as opposed to one deduped
// away on its source key or refused because the turn already terminalized. All
// three look like "nothing was written" from the row count alone, and they want
// opposite reactions: dedup keeps streaming, a terminal ends the turn, and a
// lost fence means this process must stop writing entirely and touch nothing
// the new owner now owns.
export class TurnFenceLostError extends Error {
    constructor(messageId: string) {
        super(`turn ownership lost for message=${messageId}`)
        this.name = 'TurnFenceLostError'
    }
}

export class TurnOwnershipUnavailableError extends Error {
    constructor(messageId: string, options?: ErrorOptions) {
        super(`turn ownership unavailable for message=${messageId}`, options)
        this.name = 'TurnOwnershipUnavailableError'
    }
}
