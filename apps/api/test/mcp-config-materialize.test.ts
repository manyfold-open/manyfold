import assert from 'node:assert/strict'
import test from 'node:test'
import {
    computeDesired,
    resolveMcpScopeTargets,
    validateMcpText,
    type McpInjection,
    type McpScopeTarget
} from '../src/modules/agent-runtimes/mcp/mcp-config'
import { composioMcpServerJson } from '../src/modules/agent-runtimes/mcp/composio-mcp'

const target = (kind: McpScopeTarget['kind']): McpScopeTarget => ({
    scopeId: 's',
    kind,
    absPath: '/p'
})

const composioInjection = (key: string): McpInjection => ({
    servers: { composio: composioMcpServerJson('claude-code', key) }
})

// Per-scope sprite file mapping — the single source both the UI and materializer
// derive scopes from. Codex config lives at the REAL $HOME (not the workspace).
test('resolveMcpScopeTargets maps each framework to its config files', () => {
    const paths = { homeDir: '/home/agent', workspacePath: '/home/agent/ws' }
    assert.deepEqual(resolveMcpScopeTargets('claude-code', paths), [
        { scopeId: 'user', kind: 'json-merge', absPath: '/home/agent/.claude.json' },
        { scopeId: 'project', kind: 'json-own', absPath: '/home/agent/ws/.mcp.json' }
    ])
    assert.deepEqual(resolveMcpScopeTargets('codex', paths), [
        {
            scopeId: 'global',
            kind: 'toml-splice',
            absPath: '/home/agent/.codex/config.toml'
        }
    ])
    assert.deepEqual(resolveMcpScopeTargets('gemini-cli', paths), [
        {
            scopeId: 'user',
            kind: 'json-merge',
            absPath: '/home/agent/.gemini/settings.json'
        }
    ])
})

test('validateMcpText validates JSON and TOML by format', () => {
    assert.equal(validateMcpText('json', '{"a":{"command":"x"}}'), null)
    assert.notEqual(validateMcpText('json', '[]'), null)
    assert.equal(validateMcpText('toml', '[mcp_servers.a]\ncommand = "x"'), null)
    assert.notEqual(validateMcpText('toml', 'foo = 1'), null) // no mcp_servers
    assert.notEqual(validateMcpText('toml', '[[['), null) // bad TOML
})

test('json-own writes {mcpServers}, and clears only when a file exists', () => {
    const withServers = computeDesired(target('json-own'), null, '{"fs":{"command":"x"}}')
    assert.deepEqual(JSON.parse(withServers!), { mcpServers: { fs: { command: 'x' } } })
    // Empty + no existing file → skip (never litter a spurious empty .mcp.json).
    assert.equal(computeDesired(target('json-own'), null, ''), null)
    // Empty + existing file → clear to no servers.
    assert.deepEqual(
        JSON.parse(computeDesired(target('json-own'), '{"mcpServers":{"a":{}}}', '')!),
        { mcpServers: {} }
    )
})

// The crux: merging into a shared file (~/.claude.json, gemini settings.json)
// must NEVER drop the platform's / CLI's other keys.
test('json-merge sets mcpServers without clobbering other keys', () => {
    const current = '{"theme":"dark","mcpServers":{"old":{}}}'
    const desired = computeDesired(target('json-merge'), current, '{"new":{"command":"z"}}')
    assert.deepEqual(JSON.parse(desired!), {
        theme: 'dark',
        mcpServers: { new: { command: 'z' } }
    })
})

test('json-merge clear removes only the mcpServers key', () => {
    const desired = computeDesired(target('json-merge'), '{"theme":"dark","mcpServers":{"a":{}}}', '')
    assert.deepEqual(JSON.parse(desired!), { theme: 'dark' })
    // Clearing when there was nothing to clear is a no-op (skip).
    assert.equal(computeDesired(target('json-merge'), '{"theme":"dark"}', ''), null)
})

test('json-merge refuses to clobber an unparseable existing file', () => {
    assert.equal(computeDesired(target('json-merge'), '{ not json', '{"a":{}}'), null)
})

test('toml-splice skips before config.toml exists, else splices the block', () => {
    // Pre-bootstrap: config.toml not written yet → skip.
    assert.equal(computeDesired(target('toml-splice'), null, '[mcp_servers.a]'), null)
    const base = 'model = "x"'
    const desired = computeDesired(target('toml-splice'), base, '[mcp_servers.a]\ncommand = "y"')
    assert.ok(desired!.includes('model = "x"'))
    assert.ok(desired!.includes('[mcp_servers.a]'))
})

// Composio injection: a linked connection folds a managed `composio` server into
// the framework's home-dir scope on top of whatever the user configured.
test('json-merge folds in the managed composio server (managed name wins)', () => {
    const current = '{"mcpServers":{"fs":{"command":"x"},"composio":{"url":"https://evil"}}}'
    const parsed = JSON.parse(
        computeDesired(target('json-merge'), current, '{"fs":{"command":"x"}}', composioInjection('ck_1'))!
    )
    assert.equal(parsed.mcpServers.fs.command, 'x')
    assert.equal(parsed.mcpServers.composio.type, 'http')
    assert.equal(parsed.mcpServers.composio.headers['x-consumer-api-key'], 'ck_1')
})

test('json-merge writes only the composio server when the user has no MCP text', () => {
    const parsed = JSON.parse(
        computeDesired(target('json-merge'), '{"theme":"dark"}', '', composioInjection('ck_2'))!
    )
    assert.equal(parsed.theme, 'dark') // platform/CLI keys preserved
    assert.deepEqual(Object.keys(parsed.mcpServers), ['composio'])
})

// Invalid user text must never be clobbered — not even to write only the
// injected server. Skip (null) and let the next materialize retry.
test('json-merge refuses to write only-injected over invalid user text', () => {
    assert.equal(
        computeDesired(target('json-merge'), '{"theme":"dark"}', '{ not json', composioInjection('ck_3')),
        null
    )
})

// N1: unbinding (no injection) drops the managed composio server but keeps the
// user's own servers.
test('json-merge drops the managed composio server when unbound', () => {
    const bound = '{"mcpServers":{"fs":{"command":"x"},"composio":{"type":"http"}}}'
    const parsed = JSON.parse(
        computeDesired(target('json-merge'), bound, '{"fs":{"command":"x"}}')!
    )
    assert.deepEqual(Object.keys(parsed.mcpServers), ['fs'])
})

test('toml-splice threads the composio key into the block', () => {
    const desired = computeDesired(
        target('toml-splice'),
        'model = "x"',
        '[mcp_servers.fs]\ncommand = "y"',
        { composioKey: 'ck_4' }
    )
    assert.ok(desired!.includes('[mcp_servers.fs]'))
    assert.ok(desired!.includes('[mcp_servers.composio]'))
    assert.ok(desired!.includes('ck_4'))
})

test('composioMcpServerJson uses the framework-native remote-HTTP shape', () => {
    assert.deepEqual(composioMcpServerJson('claude-code', 'k'), {
        type: 'http',
        url: 'https://connect.composio.dev/mcp',
        headers: { 'x-consumer-api-key': 'k' }
    })
    assert.deepEqual(composioMcpServerJson('gemini-cli', 'k'), {
        httpUrl: 'https://connect.composio.dev/mcp',
        headers: { 'x-consumer-api-key': 'k' }
    })
})
