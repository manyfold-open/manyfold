import type { TurnExecutionRow } from '@manyfold/db'

export const CANCELLED_BY_USER_CODE = 'cancelled_by_user'

export function isCancelledTurnError(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false
    const error = (payload as Record<string, unknown>).error
    return (
        !!error &&
        typeof error === 'object' &&
        (error as Record<string, unknown>).code === CANCELLED_BY_USER_CODE
    )
}

export function isTerminalTurnExecutionState(
    state: TurnExecutionRow['state']
): state is 'done' | 'failed' | 'cancelled' {
    return state === 'done' || state === 'failed' || state === 'cancelled'
}
