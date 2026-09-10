import type { ChatError } from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'

export type ChatErrorKind =
    | 'model_auth'
    | 'model_billing'
    | 'thread_busy'
    | null

export interface ChatErrorDisplay {
    kind: ChatErrorKind
    // Primary human-facing line. Friendly localized copy for known kinds,
    // otherwise the raw error message (or code when the message is empty).
    title: string
    // Raw technical detail to render muted under the title — only set when we
    // replaced the title with friendly copy, so support can still see the cause.
    detail: string | null
}

export const resolveChatErrorDisplay = (
    error: ChatError,
    t: TFn
): ChatErrorDisplay => {
    const message = error.message.trim()
    if (error.cause === 'auth_invalid') {
        return {
            kind: 'model_auth',
            title: t('web.chat.error.modelAuth'),
            detail: message || null
        }
    }
    if (error.cause === 'balance_exhausted') {
        return {
            kind: 'model_billing',
            title: t('web.chat.error.modelBilling'),
            detail: message || null
        }
    }
    if (error.cause === 'resume_contention') {
        return {
            kind: 'thread_busy',
            title: t('web.chat.error.threadBusy'),
            detail: message || null
        }
    }
    return { kind: null, title: message || error.code, detail: null }
}
