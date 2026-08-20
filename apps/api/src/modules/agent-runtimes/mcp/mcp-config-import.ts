import type { AgentMcpScopeRefreshResult } from '@manyfold/shared'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
    parseMcpServersJson,
    type McpScopeTarget
} from '@/modules/agent-runtimes/mcp/mcp-config'

// Same cap AgentsService.update enforces on user-typed MCP text; import
// bypasses that path, so re-guard here.
const MAX_MCP_TEXT_LENGTH = 65_536

export type ExtractResult =
    | { ok: true; text: string | null }
    | { ok: false; reason: string }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)

const omitNames = (
    servers: Record<string, unknown>,
    excludeNames: readonly string[]
): Record<string, unknown> => {
    if (excludeNames.length === 0) return servers
    const out: Record<string, unknown> = {}
    for (const [name, config] of Object.entries(servers))
        if (!excludeNames.includes(name)) out[name] = config
    return out
}

// Inverse of computeDesired: pull the user-editable MCP servers back out of a
// runtime config file. `current === null` (file absent) returns text null so
// the caller keeps the stored value — a cold sprite or pre-bootstrap codex
// must never wipe staged config (same never-clobber rule as the framework
// version probe). `excludeNames` drops managed servers (composio) so their
// injected config — and its plaintext key — never lands in extras.mcp.
export const extractScopeText = (
    target: McpScopeTarget,
    current: string | null,
    excludeNames: readonly string[]
): ExtractResult => {
    if (current === null) return { ok: true, text: null }
    const extracted =
        target.kind === 'toml-splice'
            ? extractTomlServers(current, excludeNames)
            : extractJsonServers(current, excludeNames)
    if (!extracted.ok) return extracted
    if (extracted.text !== null && extracted.text.length > MAX_MCP_TEXT_LENGTH)
        return { ok: false, reason: 'extracted MCP config is too large' }
    return extracted
}

const extractJsonServers = (
    current: string,
    excludeNames: readonly string[]
): ExtractResult => {
    const parsed = parseMcpServersJson(current)
    if (parsed === null)
        return { ok: false, reason: 'file is not a JSON object' }
    if (!('mcpServers' in parsed)) return { ok: true, text: '' }
    if (!isPlainObject(parsed.mcpServers))
        return { ok: false, reason: 'mcpServers is not an object' }
    const kept = omitNames(parsed.mcpServers, excludeNames)
    if (Object.keys(kept).length === 0) return { ok: true, text: '' }
    return { ok: true, text: JSON.stringify(kept, null, 2) }
}

const extractTomlServers = (
    current: string,
    excludeNames: readonly string[]
): ExtractResult => {
    let parsed: unknown
    try {
        parsed = parseToml(current)
    } catch (err) {
        return { ok: false, reason: `invalid TOML: ${(err as Error).message}` }
    }
    const servers = isPlainObject(parsed) ? parsed.mcp_servers : undefined
    if (servers === undefined) return { ok: true, text: '' }
    if (!isPlainObject(servers))
        return { ok: false, reason: 'mcp_servers is not a table of servers' }
    const kept = omitNames(servers, excludeNames)
    if (Object.keys(kept).length === 0) return { ok: true, text: '' }
    try {
        return { ok: true, text: stringifyToml({ mcp_servers: kept }).trim() }
    } catch (err) {
        return {
            ok: false,
            reason: `cannot re-serialise mcp_servers: ${(err as Error).message}`
        }
    }
}

export interface McpManagedExclusion {
    scopeId: string
    names: string[]
}

export interface ImportScopesResult {
    mcp: Record<string, string>
    changed: boolean
    scopes: AgentMcpScopeRefreshResult[]
}

// Fold per-scope extraction into the next extras.mcp map. Seeded from the
// stored map so skipped/error scopes keep their value; `unchanged` compares
// parsed shapes (not raw text) so a formatting-only difference between the
// stored text and the materialized file never rewrites the DB.
export const importScopeTexts = (
    targets: McpScopeTarget[],
    currentByScope: Record<string, string | null>,
    stored: Record<string, string>,
    managed: McpManagedExclusion | null
): ImportScopesResult => {
    const mcp: Record<string, string> = { ...stored }
    const scopes: AgentMcpScopeRefreshResult[] = []
    let changed = false
    for (const target of targets) {
        const excludeNames =
            managed && managed.scopeId === target.scopeId ? managed.names : []
        const result = extractScopeText(
            target,
            currentByScope[target.scopeId] ?? null,
            excludeNames
        )
        if (!result.ok) {
            scopes.push({
                scopeId: target.scopeId,
                status: 'error',
                message: result.reason
            })
            continue
        }
        if (result.text === null) {
            scopes.push({
                scopeId: target.scopeId,
                status: 'skipped',
                message: 'config file not found on the runtime'
            })
            continue
        }
        const storedText = stored[target.scopeId] ?? ''
        if (equivalentMcpText(target.kind, storedText, result.text)) {
            scopes.push({ scopeId: target.scopeId, status: 'unchanged' })
            continue
        }
        mcp[target.scopeId] = result.text
        changed = true
        scopes.push({ scopeId: target.scopeId, status: 'imported' })
    }
    return { mcp, changed, scopes }
}

const equivalentMcpText = (
    kind: McpScopeTarget['kind'],
    storedText: string,
    importedText: string
): boolean => {
    if (storedText.trim() === importedText.trim()) return true
    const a = parseForCompare(kind, storedText)
    const b = parseForCompare(kind, importedText)
    if (a === null || b === null) return false
    return JSON.stringify(a) === JSON.stringify(b)
}

const parseForCompare = (
    kind: McpScopeTarget['kind'],
    text: string
): unknown | null => {
    if (!text.trim()) return {}
    if (kind !== 'toml-splice') return parseMcpServersJson(text)
    try {
        return parseToml(text)
    } catch {
        return null
    }
}
