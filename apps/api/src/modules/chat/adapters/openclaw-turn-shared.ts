import {
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import type { EmittedErrorEvent } from '@/modules/chat/chat-adapter'

// Shared by the two openclaw-descended chat adapters — the ACP transport
// (openclaw.adapter.ts) and the OpenAI-compatible gateway transport
// (gateway-http-chat.adapter.ts) — so neither has to import the other.

// Legacy single budget. It is NO LONGER a deadline over a live stream — it is
// the exec budget of the `openclaw agent --json` daemon-spawn path and the
// default for the two split streaming budgets below, so an operator who
// already tuned it keeps the same tolerance.
export const OPENCLAW_FETCH_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.OPENCLAW_FETCH_TIMEOUT_MS ?? 240_000)
)
// #513: one AbortSignal.timeout used to cover headers AND the entire SSE read
// loop, so a tool-heavy turn that was still emitting events every few seconds
// was killed at the absolute 240s mark and mislabelled `openclaw_stream_stall`
// ("went silent"). The connect phase and the silence detector are now separate
// budgets, and the idle one restarts on every body chunk.
const OPENCLAW_HEADERS_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.OPENCLAW_HEADERS_TIMEOUT_MS ?? OPENCLAW_FETCH_TIMEOUT_MS)
)
const OPENCLAW_STREAM_IDLE_TIMEOUT_MS = Math.max(
    1_000,
    Number(
        process.env.OPENCLAW_STREAM_IDLE_TIMEOUT_MS ?? OPENCLAW_FETCH_TIMEOUT_MS
    )
)

export interface OpenclawStreamBudgets {
    headersTimeoutMs: number
    idleTimeoutMs: number
    maxDurationMs: number
}

// The wall-clock cap is the ADMIN chat exec budget (default 2h), not a
// per-adapter constant: it is the same knob that stops a wedged CLI turn
// from holding the turn lock and billing the sprite, and an openclaw turn
// costs exactly the same. Only the two streaming budgets are openclaw's own.
export const resolveOpenclawStreamBudgets = async (
    adminSettings?: AdminSettingsService
): Promise<OpenclawStreamBudgets> => {
    const execTimeouts = adminSettings
        ? await adminSettings.getCachedChatExecTimeoutMs()
        : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)
    return {
        headersTimeoutMs: OPENCLAW_HEADERS_TIMEOUT_MS,
        idleTimeoutMs: OPENCLAW_STREAM_IDLE_TIMEOUT_MS,
        maxDurationMs: execTimeouts.timeoutMs
    }
}

export const openclawCancelledEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: 'openclaw_aborted',
        message: 'openclaw turn aborted',
        retryable: false
    }
})
