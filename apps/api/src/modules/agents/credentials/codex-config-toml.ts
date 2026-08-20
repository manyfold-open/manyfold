import { codexDefaultModel } from '@manyfold/shared'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
    COMPOSIO_API_KEY_HEADER,
    COMPOSIO_MCP_SERVER_NAME,
    COMPOSIO_MCP_URL
} from '@/modules/connections/composio.service'

// Codex reads MCP servers only from ~/.codex/config.toml, which the platform
// generates wholesale. To let the user's [mcp_servers.*] survive every full
// rewrite (bootstrap + credential re-apply), the managed block is wrapped in
// sentinels and always appended LAST, so spliceCodexMcpToml can replace just
// that region when MCP is edited without touching the generated base above it.
const MCP_BEGIN = '# >>> mf-mcp-servers (managed by Manyfold — edit via the agent MCP tab) >>>'
const MCP_END = '# <<< mf-mcp-servers (managed by Manyfold) <<<'

const codexMcpBlock = (mcpToml: string | null | undefined): string => {
    const body = (mcpToml ?? '').trim()
    if (!body) return ''
    return `\n${MCP_BEGIN}\n${body}\n${MCP_END}\n`
}

// Merge the managed composio server into the user's raw [mcp_servers.*] TOML.
// Codex splices the block verbatim, so a raw append of a second
// [mcp_servers.composio] would be a duplicate table (parse error). Instead parse
// the user block → set/override mcp_servers.composio → stringify, leaving exactly
// one composio table with the other user servers intact. `key` null returns the
// user TOML untouched; non-empty-but-unparseable user TOML is returned unchanged
// so a hand-tampered value never gets clobbered by the injection.
export const mergeComposioIntoCodexMcp = (
    userToml: string | null | undefined,
    key: string | null
): string | null => {
    const base = (userToml ?? '').trim()
    if (!key) return base || null
    let servers: Record<string, unknown> = {}
    if (base) {
        let parsed: Record<string, unknown>
        try {
            parsed = parseToml(base) as Record<string, unknown>
        } catch {
            return base
        }
        const existing = parsed.mcp_servers
        if (existing && typeof existing === 'object' && !Array.isArray(existing))
            servers = { ...(existing as Record<string, unknown>) }
    }
    servers[COMPOSIO_MCP_SERVER_NAME] = {
        url: COMPOSIO_MCP_URL,
        http_headers: { [COMPOSIO_API_KEY_HEADER]: key }
    }
    return stringifyToml({ mcp_servers: servers }).trim()
}

export const buildCodexConfigToml = (
    baseUrl: string,
    mcpToml?: string | null,
    composioKey?: string | null
): string =>
    [
        'model_provider = "OpenAI"',
        `model = "${codexDefaultModel}"`,
        'disable_response_storage = true',
        'network_access = "enabled"',
        '[model_providers.OpenAI]',
        'name = "OpenAI"',
        `base_url = "${baseUrl}"`,
        'wire_api = "responses"',
        'requires_openai_auth = true'
    ].join('\n') +
    codexMcpBlock(mergeComposioIntoCodexMcp(mcpToml, composioKey ?? null))

// Replace (or, when mcpToml is empty, remove) the managed MCP section in an
// existing config.toml. Used when the user edits MCP without re-applying
// credentials. The managed block must end up the ONLY home of [mcp_servers.*]
// tables: `codex mcp add` appends tables outside the sentinels (bootstrap may
// never have written any), and once MCP import copies those into extras.mcp a
// naive append would emit the same table twice — a TOML parse error that
// bricks codex. So strays are excised wherever they sit, while non-MCP
// content codex appends after the block (e.g. [projects] trust) is preserved.
export const spliceCodexMcpToml = (
    existingConfig: string,
    mcpToml: string | null | undefined
): string => {
    const withoutManaged = cutManagedRegion(existingConfig)
    const base = exciseMcpServerSections(withoutManaged).replace(/\s*$/, '')
    return base + codexMcpBlock(mcpToml)
}

const cutManagedRegion = (config: string): string => {
    const begin = config.indexOf(MCP_BEGIN)
    if (begin < 0) return config
    const end = config.indexOf(MCP_END, begin)
    if (end < 0) return config.slice(0, begin)
    return config.slice(0, begin) + config.slice(end + MCP_END.length)
}

const MCP_TABLE_HEADER = /^\s*\[\[?\s*mcp_servers\s*[.\]]/
const ANY_TABLE_HEADER = /^\s*\[/

// Drop every top-level [mcp_servers...] / [[mcp_servers]] section (header line
// through the line before the next non-mcp_servers table header), plus any
// stray sentinel comments left by a hand-mangled managed region.
const exciseMcpServerSections = (config: string): string => {
    const kept: string[] = []
    let dropping = false
    for (const line of config.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === MCP_BEGIN || trimmed === MCP_END) continue
        if (MCP_TABLE_HEADER.test(line)) {
            dropping = true
            continue
        }
        if (dropping && ANY_TABLE_HEADER.test(line)) dropping = false
        if (!dropping) kept.push(line)
    }
    return kept.join('\n')
}
