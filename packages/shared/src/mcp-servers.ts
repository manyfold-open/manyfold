import type { AgentFramework } from './constants'
import type { McpCatalogTransport } from './dtos'
import type { McpConfigFormat } from './framework-capability'

// One MCP server as a framework's config text holds it, for every client
// that writes one into an agent's per-scope config (the web, the CLI).

export interface McpInstallableEntry {
    id: string
    name: string
    transport: McpCatalogTransport
    url?: string
    headers?: Record<string, string>
    command?: string
    args?: string[]
    env?: Record<string, string>
}

// Server config shapes must stay in sync with the API materializer:
// composio-mcp.ts (JSON) and codex-config-toml.ts (TOML). gemini-cli uses
// `httpUrl` instead of claude-code's `{ type: 'http', url }`.
export const mcpServerJsonConfig = (
    framework: AgentFramework,
    entry: McpInstallableEntry
): Record<string, unknown> => {
    if (entry.transport === 'http') {
        const base: Record<string, unknown> =
            framework === 'gemini-cli'
                ? { httpUrl: entry.url }
                : { type: 'http', url: entry.url }
        if (entry.headers && Object.keys(entry.headers).length)
            base.headers = entry.headers
        return base
    }
    const server: Record<string, unknown> = { command: entry.command }
    if (entry.args?.length) server.args = entry.args
    if (entry.env && Object.keys(entry.env).length) server.env = entry.env
    return server
}

export const mcpServerJsonSnippet = (
    framework: AgentFramework,
    entry: McpInstallableEntry
): string =>
    JSON.stringify(
        { [entry.id]: mcpServerJsonConfig(framework, entry) },
        null,
        2
    )

// A TOML basic string: JSON's escapes are TOML's, save that TOML also
// wants DEL escaped.
const tomlString = (value: string): string =>
    JSON.stringify(value).replace(/\u007f/g, '\\u007F')

const tomlKey = (key: string): string =>
    /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)

export const mcpServerTomlSnippet = (entry: McpInstallableEntry): string => {
    const table = `mcp_servers.${tomlKey(entry.id)}`
    const lines = [`[${table}]`]
    const pairs = (name: string, values?: Record<string, string>): void => {
        if (!values || Object.keys(values).length === 0) return
        lines.push('', `[${table}.${name}]`)
        for (const [key, value] of Object.entries(values))
            lines.push(`${tomlKey(key)} = ${tomlString(value)}`)
    }
    if (entry.transport === 'http') {
        lines.push(`url = ${tomlString(entry.url ?? '')}`)
        pairs('http_headers', entry.headers)
        return lines.join('\n')
    }
    lines.push(`command = ${tomlString(entry.command ?? '')}`)
    if (entry.args?.length)
        lines.push(`args = [${entry.args.map(tomlString).join(', ')}]`)
    pairs('env', entry.env)
    return lines.join('\n')
}

// Server names present in a raw per-scope MCP config text. JSON: top-level
// object keys. TOML: the [mcp_servers.<name>] table headers (no TOML parser
// shipped to the browser). Nested tables like [mcp_servers.fs.env] resolve to
// their first (possibly quoted) segment.
export const mcpServerNames = (
    format: McpConfigFormat,
    text: string
): string[] => {
    const trimmed = text.trim()
    if (!trimmed) return []
    if (format === 'json') {
        try {
            const parsed: unknown = JSON.parse(trimmed)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                return Object.keys(parsed as Record<string, unknown>)
        } catch {
            return []
        }
        return []
    }
    const names = new Set<string>()
    const re = /\[mcp_servers\.([^\]]+)\]/g
    let match: RegExpExecArray | null
    while ((match = re.exec(trimmed)) !== null) {
        const raw = match[1].trim()
        const quoted = raw.match(/^["']([^"']+)["']/)
        const name = quoted ? quoted[1] : raw.split('.')[0].trim()
        if (name) names.add(name)
    }
    return Array.from(names)
}

// Merge a server into a scope's raw config text. JSON scopes must parse
// (invalid text would be silently clobbered otherwise — fail loud and point
// the user at the agent's MCP editor). TOML scopes append a new block.
export const mergeMcpServerIntoText = (
    format: McpConfigFormat,
    framework: AgentFramework,
    text: string,
    entry: McpInstallableEntry
): string => {
    if (format === 'json') {
        const trimmed = text.trim()
        let existing: Record<string, unknown> = {}
        if (trimmed) {
            let parsed: unknown
            try {
                parsed = JSON.parse(trimmed)
            } catch {
                throw new Error('invalid-existing-config')
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('invalid-existing-config')
            existing = parsed as Record<string, unknown>
        }
        return JSON.stringify(
            {
                ...existing,
                [entry.id]: mcpServerJsonConfig(framework, entry)
            },
            null,
            2
        )
    }
    const snippet = mcpServerTomlSnippet(entry)
    const current = text.trimEnd()
    return current ? `${current}\n\n${snippet}` : snippet
}
