import type { EmittedErrorEvent } from '@/modules/chat/chat-adapter'

export const A2A_TURN_TIMEOUT_CODE = 'a2a_turn_timeout'

// The reason a platform stop passes to the turn's AbortController. Without one,
// every abort reads as the user's: normalizeEventForAbort turns the terminal
// into cancelled_by_user, which the web renders as a silent stop.
// Seen on prod [2026-10-01]: an A2A blocking cap stopped a healthy turn at
// 600 s, and the chat showed nothing but an empty stop.
export class TurnAbortReason extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean
    ) {
        super(message)
        this.name = 'TurnAbortReason'
    }
}

export const turnAbortErrorEvent = (
    reason: TurnAbortReason
): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: reason.code,
        message: reason.message,
        retryable: reason.retryable
    }
})
