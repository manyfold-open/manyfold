import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpConfigFromExtras, validateMcpJson } from '../src/mcp'
import {
    frameworkMcpSupport,
    isKnownMcpScope
} from '../src/framework-capability'

// The per-scope MCP map lives in untyped extras jsonb; reading it must tolerate
// absent/garbage shapes so a hand-tampered row can't crash config reads.
test('mcpConfigFromExtras reads only string scope values', () => {
    assert.deepEqual(mcpConfigFromExtras(undefined), {})
    assert.deepEqual(mcpConfigFromExtras({}), {})
    assert.deepEqual(mcpConfigFromExtras({ mcp: 'nope' }), {})
    assert.deepEqual(mcpConfigFromExtras({ mcp: ['a'] }), {})
    assert.deepEqual(
        mcpConfigFromExtras({ mcp: { user: '{}', project: 42, extra: null } }),
        { user: '{}' }
    )
})

// validation gates what we write to disk — invalid JSON must never reach the
// agent's config file.
test('validateMcpJson accepts an object, rejects non-objects and bad JSON', () => {
    assert.equal(validateMcpJson('{"srv":{"command":"x"}}'), null)
    assert.equal(validateMcpJson('{}'), null)
    assert.notEqual(validateMcpJson('[]'), null)
    assert.notEqual(validateMcpJson('"str"'), null)
    assert.notEqual(validateMcpJson('{bad'), null)
})

// The MCP descriptor is the single source of truth the UI + API both read: it
// decides which scopes each framework exposes ("reflect scopes per framework").
test('MCP scope model differs per framework', () => {
    assert.deepEqual(
        frameworkMcpSupport('claude-code')?.scopes.map((s) => s.id),
        ['user', 'project']
    )
    assert.deepEqual(
        frameworkMcpSupport('codex')?.scopes.map((s) => s.id),
        ['global']
    )
    assert.deepEqual(
        frameworkMcpSupport('gemini-cli')?.scopes.map((s) => s.id),
        ['user']
    )
    assert.equal(frameworkMcpSupport('codex')?.format, 'toml')
    assert.equal(frameworkMcpSupport('claude-code')?.format, 'json')
    // Non-coding frameworks have no MCP surface — the tab must not appear.
    assert.equal(frameworkMcpSupport('hermes'), undefined)
    assert.equal(frameworkMcpSupport('openclaw'), undefined)
    assert.equal(frameworkMcpSupport('dify'), undefined)
})

test('isKnownMcpScope guards the scope id against the descriptor', () => {
    assert.equal(isKnownMcpScope('claude-code', 'user'), true)
    assert.equal(isKnownMcpScope('claude-code', 'project'), true)
    assert.equal(isKnownMcpScope('claude-code', 'global'), false)
    assert.equal(isKnownMcpScope('codex', 'global'), true)
    assert.equal(isKnownMcpScope('codex', 'user'), false)
    assert.equal(isKnownMcpScope('hermes', 'user'), false)
})
