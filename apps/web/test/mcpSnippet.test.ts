import assert from 'node:assert/strict'
import test from 'node:test'
import {
    mcpServerNames,
    mergeMcpServerIntoText,
    type McpInstallableEntry
} from '../src/lib/mcpSnippet'

const reusableServer: McpInstallableEntry = {
    id: 'context7',
    name: 'Context7',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer token' }
}

test('one My MCP definition installs into JSON-framework agent config', () => {
    const text = mergeMcpServerIntoText(
        'json',
        'claude-code',
        '{"existing":{"command":"node"}}',
        reusableServer
    )
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), ['existing', 'context7'])
    assert.deepEqual(mcpServerNames('json', text), ['existing', 'context7'])
})

test('the same My MCP definition installs into Codex TOML config', () => {
    const text = mergeMcpServerIntoText(
        'toml',
        'codex',
        '[mcp_servers.existing]\ncommand = "node"',
        reusableServer
    )
    assert.match(text, /\[mcp_servers\.context7\]/)
    assert.match(text, /url = "https:\/\/mcp\.example\.com\/mcp"/)
    assert.deepEqual(mcpServerNames('toml', text), ['existing', 'context7'])
})
