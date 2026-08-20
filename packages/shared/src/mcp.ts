// Per-scope MCP config is stored raw (framework-native syntax) in an agent's
// `extras.mcp` jsonb: { [scopeId]: rawText }. The editor holds ONLY the
// MCP-servers definition — for JSON frameworks the object that becomes the
// value of `mcpServers`; for Codex the `[mcp_servers.*]` TOML block(s). The API
// materializer wraps/merges it into each framework's real config file so
// platform-managed keys (auth, model, hooks) are never clobbered.

// Safely read the stored per-scope MCP config map out of an agent's untyped
// `extras` jsonb. Non-string scope values are dropped.
export const mcpConfigFromExtras = (
    extras: Record<string, unknown> | null | undefined
): Record<string, string> => {
    const value = extras?.mcp
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [scopeId, text] of Object.entries(
        value as Record<string, unknown>
    ))
        if (typeof text === 'string') out[scopeId] = text
    return out
}

// Safely read the persisted per-scope delivery records (#781) out of an
// agent's untyped `extras` jsonb. Malformed entries are dropped.
export const mcpDeliveryFromExtras = (
    extras: Record<string, unknown> | null | undefined
): Record<
    string,
    { status: 'delivered' | 'skipped' | 'failed'; message?: string; at: string }
> => {
    const value = extras?.mcpDelivery
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<
        string,
        {
            status: 'delivered' | 'skipped' | 'failed'
            message?: string
            at: string
        }
    > = {}
    for (const [scopeId, record] of Object.entries(
        value as Record<string, unknown>
    )) {
        if (!record || typeof record !== 'object') continue
        const r = record as {
            status?: unknown
            message?: unknown
            at?: unknown
        }
        if (
            (r.status === 'delivered' ||
                r.status === 'skipped' ||
                r.status === 'failed') &&
            typeof r.at === 'string'
        )
            out[scopeId] = {
                status: r.status,
                at: r.at,
                ...(typeof r.message === 'string' ? { message: r.message } : {})
            }
    }
    return out
}

// Validate the raw MCP-servers text a user typed for a JSON framework
// (claude-code / gemini-cli). The text is the value of `mcpServers`: an object
// mapping server name → server config. Returns an error string, or null when
// valid. Empty/whitespace is treated as "clear" by callers and not validated
// here.
export const validateMcpJson = (text: string): string | null => {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (err) {
        return `Invalid JSON: ${(err as Error).message}`
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return 'Expected a JSON object mapping server name → config'
    return null
}
