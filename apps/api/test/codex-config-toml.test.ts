import assert from 'node:assert/strict'
import test from 'node:test'
import { parse as parseToml } from 'smol-toml'
import {
    buildCodexConfigToml,
    mergeComposioIntoCodexMcp,
    spliceCodexMcpToml
} from '../src/modules/agents/credentials/codex-config-toml'

const MCP = '[mcp_servers.fs]\ncommand = "npx"'
const KEY = 'ck_consumer_secret'
const COMPOSIO_URL = 'https://connect.composio.dev/mcp'

test('buildCodexConfigToml omits the managed block when no MCP is given', () => {
    const toml = buildCodexConfigToml('https://api.openai.com/v1')
    assert.ok(toml.includes('base_url = "https://api.openai.com/v1"'))
    assert.ok(!toml.includes('mcp_servers'))
})

test('buildCodexConfigToml appends the MCP block last, wrapped in sentinels', () => {
    const toml = buildCodexConfigToml('https://x/v1', MCP)
    assert.ok(toml.includes('[mcp_servers.fs]'))
    assert.ok(toml.includes('command = "npx"'))
    // Managed block must come AFTER the generated base so spliceCodexMcpToml can
    // strip it by index without touching the base.
    assert.ok(toml.indexOf('mcp_servers') > toml.indexOf('base_url'))
})

// The S1 regression: a credential re-apply regenerates config.toml wholesale.
// When the stored MCP is threaded back in, the user's servers must survive.
test('credential re-apply preserves MCP servers', () => {
    const before = buildCodexConfigToml('https://old/v1', MCP)
    assert.ok(before.includes('[mcp_servers.fs]'))
    // Re-apply with a different base_url but the same stored MCP.
    const after = buildCodexConfigToml('https://new/v1', MCP)
    assert.ok(after.includes('base_url = "https://new/v1"'))
    assert.ok(after.includes('[mcp_servers.fs]'))
})

test('spliceCodexMcpToml replaces the managed block, keeping the base', () => {
    const base = buildCodexConfigToml('https://x/v1')
    const withMcp = spliceCodexMcpToml(base, MCP)
    assert.ok(withMcp.startsWith('model_provider = "OpenAI"'))
    assert.ok(withMcp.includes('[mcp_servers.fs]'))

    // Replacing with new content swaps only the block.
    const replaced = spliceCodexMcpToml(withMcp, '[mcp_servers.web]\ncommand = "y"')
    assert.ok(replaced.includes('[mcp_servers.web]'))
    assert.ok(!replaced.includes('[mcp_servers.fs]'))
    assert.ok(replaced.includes('base_url = "https://x/v1"'))
})

test('spliceCodexMcpToml with empty text removes the block (clear)', () => {
    const withMcp = buildCodexConfigToml('https://x/v1', MCP)
    const cleared = spliceCodexMcpToml(withMcp, null)
    assert.ok(!cleared.includes('mcp_servers'))
    assert.ok(cleared.includes('base_url = "https://x/v1"'))
    // Idempotent: clearing a config that has no block is a no-op equal to base.
    assert.equal(spliceCodexMcpToml(cleared, ''), cleared)
})

// B1: Codex splices the block verbatim, so composio must be merged into the
// user's [mcp_servers.*] object (not appended) — a raw append of a second
// [mcp_servers.composio] is a duplicate table that fails to parse.
test('mergeComposioIntoCodexMcp is a no-op when no key is linked', () => {
    assert.equal(mergeComposioIntoCodexMcp(MCP, null), MCP)
    assert.equal(mergeComposioIntoCodexMcp('', null), null)
    assert.equal(mergeComposioIntoCodexMcp(null, null), null)
})

test('mergeComposioIntoCodexMcp injects composio as a valid single table', () => {
    const parsed = parseToml(mergeComposioIntoCodexMcp('', KEY)!) as {
        mcp_servers: { composio: { url: string; http_headers: Record<string, string> } }
    }
    assert.equal(parsed.mcp_servers.composio.url, COMPOSIO_URL)
    assert.equal(
        parsed.mcp_servers.composio.http_headers['x-consumer-api-key'],
        KEY
    )
})

test('mergeComposioIntoCodexMcp keeps user servers and dedupes composio (managed wins)', () => {
    // A rogue user-defined `composio` must be overridden and there must be
    // exactly one composio table — parseToml throws on a duplicate.
    const user =
        '[mcp_servers.fs]\ncommand = "npx"\n\n[mcp_servers.composio]\nurl = "https://evil.example"'
    const parsed = parseToml(mergeComposioIntoCodexMcp(user, KEY)!) as {
        mcp_servers: {
            fs: { command: string }
            composio: { url: string }
        }
    }
    assert.equal(parsed.mcp_servers.fs.command, 'npx')
    assert.equal(parsed.mcp_servers.composio.url, COMPOSIO_URL)
})

test('mergeComposioIntoCodexMcp never injects over unparseable user TOML', () => {
    assert.equal(mergeComposioIntoCodexMcp('[[[ not toml', KEY), '[[[ not toml')
})

// A credential re-apply must inject composio too, else it wipes the server.
test('buildCodexConfigToml injects composio when a key is linked', () => {
    const toml = buildCodexConfigToml('https://x/v1', MCP, KEY)
    assert.ok(toml.includes('[mcp_servers.fs]'))
    assert.ok(toml.includes('[mcp_servers.composio]'))
    assert.ok(toml.includes(KEY))
})

// #201: `codex mcp add` appends tables outside the sentinels (bootstrap may
// never have written a managed block). Once MCP import copies those servers
// into extras.mcp, the splice must absorb the stray table instead of emitting
// it a second time — a duplicate [mcp_servers.*] table is a parse error that
// bricks codex.
test('spliceCodexMcpToml absorbs a stray table appended after a sentinel-less base', () => {
    const base = buildCodexConfigToml('https://x/v1')
    const withStray = `${base}\n\n[mcp_servers.foo]\ncommand = "npx"\n`
    const imported = '[mcp_servers.foo]\ncommand = "npx"'
    const spliced = spliceCodexMcpToml(withStray, imported)
    const parsed = parseToml(spliced) as {
        mcp_servers: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(parsed.mcp_servers), ['foo'])
    assert.equal(spliced.match(/\[mcp_servers\.foo\]/g)?.length, 1)
    assert.ok(spliced.includes('base_url = "https://x/v1"'))
})

test('spliceCodexMcpToml excises a stray table sitting above the managed block', () => {
    const withMcp = buildCodexConfigToml('https://x/v1', MCP)
    const tampered = withMcp.replace(
        '\n# >>>',
        '\n[mcp_servers.rogue]\ncommand = "r"\n\n# >>>'
    )
    const spliced = spliceCodexMcpToml(tampered, MCP)
    const parsed = parseToml(spliced) as {
        mcp_servers: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(parsed.mcp_servers), ['fs'])
    assert.ok(!spliced.includes('rogue'))
})

// codex appends its own state (e.g. [projects] trust) after the managed block;
// the splice must preserve it, not truncate the file at the block start.
test('spliceCodexMcpToml preserves non-MCP content after the managed block', () => {
    const withMcp = buildCodexConfigToml('https://x/v1', MCP)
    const withTrust = `${withMcp}\n[projects."/home/sprite/ws"]\ntrust_level = "trusted"\n`
    const spliced = spliceCodexMcpToml(withTrust, '[mcp_servers.web]\ncommand = "y"')
    const parsed = parseToml(spliced) as {
        mcp_servers: Record<string, unknown>
        projects: Record<string, { trust_level: string }>
    }
    assert.deepEqual(Object.keys(parsed.mcp_servers), ['web'])
    assert.equal(parsed.projects['/home/sprite/ws'].trust_level, 'trusted')
    assert.ok(!spliced.includes('[mcp_servers.fs]'))
})
