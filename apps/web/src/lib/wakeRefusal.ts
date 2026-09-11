// What a refused sandbox wake means for the surface that asked: the plan's
// active hours are gone (nothing wakes until they reset — say so and point
// at the plan), another sandbox holds the plan's one slot (it clears on its
// own once that sandbox sleeps — keep trying and say what is being waited
// for), or something else (show the API's words, offer a retry).
export type WakeRefusalKind = 'hours' | 'slot' | 'other'

export interface WakeRefusal {
    code: string
    message: string
}

export const wakeRefusalKind = (code: string): WakeRefusalKind =>
    code === 'ACTIVE_HOURS_QUOTA_REACHED'
        ? 'hours'
        : code === 'CONCURRENT_ACTIVE_LIMIT_REACHED'
          ? 'slot'
          : 'other'

// A slot refusal is transient; the wait goes on. The rest end the wait.
export const wakeRefusalEndsWait = (code: string): boolean =>
    wakeRefusalKind(code) !== 'slot'
