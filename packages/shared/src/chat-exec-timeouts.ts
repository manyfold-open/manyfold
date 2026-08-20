export interface ChatExecTimeoutsSettings {
    keepAliveSeconds: number
    livenessTimeoutSeconds: number
    maxTimeoutSeconds: number
}

export interface UpdateChatExecTimeoutsSettingsBody {
    keepAliveSeconds: number
    livenessTimeoutSeconds: number
    maxTimeoutSeconds: number
}

export interface ResolvedChatExecTimeoutMs {
    keepAliveMs: number
    livenessTimeoutMs: number
    timeoutMs: number
}

// maxTimeoutSeconds 0 means unlimited (admin escape hatch); the default caps a
// direct chat turn at 2h (aligned with the A2A async cap) so a wedged CLI that
// keeps the socket alive can't hold the turn lock and bill the sprite for days.
export const DEFAULT_CHAT_EXEC_TIMEOUTS: ChatExecTimeoutsSettings = {
    keepAliveSeconds: 20,
    livenessTimeoutSeconds: 75,
    maxTimeoutSeconds: 7200
}

// setTimeout's max safe delay is 2^31-1 ms; the daemon RPC adds +10_000 on top,
// so the resolved timeout is capped below that to avoid an instant-fire overflow.
export const CHAT_EXEC_MAX_TIMEOUT_MS = 2_000_000_000
export const MAX_CHAT_EXEC_TIMEOUT_SECONDS = 2_000_000

export const resolveChatExecTimeoutMs = (
    settings: ChatExecTimeoutsSettings
): ResolvedChatExecTimeoutMs => {
    const keepAliveMs = Math.round(settings.keepAliveSeconds * 1000)
    const livenessTimeoutMs = Math.round(settings.livenessTimeoutSeconds * 1000)
    const timeoutMs =
        settings.maxTimeoutSeconds <= 0
            ? CHAT_EXEC_MAX_TIMEOUT_MS
            : Math.min(
                  CHAT_EXEC_MAX_TIMEOUT_MS,
                  Math.round(settings.maxTimeoutSeconds * 1000)
              )
    return { keepAliveMs, livenessTimeoutMs, timeoutMs }
}
