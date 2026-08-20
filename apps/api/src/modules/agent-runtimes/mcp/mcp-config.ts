import {
    AgentFramework,
    McpConfigFormat,
    frameworkMcpSupport,
    validateMcpJson
} from '@manyfold/shared'
import { parse as parseToml } from 'smol-toml'
import {
    mergeComposioIntoCodexMcp,
    spliceCodexMcpToml
} from '@/modules/agents/credentials/codex-config-toml'

// Codex's editor holds raw [mcp_servers.*] TOML. We only need to confirm it
// parses and actually defines that table — the platform splices it verbatim
// into config.toml, it never re-serialises it. mcp_servers must be a plain
// table (not `mcp_servers = <scalar>` or `[[mcp_servers]]`), else downstream
// merge/import code would treat garbage as a server map.
export const validateMcpToml = (text: string): string | null => {
    let parsed: unknown
    try {
        parsed = parseToml(text)
    } catch (err) {
        return `Invalid TOML: ${(err as Error).message}`
    }
    const servers =
        parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>).mcp_servers
            : undefined
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
        return 'Expected TOML defining [mcp_servers.<name>] table(s)'
    return null
}

export const validateMcpText = (
    format: McpConfigFormat,
    text: string
): string | null =>
    format === 'toml' ? validateMcpToml(text) : validateMcpJson(text)

export type McpTargetKind = 'json-own' | 'json-merge' | 'toml-splice'

export interface McpScopeTarget {
    scopeId: string
    kind: McpTargetKind
    absPath: string
}

export interface McpPathContext {
    homeDir: string
    workspacePath: string
}

// The sprite file each supported scope writes to. Paths use the real $HOME
// (codex / claude-user / gemini) or the workspace (claude project). Returns the
// full set of the framework's supported scopes so materialization can also
// clear a scope the user emptied.
export const resolveMcpScopeTargets = (
    framework: AgentFramework,
    paths: McpPathContext
): McpScopeTarget[] => {
    const support = frameworkMcpSupport(framework)
    if (!support) return []
    const targets: McpScopeTarget[] = []
    for (const scope of support.scopes) {
        const resolved = targetFor(framework, scope.id, paths)
        if (resolved) targets.push({ scopeId: scope.id, ...resolved })
    }
    return targets
}

// The absolute sprite path each (framework, scope) writes to. These filenames are
// the resolved form of FrameworkMcpScope.path (shared, shown in the MCP editor) —
// keep the two in sync.
const targetFor = (
    framework: AgentFramework,
    scopeId: string,
    paths: McpPathContext
): { kind: McpTargetKind; absPath: string } | null => {
    if (framework === 'claude-code' && scopeId === 'user')
        return { kind: 'json-merge', absPath: joinPath(paths.homeDir, '.claude.json') }
    if (framework === 'claude-code' && scopeId === 'project')
        return { kind: 'json-own', absPath: joinPath(paths.workspacePath, '.mcp.json') }
    if (framework === 'gemini-cli' && scopeId === 'user')
        return {
            kind: 'json-merge',
            absPath: joinPath(paths.homeDir, '.gemini', 'settings.json')
        }
    if (framework === 'codex' && scopeId === 'global')
        return {
            kind: 'toml-splice',
            absPath: joinPath(paths.homeDir, '.codex', 'config.toml')
        }
    return null
}

const joinPath = (...parts: string[]): string =>
    parts
        .map((part, i) =>
            i === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')
        )
        .join('/')

// Parse a user-provided JSON MCP-servers value into a plain object, or null if
// it isn't one. Validated at save time; re-guarded here so a hand-tampered
// extras value can't produce a malformed config file.
export const parseMcpServersJson = (
    text: string
): Record<string, unknown> | null => {
    try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed as Record<string, unknown>
    } catch {
        return null
    }
    return null
}

const jsonFile = (value: unknown): string =>
    `${JSON.stringify(value, null, 2)}\n`

// A managed server set to fold into a scope on top of the user's own config:
// `servers` for JSON frameworks (merged into mcpServers, managed name wins),
// `composioKey` for Codex (threaded through mergeComposioIntoCodexMcp). Used to
// inject the `composio` server for a linked Composio connection.
export interface McpInjection {
    servers?: Record<string, unknown>
    composioKey?: string | null
}

// Given a scope's target, the current file content (or null if absent), the
// user's raw text and an optional managed injection, return the desired file
// content — or null when there is nothing to do (empty with the target absent,
// or an existing file we must not clobber). Non-empty-but-invalid user text
// returns null so it never gets clobbered by the injection. Callers skip the
// write when desired === current (idempotent).
export const computeDesired = (
    target: McpScopeTarget,
    current: string | null,
    text: string,
    injection?: McpInjection
): string | null => {
    const injected = injection?.servers ?? {}
    if (target.kind === 'json-own') {
        const userServers = text ? parseMcpServersJson(text) : {}
        if (text && userServers === null) return null
        const servers = { ...userServers, ...injected }
        if (Object.keys(servers).length === 0)
            return current === null ? null : jsonFile({ mcpServers: {} })
        return jsonFile({ mcpServers: servers })
    }
    if (target.kind === 'json-merge') {
        const base = current === null ? {} : parseMcpServersJson(current)
        if (base === null) return null
        const userServers = text ? parseMcpServersJson(text) : {}
        if (text && userServers === null) return null
        const servers = { ...userServers, ...injected }
        if (Object.keys(servers).length === 0) {
            if (!('mcpServers' in base)) return null
            const { mcpServers: _drop, ...rest } = base
            return jsonFile(rest)
        }
        return jsonFile({ ...base, mcpServers: servers })
    }
    // toml-splice: config.toml is platform-generated; skip if not written yet.
    if (current === null) return null
    const merged = mergeComposioIntoCodexMcp(
        text || null,
        injection?.composioKey ?? null
    )
    return spliceCodexMcpToml(current, merged)
}
