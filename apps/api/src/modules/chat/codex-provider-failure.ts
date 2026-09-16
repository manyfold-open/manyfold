export const CODEX_PROVIDER_OVERLOADED_CODE = 'codex_provider_overloaded'
export const CODEX_RATE_LIMITED_CODE = 'codex_rate_limited'

// Only Codex's terminal failure text is eligible, never assistant/tool output.
// Keep these observed upstream signatures anchored rather than matching words
// such as "overloaded" or a bare status number inside arbitrary prose.
export const classifyCodexProviderFailure = (
    detail: string
): {
    code: typeof CODEX_PROVIDER_OVERLOADED_CODE | typeof CODEX_RATE_LIMITED_CODE
    message: string
} | null => {
    // Startup warnings may precede the terminal. An earlier transient line
    // must not override a later permanent failure in the same stderr.
    const message = (detail.trim().split(/\r?\n/).at(-1) ?? '')
        .trim()
        .replace(/^ERROR:\s*/i, '')
    if (
        /^stream disconnected before completion: Our servers are currently overloaded\. Please try again later\.$/i.test(
            message
        )
    )
        return { code: CODEX_PROVIDER_OVERLOADED_CODE, message }
    if (
        /^(?:stream disconnected before completion: )?exceeded retry limit, last status: 429 Too Many Requests\.?$/i.test(
            message
        )
    )
        return { code: CODEX_RATE_LIMITED_CODE, message }
    return null
}
