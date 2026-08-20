import type { ChatError } from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'

export type ChatErrorKind = 'model_auth' | 'model_billing' | null

export interface ChatErrorDisplay {
    kind: ChatErrorKind
    // Primary human-facing line. Friendly localized copy for known kinds,
    // otherwise the raw error message (or code when the message is empty).
    title: string
    // Raw technical detail to render muted under the title — only set when we
    // replaced the title with friendly copy, so support can still see the cause.
    detail: string | null
}

// Upstream model-provider auth rejections (expired/invalid sign-in or API key)
// reach the UI under different framework codes — codex_exec_failed,
// claude_exec_failed, gemini_exec_failed, … — but share a recognizable
// signature in the surfaced message text (the codex adapter now forwards the
// stdout 401 body; claude/gemini carry the provider error likewise).
const MODEL_AUTH_SIGNATURE =
    /\b401\b|unauthorized|invalid[\s_-]?api[\s_-]?key|invalid[\s_-]?x-api-key|authentication[\s_-]?error|api[\s_-]?key[\s_-]?(?:is[\s_-]?)?(?:invalid|expired|missing|revoked)/i

// Upstream billing / out-of-credit rejections reach the UI under the same
// generic framework codes as auth errors, but carry a 402 / insufficient-funds
// signature in the message. A valid-but-broke key passes the create-time key
// check (models list is free) and only fails here on the first real call.
const MODEL_BILLING_SIGNATURE =
    /\b402\b|payment[\s_-]?required|insufficient[\s_-]?(?:credit|balance|funds|quota)|credit[\s_-]?balance[\s_-]?(?:is[\s_-]?)?too[\s_-]?low|out[\s_-]?of[\s_-]?credit|billing|quota[\s_-]?exceeded/i

export const resolveChatErrorDisplay = (
    error: ChatError,
    t: TFn
): ChatErrorDisplay => {
    const message = error.message.trim()
    const signature = `${error.code} ${message}`
    if (MODEL_AUTH_SIGNATURE.test(signature)) {
        return {
            kind: 'model_auth',
            title: t('web.chat.error.modelAuth'),
            detail: message || null
        }
    }
    if (MODEL_BILLING_SIGNATURE.test(signature)) {
        return {
            kind: 'model_billing',
            title: t('web.chat.error.modelBilling'),
            detail: message || null
        }
    }
    return { kind: null, title: message || error.code, detail: null }
}
