import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'

const NUL = String.fromCharCode(0)
const LONE_SURROGATE = String.fromCharCode(0xd800)
const REPLACEMENT = String.fromCharCode(0xfffd)

test('buildChatMessageSourceRow creates cms id and raw metadata for JSONL text', () => {
    const row = buildChatMessageSourceRow({
        sourceKind: 'live_stream',
        sessionId: 'session-1',
        messageId: 'message-1',
        framework: 'codex',
        runtime: 'sprites',
        source: {
            sourceRef: 'thread-1',
            sourceSeq: 1,
            externalId: 'event-1',
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText: '{"type":"message"}',
            parserName: 'codex-exec-json',
            parserVersion: '1'
        }
    })

    assert.match(row.id, /^cms_[a-z2-7]{26}$/)
    assert.equal(row.rawSha256.length, 64)
    assert.equal(row.rawBytes, Buffer.byteLength('{"type":"message"}', 'utf8'))
    assert.equal(row.sourceEventKey.startsWith('live_stream:'), true)
    assert.equal(row.rawJson, null)
})

test('buildChatMessageSourceRow hashes JSON payloads stably for recovery', () => {
    const base = {
        sourceKind: 'local_session_recovery' as const,
        sessionId: 'session-1',
        messageId: 'message-1',
        framework: 'hermes' as const,
        runtime: 'k8s' as const,
        source: {
            sourceRef: 'session-ref',
            sourceFile: '/tmp/state.db',
            sourceSeq: 42,
            externalId: 'event-42',
            parentExternalId: null,
            rawFormat: 'sqlite_row' as const,
            rawJson: { b: 2, a: 1 },
            parserName: 'hermes-sqlite-history',
            parserVersion: '1'
        }
    }

    const first = buildChatMessageSourceRow(base)
    const second = buildChatMessageSourceRow({
        ...base,
        source: {
            ...base.source,
            rawJson: { a: 1, b: 2 }
        }
    })

    assert.equal(first.rawSha256, second.rawSha256)
    assert.equal(first.sourceEventKey, second.sourceEventKey)
    assert.equal(first.rawText, null)
    assert.deepEqual(first.rawJson, { b: 2, a: 1 })
})

test('buildChatMessageSourceRow strips NUL from rawText before hashing', () => {
    const base = {
        sourceKind: 'live_stream' as const,
        sessionId: 'session-1',
        messageId: 'message-1',
        framework: 'claude-code' as const,
        runtime: 'sprites' as const,
        source: {
            sourceRef: 'thread-1',
            sourceSeq: 7,
            externalId: 'event-7',
            parentExternalId: null,
            rawFormat: 'jsonl' as const,
            rawText: `{"output":"a${NUL}b"}`,
            parserName: 'claude-code-stream-json',
            parserVersion: '1'
        }
    }

    const dirty = buildChatMessageSourceRow(base)
    const clean = buildChatMessageSourceRow({
        ...base,
        source: { ...base.source, rawText: '{"output":"ab"}' }
    })

    assert.equal(dirty.rawText, '{"output":"ab"}')
    assert.equal(dirty.rawBytes, Buffer.byteLength('{"output":"ab"}', 'utf8'))
    assert.equal(dirty.rawSha256, clean.rawSha256)
    assert.equal(dirty.sourceEventKey, clean.sourceEventKey)
})

test('buildChatMessageSourceRow sanitizes rawJson before hashing', () => {
    const base = {
        sourceKind: 'local_session_recovery' as const,
        sessionId: 'session-1',
        messageId: null,
        framework: 'codex' as const,
        runtime: 'sprites' as const,
        source: {
            sourceRef: 'thread-1',
            sourceFile: '/tmp/rollout.jsonl',
            sourceSeq: 3,
            externalId: 'event-3',
            parentExternalId: null,
            rawFormat: 'jsonl' as const,
            rawJson: { output: `a${NUL}b`, broken: `x${LONE_SURROGATE}` },
            parserName: 'codex-rollout',
            parserVersion: '1'
        }
    }

    const dirty = buildChatMessageSourceRow(base)
    const clean = buildChatMessageSourceRow({
        ...base,
        source: {
            ...base.source,
            rawJson: { output: 'ab', broken: `x${REPLACEMENT}` }
        }
    })

    assert.deepEqual(dirty.rawJson, { output: 'ab', broken: `x${REPLACEMENT}` })
    assert.equal(dirty.rawSha256, clean.rawSha256)
    assert.equal(dirty.sourceEventKey, clean.sourceEventKey)
})
