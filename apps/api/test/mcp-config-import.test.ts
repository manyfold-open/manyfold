import assert from 'node:assert/strict'
import test from 'node:test'
import { parse as parseToml } from 'smol-toml'
import {
    extractScopeText,
    importScopeTexts
} from '../src/modules/agent-runtimes/mcp/mcp-config-import'
import {
    computeDesired,
    validateMcpText,
    type McpScopeTarget
} from '../src/modules/agent-runtimes/mcp/mcp-config'
import { buildCodexConfigToml } from '../src/modules/agents/credentials/codex-config-toml'

const target = (
    kind: McpScopeTarget['kind'],
    scopeId = 's'
): McpScopeTarget => ({ scopeId, kind, absPath: '/p' })

const okText = (result: ReturnType<typeof extractScopeText>): string => {
    assert.ok(result.ok, JSON.stringify(result))
    assert.ok(result.text !== null)
    return result.text
}

// The crux of import: only the mcpServers value is user text — the rest of a
// shared file (~/.claude.json holds Claude's own state) must never leak into
// extras.mcp.
test('extractScopeText pulls only mcpServers out of a shared JSON file', () => {
    const file = '{"theme":"dark","mcpServers":{"fs":{"command":"npx"}}}'
    const text = okText(extractScopeText(target('json-merge'), file, []))
    assert.deepEqual(JSON.parse(text), { fs: { command: 'npx' } })
    assert.ok(!text.includes('theme'))
    // json-own (.mcp.json) extracts identically
    const own = okText(
        extractScopeText(target('json-own'), '{"mcpServers":{"fs":{}}}', [])
    )
    assert.deepEqual(JSON.parse(own), { fs: {} })
})

test('extractScopeText: no mcpServers key means cleared, missing file means skip', () => {
    assert.deepEqual(extractScopeText(target('json-merge'), '{"theme":"x"}', []), {
        ok: true,
        text: ''
    })
    // File absent → text null → caller keeps the stored value (never-clobber:
    // a cold sprite must not wipe staged-but-unmaterialized config).
    assert.deepEqual(extractScopeText(target('json-merge'), null, []), {
        ok: true,
        text: null
    })
})

test('extractScopeText fails loud on unparseable or non-object JSON shapes', () => {
    assert.equal(extractScopeText(target('json-merge'), 'not json', []).ok, false)
    assert.equal(extractScopeText(target('json-merge'), '[]', []).ok, false)
    assert.equal(
        extractScopeText(target('json-merge'), '{"mcpServers":["a"]}', []).ok,
        false
    )
})

// The managed composio server is injected, never user text — importing it
// would persist its plaintext key into extras.mcp and double-manage it.
test('extractScopeText drops managed names only when excluded', () => {
    const file =
        '{"mcpServers":{"fs":{},"composio":{"type":"http","url":"u","headers":{"x-consumer-api-key":"SECRET"}}}}'
    const excluded = okText(
        extractScopeText(target('json-merge'), file, ['composio'])
    )
    assert.deepEqual(JSON.parse(excluded), { fs: {} })
    assert.ok(!excluded.includes('SECRET'))
    // a user's literal `composio` server imports normally when not excluded
    const kept = okText(extractScopeText(target('json-merge'), file, []))
    assert.ok('composio' in (JSON.parse(kept) as Record<string, unknown>))
    // exclusion leaving nothing behind clears the scope
    assert.deepEqual(
        extractScopeText(
            target('json-merge'),
            '{"mcpServers":{"composio":{}}}',
            ['composio']
        ),
        { ok: true, text: '' }
    )
})

test('extractScopeText pulls mcp_servers tables out of a full config.toml', () => {
    const file = buildCodexConfigToml(
        'https://x/v1',
        '[mcp_servers.fs]\ncommand = "npx"'
    )
    const text = okText(extractScopeText(target('toml-splice'), file, []))
    const parsed = parseToml(text) as { mcp_servers: Record<string, unknown> }
    assert.deepEqual(Object.keys(parsed.mcp_servers), ['fs'])
    // platform base and sentinel comments never leak into user text
    assert.ok(!text.includes('model_provider'))
    assert.ok(!text.includes('mf-mcp-servers'))
})

test('extractScopeText captures codex tables added outside the sentinels', () => {
    // bootstrap with no MCP writes no sentinel block; `codex mcp add` appends
    const file = `${buildCodexConfigToml('https://x/v1')}\n\n[mcp_servers.foo]\ncommand = "npx"\n`
    const text = okText(extractScopeText(target('toml-splice'), file, []))
    const parsed = parseToml(text) as { mcp_servers: Record<string, unknown> }
    assert.deepEqual(Object.keys(parsed.mcp_servers), ['foo'])
})

test('extractScopeText fails loud on bad TOML and non-table mcp_servers', () => {
    const dup = '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.a]\ncommand = "y"'
    assert.equal(extractScopeText(target('toml-splice'), dup, []).ok, false)
    assert.equal(
        extractScopeText(target('toml-splice'), 'mcp_servers = "x"', []).ok,
        false
    )
    assert.equal(
        extractScopeText(target('toml-splice'), '[[mcp_servers]]\ncommand = "x"', [])
            .ok,
        false
    )
    // no mcp_servers at all is simply "no servers"
    assert.deepEqual(extractScopeText(target('toml-splice'), 'foo = 1', []), {
        ok: true,
        text: ''
    })
})

// Save-path counterpart of the import guard: the editor validator must reject
// the same non-table shapes import refuses to store.
test('validateMcpToml rejects non-table mcp_servers values', () => {
    assert.notEqual(validateMcpText('toml', 'mcp_servers = "x"'), null)
    assert.notEqual(validateMcpText('toml', '[[mcp_servers]]\ncommand = "x"'), null)
})

// The stale/local-edit acceptance case: import → rematerialize must reproduce
// the same servers (and for codex, produce them exactly once).
test('import round-trips through computeDesired without loss or duplicates', () => {
    const jsonFile = '{"theme":"dark","mcpServers":{"fs":{"command":"npx"}}}'
    const jsonText = okText(extractScopeText(target('json-merge'), jsonFile, []))
    const desired = computeDesired(target('json-merge'), jsonFile, jsonText)
    assert.deepEqual(JSON.parse(desired!), JSON.parse(jsonFile))

    const tomlFile = `${buildCodexConfigToml('https://x/v1')}\n\n[mcp_servers.foo]\ncommand = "npx"\n`
    const tomlText = okText(extractScopeText(target('toml-splice'), tomlFile, []))
    const spliced = computeDesired(target('toml-splice'), tomlFile, tomlText)
    assert.ok(spliced)
    const parsed = parseToml(spliced) as {
        mcp_servers: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(parsed.mcp_servers), ['foo'])
    assert.equal(spliced.match(/\[mcp_servers\.foo\]/g)?.length, 1)
})

test('importScopeTexts keeps stored values for skipped and errored scopes', () => {
    const targets = [
        target('json-merge', 'user'),
        target('json-own', 'project')
    ]
    const skipped = importScopeTexts(
        targets,
        { user: '{"mcpServers":{"new":{}}}', project: null },
        { user: '{"old":{}}', project: '{"keep":{}}' },
        null
    )
    assert.equal(skipped.changed, true)
    assert.deepEqual(JSON.parse(skipped.mcp.user), { new: {} })
    assert.equal(skipped.mcp.project, '{"keep":{}}')
    assert.deepEqual(
        skipped.scopes.map((s) => `${s.scopeId}:${s.status}`),
        ['user:imported', 'project:skipped']
    )

    const errored = importScopeTexts(
        targets,
        { user: 'not json', project: '{"mcpServers":{"p":{}}}' },
        { user: '{"old":{}}', project: '' },
        null
    )
    assert.equal(errored.mcp.user, '{"old":{}}')
    assert.deepEqual(JSON.parse(errored.mcp.project), { p: {} })
    assert.deepEqual(
        errored.scopes.map((s) => `${s.scopeId}:${s.status}`),
        ['user:error', 'project:imported']
    )
})

// Formatting-only differences are inevitable (the tab stores compact text, the
// materializer writes pretty-printed files) — they must not churn the DB.
test('importScopeTexts treats formatting-only differences as unchanged', () => {
    const stored = { user: '{"fs":{"command":"npx"}}' }
    const pretty =
        '{\n  "mcpServers": {\n    "fs": {\n      "command": "npx"\n    }\n  }\n}'
    const result = importScopeTexts(
        [target('json-merge', 'user')],
        { user: pretty },
        stored,
        null
    )
    assert.equal(result.changed, false)
    assert.equal(result.mcp.user, stored.user)
    assert.deepEqual(result.scopes, [{ scopeId: 'user', status: 'unchanged' }])
})

test('importScopeTexts: absent stored scope + empty runtime is unchanged, not imported', () => {
    const result = importScopeTexts(
        [target('json-merge', 'user')],
        { user: '{"theme":"dark"}' },
        {},
        null
    )
    assert.equal(result.changed, false)
    assert.equal('user' in result.mcp, false)
    assert.deepEqual(result.scopes, [{ scopeId: 'user', status: 'unchanged' }])
})

test('importScopeTexts applies the managed exclusion only to its scope', () => {
    const result = importScopeTexts(
        [target('json-merge', 'user'), target('json-own', 'project')],
        {
            user: '{"mcpServers":{"composio":{"headers":{"k":"SECRET"}},"fs":{}}}',
            project: '{"mcpServers":{"composio":{}}}'
        },
        {},
        { scopeId: 'user', names: ['composio'] }
    )
    assert.deepEqual(JSON.parse(result.mcp.user), { fs: {} })
    assert.deepEqual(JSON.parse(result.mcp.project), { composio: {} })
})
