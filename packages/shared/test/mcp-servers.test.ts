import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpServerTomlSnippet } from '../src/mcp-servers'

// A Codex server block is written as TOML text: whatever a value holds, it
// stays a string of that table, and a key that is not bare is quoted.
test('Codex TOML blocks escape their values and quote keys that need it', () => {
    assert.equal(
        mcpServerTomlSnippet({
            id: 'search',
            name: 'Search',
            transport: 'http',
            url: 'https://mcp.example.com/mcp?q="x"',
            headers: { Authorization: 'Bearer a\\b', 'X Trace': 'on' }
        }),
        [
            '[mcp_servers.search]',
            'url = "https://mcp.example.com/mcp?q=\\"x\\""',
            '',
            '[mcp_servers.search.http_headers]',
            'Authorization = "Bearer a\\\\b"',
            '"X Trace" = "on"'
        ].join('\n')
    )
    assert.equal(
        mcpServerTomlSnippet({
            id: 'my.server',
            name: 'Mine',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'say "hi"\nthere'],
            env: { TOKEN: 'a"b' }
        }),
        [
            '[mcp_servers."my.server"]',
            'command = "npx"',
            'args = ["-y", "say \\"hi\\"\\nthere"]',
            '',
            '[mcp_servers."my.server".env]',
            'TOKEN = "a\\"b"'
        ].join('\n')
    )
})
