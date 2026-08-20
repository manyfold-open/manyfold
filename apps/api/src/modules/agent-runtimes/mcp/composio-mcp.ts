import type { AgentFramework } from '@manyfold/shared'
import {
    COMPOSIO_API_KEY_HEADER,
    COMPOSIO_MCP_URL
} from '@/modules/connections/composio.service'

// The managed MCP-server object injected for a Composio-linked agent, in each
// JSON framework's native remote-HTTP shape (Claude `type:http`, Gemini
// `httpUrl`). Codex (TOML) is handled by mergeComposioIntoCodexMcp.
export const composioMcpServerJson = (
    framework: 'claude-code' | 'gemini-cli',
    key: string
): Record<string, unknown> => {
    const headers = { [COMPOSIO_API_KEY_HEADER]: key }
    return framework === 'gemini-cli'
        ? { httpUrl: COMPOSIO_MCP_URL, headers }
        : { type: 'http', url: COMPOSIO_MCP_URL, headers }
}

// The single MCP scope the managed composio server is injected into per
// framework — always a HOME-dir (mode-600) scope, never Claude's workspace
// `project` scope (which may be committed to a repo).
export const composioInjectScope = (
    framework: AgentFramework
): string | null => {
    if (framework === 'claude-code' || framework === 'gemini-cli') return 'user'
    if (framework === 'codex') return 'global'
    return null
}
