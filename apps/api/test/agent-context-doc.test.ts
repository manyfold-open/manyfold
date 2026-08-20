import type { AgentConnectionInfo } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MANYFOLD_CONTEXT_VERSION,
    MANYFOLD_CONTEXT_START,
    MANYFOLD_CONTEXT_END,
    buildPlatformContextDoc,
    buildReferenceBlock,
    contextDocInstructionFile
} from '../src/modules/agent-self/agent-context-doc.service'

const github: AgentConnectionInfo = {
    provider: 'github',
    displayName: 'acme',
    account: 'acme',
    usage: 'git and gh are authenticated for github.com (account acme).'
}
const composio: AgentConnectionInfo = {
    provider: 'composio',
    displayName: 'Composio',
    account: null,
    usage: 'Composio Connect is linked; its tools are exposed through the "composio" MCP server.'
}

test('buildPlatformContextDoc opens with versioned frontmatter', () => {
    const doc = buildPlatformContextDoc({
        agentId: 'agt_123',
        connections: [github],
        generatedAt: '2026-07-01T00:00:00.000Z'
    })
    assert.ok(doc.startsWith('---\n'))
    assert.match(
        doc,
        new RegExp(`manyfold_context_version: ${MANYFOLD_CONTEXT_VERSION}\\b`)
    )
    assert.match(doc, /generated_at: 2026-07-01T00:00:00\.000Z/)
    assert.match(doc, /agent_id: agt_123/)
    // Frontmatter closes before the body heading.
    assert.ok(doc.indexOf('---', 4) < doc.indexOf('# Manyfold platform context'))
})

test('buildPlatformContextDoc renders each connection with account + usage', () => {
    const doc = buildPlatformContextDoc({
        agentId: 'agt_123',
        connections: [github, composio],
        generatedAt: 't'
    })
    assert.match(doc, /- \*\*GitHub\*\* \(acme\) — git and gh are authenticated/)
    // composio has no account → no parenthetical.
    assert.match(doc, /- \*\*Composio\*\* — Composio Connect is linked/)
    assert.match(doc, /Run `mf connections` for full, live detail\./)
})

test('buildPlatformContextDoc states when nothing is linked', () => {
    const doc = buildPlatformContextDoc({
        agentId: 'agt_123',
        connections: [],
        generatedAt: 't'
    })
    assert.match(doc, /No connections are linked to this agent\./)
})

test('buildReferenceBlock uses @import for claude-code and gemini-cli', () => {
    for (const framework of ['claude-code', 'gemini-cli'] as const) {
        const block = buildReferenceBlock(framework)
        assert.ok(block.startsWith(MANYFOLD_CONTEXT_START))
        assert.ok(block.endsWith(MANYFOLD_CONTEXT_END))
        assert.match(block, /^@AGENTS\.manyfold\.md$/m)
    }
})

test('buildReferenceBlock gives codex a read-this-file directive (no @import)', () => {
    const block = buildReferenceBlock('codex')
    assert.ok(block.startsWith(MANYFOLD_CONTEXT_START))
    assert.ok(block.endsWith(MANYFOLD_CONTEXT_END))
    assert.match(block, /Read `AGENTS\.manyfold\.md`/)
    assert.doesNotMatch(block, /^@AGENTS\.manyfold\.md$/m)
})

test('contextDocInstructionFile maps coding frameworks and skips the rest', () => {
    assert.equal(contextDocInstructionFile('claude-code'), 'CLAUDE.md')
    assert.equal(contextDocInstructionFile('codex'), 'AGENTS.md')
    assert.equal(contextDocInstructionFile('gemini-cli'), 'GEMINI.md')
    assert.equal(contextDocInstructionFile('openclaw'), undefined)
})
