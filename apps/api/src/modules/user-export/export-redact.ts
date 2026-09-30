import { frameworkMcpSupport } from '@manyfold/shared'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

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
    /(^env$|^envtext$|(^|_)headers$|^authorization$|^cookies?$|key|token|secret|password|credential|ciphertext|private)/i

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

// An MCP server's arguments often carry a connection string, and its URL a
// key in the query or the userinfo: neither is a key the walk above sees.
const redactMcpServer = (server: unknown): unknown => {
    const out = redactExportValue(server)
    if (!out || typeof out !== 'object' || Array.isArray(out)) return out
    const config = out as Record<string, unknown>
    if ('args' in config) config.args = REDACTED
    for (const key of ['url', 'httpUrl'])
        if (key in config) config[key] = urlWithoutCredentials(config[key])
    return config
}

const urlWithoutCredentials = (value: unknown): unknown => {
    if (typeof value !== 'string') return REDACTED
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return REDACTED
    }
    if (url.origin === 'null') return REDACTED
    return `${url.origin}${url.pathname}${url.search ? `?${REDACTED}` : ''}`
}

const redactMcpServers = (servers: unknown): unknown =>
    servers && typeof servers === 'object' && !Array.isArray(servers)
        ? Object.fromEntries(
              Object.entries(servers).map(([name, server]) => [
                  name,
                  redactMcpServer(server)
              ])
          )
        : REDACTED

// One scope's text in the framework's format, back in that format with its
// credentials withheld. Text that cannot be read is withheld whole.
const redactMcpText = (format: string | undefined, text: unknown): string => {
    if (typeof text !== 'string' || !format) return REDACTED
    if (!text.trim()) return text
    try {
        if (format === 'json')
            return JSON.stringify(redactMcpServers(JSON.parse(text)), null, 2)
        const { mcp_servers: servers, ...rest } = parseToml(text)
        return stringifyToml({
            ...(redactExportValue(rest) as Record<string, unknown>),
            mcp_servers: redactMcpServers(servers ?? {})
        })
    } catch {
        return REDACTED
    }
}

// extras.mcp holds each scope's MCP servers as the framework's own config
// text (JSON or TOML), where the credentials sit out of the key walk's sight.
export function redactAgentExtras(framework: string, extras: unknown): unknown {
    if (!extras || typeof extras !== 'object' || Array.isArray(extras))
        return redactExportValue(extras)
    const { mcp, ...rest } = extras as Record<string, unknown>
    const out = redactExportValue(rest) as Record<string, unknown>
    if (mcp === undefined) return out
    const format = frameworkMcpSupport(framework)?.format
    out.mcp =
        mcp && typeof mcp === 'object' && !Array.isArray(mcp)
            ? Object.fromEntries(
                  Object.entries(mcp).map(([scope, text]) => [
                      scope,
                      redactMcpText(format, text)
                  ])
              )
            : REDACTED
    return out
}
