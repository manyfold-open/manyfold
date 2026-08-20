export interface A2aTurnTimeoutsSettings {
    blockingTimeoutSeconds: number
    asyncTimeoutSeconds: number
}

export interface UpdateA2aTurnTimeoutsSettingsBody {
    blockingTimeoutSeconds: number
    asyncTimeoutSeconds: number
}

// Blocking sends hold the caller's HTTP/SSE request (and its in-turn `mf a2a
// call`) open, so their cap stays short. Async (blocking:false) tasks are
// polled via tasks/get, so they get a much longer cap for real agent work.
// Neither may be unlimited: detached turns die with an API restart, and the
// stale-task sweep's "pollers never see a perpetual 'working'" guarantee plus
// the per-user inflight-delegation cap both need a finite window.
export const DEFAULT_A2A_TURN_TIMEOUTS: A2aTurnTimeoutsSettings = {
    blockingTimeoutSeconds: 600,
    asyncTimeoutSeconds: 7200
}

export const MIN_A2A_TURN_TIMEOUT_SECONDS = 30
export const MAX_A2A_BLOCKING_TIMEOUT_SECONDS = 3600
export const MAX_A2A_ASYNC_TIMEOUT_SECONDS = 86_400
