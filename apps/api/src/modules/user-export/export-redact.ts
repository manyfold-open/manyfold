// The secret-free guarantee (ADR-0023 §9.2, verified by V-6) has two layers:
// collectors SELECT only allowlisted columns (credential columns like
// channels.credentials_ciphertext or user_connections.secret_ciphertext are
// never read at all), and every free-form JSON blob that IS included — agent
// extras, channel configJson, port collector output — passes through this
// key-based deep redaction. Config columns do carry credential-shaped fields
// in practice (LarkChannelConfig.verificationToken / encryptKey live in
// config_json, agent extras carry envText and MCP server env maps), so the
// blob layer is not paranoia. Over-matching is the accepted cost: dropping a
// harmless key loses a little config fidelity, leaking one secret into a
// bundle that sits in object storage for seven days is unrecoverable.
const SENSITIVE_KEY_RE =
    /(^env$|^envtext$|^headers$|^authorization$|^cookies?$|key|token|secret|password|credential|ciphertext|private)/i

export const REDACTED = '[redacted]'

// Deliberately NOT applied to chat message content: the conversation is the
// user's own authored data and the export subject itself — rewriting it would
// corrupt the takeout. Redaction covers configuration blobs only.
export function redactExportValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactExportValue)
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(
            value as Record<string, unknown>
        )) {
            if (SENSITIVE_KEY_RE.test(key)) {
                // Keep the key visible so the user can tell the field existed
                // and was withheld, rather than silently vanishing config.
                out[key] = REDACTED
                continue
            }
            out[key] = redactExportValue(entry)
        }
        return out
    }
    return value
}
