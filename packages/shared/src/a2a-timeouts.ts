export interface A2aTurnTimeoutsSettings {
    blockingTimeoutSeconds: number
    asyncTimeoutSeconds: number
}

export interface UpdateA2aTurnTimeoutsSettingsBody {
    blockingTimeoutSeconds: number
    asyncTimeoutSeconds: number
}

// Blocking sends hold the caller's HTTP/SSE request (and its in-turn `mf a2a
// send`) open, so their cap stays short; reaching it ends the wait, not the
// turn, which carries on under the async cap. The async cap bounds the turn
// itself, blocking:false or handed over, and is much longer for real agent
// work. Neither may be unlimited: detached turns die with an API restart, and
// the stale-task sweep's "pollers never see a perpetual 'working'" guarantee
// plus the per-user inflight-delegation cap both need a finite window.
export const DEFAULT_A2A_TURN_TIMEOUTS: A2aTurnTimeoutsSettings = {
    blockingTimeoutSeconds: 600,
    asyncTimeoutSeconds: 7200
}

export const MIN_A2A_TURN_TIMEOUT_SECONDS = 30
export const MAX_A2A_BLOCKING_TIMEOUT_SECONDS = 3600
export const MAX_A2A_ASYNC_TIMEOUT_SECONDS = 86_400
