import type { RuntimeAccountView } from '@manyfold/shared'
import type { TagTone } from '@/components/Tag'
import { formatDuration } from '@/lib/usageFormat'

// Vendor window keys the mapper emits (packages/shared/src/runtime-account.ts)
// and their labels. A key outside this map is a model id from Gemini's
// buckets and renders as-is.
const USAGE_WINDOW_LABEL_KEYS: Record<string, string> = {
    five_hour: 'web.runtimeDetails.account.windowFiveHour',
    seven_day: 'web.runtimeDetails.account.windowSevenDay',
    seven_day_opus: 'web.runtimeDetails.account.windowSevenDayOpus',
    seven_day_sonnet: 'web.runtimeDetails.account.windowSevenDaySonnet',
    gemini_pro: 'web.runtimeDetails.account.windowGeminiPro',
    gemini_flash: 'web.runtimeDetails.account.windowGeminiFlash',
    gemini_flash_lite: 'web.runtimeDetails.account.windowGeminiFlashLite'
}

export const usageWindowLabelKey = (key: string): string | null =>
    USAGE_WINDOW_LABEL_KEYS[key] ?? null

// Colour tracks how close the window is to refusing the next request; the
// percentage text next to the bar is the mandatory non-colour signal.
export const usageTone = (usedPercent: number): TagTone =>
    usedPercent >= 90 ? 'error' : usedPercent >= 70 ? 'warning' : 'success'

export const formatResetsIn = (
    resetsAt: string | null,
    now: number
): string | null => {
    if (!resetsAt) return null
    const at = Date.parse(resetsAt)
    if (!Number.isFinite(at)) return null
    return formatDuration(Math.max(0, at - now))
}

// Vendor plan identifiers as the files spell them: `default_claude_max_5x`,
// `claude_team`, `chatgpt_business`, `pro`. Strip the vendor prefixes and
// title-case the rest; anything unrecognised still reads as words.
export const planLabel = (plan: string | null): string | null => {
    if (!plan) return null
    const words = plan
        .trim()
        .replace(/^default_/, '')
        .replace(/^(?:claude|chatgpt)_/, '')
        .split(/[_\s-]+/)
        .filter(Boolean)
    if (words.length === 0) return null
    return words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

// The account section offers sign-in when the host reports no usable
// sign-in, or when the vendor rejected the token it does have. An API-key
// setup is signed in by other means and gets no button.
export const signInNeeded = (view: RuntimeAccountView): boolean => {
    if (view.status !== 'ok') return false
    if (
        view.credentialStatus === 'missing' ||
        view.credentialStatus === 'expired'
    )
        return true
    return view.usage?.error?.kind === 'unauthorized'
}
