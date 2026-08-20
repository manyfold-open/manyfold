import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    compareRecoveryMessages,
    compareRecoveryRawSources
} from '../src/modules/chat/recovery/session-recovery.service'
import type { RecoveredMessage } from '../src/modules/chat/recovery/readers'

test('compareRecoveryMessages returns no missing rows when local and cloud match', () => {
    const local = [
        recovered('l1', 'user', 'hello'),
        recovered('l2', 'assistant', 'hi')
    ]
    const cloud = [
        cloudMessage('c1', 'user', 'hello'),
        cloudMessage('c2', 'assistant', 'hi')
    ]

    const result = compareRecoveryMessages(local, cloud, 'session-1')

    assert.equal(result.localCount, 2)
    assert.equal(result.cloudCount, 2)
    assert.equal(result.commonCount, 2)
    assert.equal(result.missingCount, 0)
    assert.equal(result.cloudOnlyCount, 0)
})

test('compareRecoveryMessages detects a missing middle assistant message', () => {
    const local = [
        recovered('l1', 'user', 'start'),
        recovered('l2', 'assistant', 'missing answer'),
        recovered('l3', 'user', 'next')
    ]
    const cloud = [
        cloudMessage('c1', 'user', 'start'),
        cloudMessage('c3', 'user', 'next')
    ]

    const result = compareRecoveryMessages(local, cloud, 'session-1')

    assert.equal(result.commonCount, 2)
    assert.equal(result.missingCount, 1)
    assert.equal(result.missingRecoveredMessages[0].externalId, 'l2')
    assert.equal(result.missingRecoveredMessages[0].role, 'assistant')
})

test('compareRecoveryMessages handles repeated identical messages by occurrence', () => {
    const local = [
        recovered('l1', 'user', 'again'),
        recovered('l2', 'assistant', 'first'),
        recovered('l3', 'user', 'again')
    ]
    const cloud = [
        cloudMessage('c1', 'user', 'again'),
        cloudMessage('c2', 'assistant', 'first')
    ]

    const result = compareRecoveryMessages(local, cloud, 'session-1')

    assert.equal(result.commonCount, 2)
    assert.equal(result.missingCount, 1)
    assert.equal(result.missingRecoveredMessages[0].externalId, 'l3')
})

test('compareRecoveryMessages reports cloud-only messages without marking them missing', () => {
    const local = [
        recovered('l1', 'user', 'start'),
        recovered('l2', 'assistant', 'done')
    ]
    const cloud = [
        cloudMessage('c1', 'user', 'start'),
        cloudMessage('cx', 'assistant', 'manual cloud note'),
        cloudMessage('c2', 'assistant', 'done')
    ]

    const result = compareRecoveryMessages(local, cloud, 'session-1')

    assert.equal(result.commonCount, 2)
    assert.equal(result.missingCount, 0)
    assert.equal(result.cloudOnlyCount, 1)
})

test('compareRecoveryRawSources compares raw cache by payload hash occurrence', () => {
    const local = [
        sourceRow('local-1', 1, 'hash-a'),
        sourceRow('local-2', 2, 'hash-b'),
        sourceRow('local-3', 3, 'hash-a')
    ]
    const cloud = [
        sourceRow('cloud-1', 1, 'hash-a'),
        sourceRow('cloud-2', 2, 'hash-b')
    ]

    const result = compareRecoveryRawSources(local, cloud)

    assert.equal(result.rawMissingCount, 1)
    assert.equal(result.rawMissingRows[0].id, 'local-3')
    assert.equal(result.rawMissingRows[0].rawSha256, 'hash-a')
})

// A cleared row keeps raw_format, raw_sha256 and raw_bytes, so it matches the
// local line it came from. It used to key as `cleared:` and read as missing
// against every local line, which turned age-based retention into a loop: the
// viewer offered "Restore raw" for every cleared row in the session, the
// endpoint re-imported all of them, and the next sweep cleared them again
// (the upsert leaves created_at alone).
test('compareRecoveryRawSources does not report a cleared row as missing', () => {
    const local = [sourceRow('local-1', 1, 'hash-a')]
    const cloud = [
        {
            ...sourceRow('cloud-1', 1, 'hash-a'),
            rawText: null,
            rawClearedAt: new Date('2026-05-10T11:00:00Z')
        }
    ]

    const result = compareRecoveryRawSources(local, cloud)

    assert.equal(result.rawMissingCount, 0)
    assert.deepEqual(
        result.rawDiffEntries.map((entry) => entry.kind),
        ['common']
    )
})

// A line the cloud genuinely never saw is still missing, cleared neighbours
// or not — the loop fix must not blind the endpoint to real gaps.
test('compareRecoveryRawSources still reports a line the cloud never had', () => {
    const local = [
        sourceRow('local-1', 1, 'hash-a'),
        sourceRow('local-2', 2, 'hash-b')
    ]
    const cloud = [
        {
            ...sourceRow('cloud-1', 1, 'hash-a'),
            rawText: null,
            rawClearedAt: new Date('2026-05-10T11:00:00Z')
        }
    ]

    const result = compareRecoveryRawSources(local, cloud)

    assert.equal(result.rawMissingCount, 1)
    assert.equal(result.rawMissingRows[0].rawSha256, 'hash-b')
})

// Guards the OOM fix: a synced long session must resolve through the common
// prefix/suffix trim (no dense matrix), and an adversarial middle larger than
// the cell cap must degrade instead of allocating it.
test('compareRecoveryRawSources trims identical prefixes without degrading', () => {
    const local = Array.from({ length: 3000 }, (_, i) =>
        sourceRow(`row-${i}`, i + 1, `hash-${i}`)
    )
    const cloud = local.map((row, i) => ({
        ...sourceRow(`cloud-${i}`, i + 1, `hash-${i}`),
        sourceEventKey: row.sourceEventKey
    }))

    const result = compareRecoveryRawSources(local, cloud)

    assert.equal(result.rawMissingCount, 0)
    assert.equal(
        result.rawDiffEntries.every((entry) => entry.kind === 'common'),
        true
    )
})

test('compareRecoveryRawSources degrades above the matrix cell cap and keeps prefix commons', () => {
    const prefix = 50
    const middle = 2100
    const local = [
        ...Array.from({ length: prefix }, (_, i) =>
            sourceRow(`common-${i}`, i + 1, `hash-common-${i}`)
        ),
        ...Array.from({ length: middle }, (_, i) =>
            sourceRow(`local-${i}`, prefix + i + 1, `hash-local-${i}`)
        )
    ]
    const cloud = [
        ...Array.from({ length: prefix }, (_, i) =>
            sourceRow(`common-${i}`, i + 1, `hash-common-${i}`)
        ),
        ...Array.from({ length: middle }, (_, i) =>
            sourceRow(`cloud-${i}`, prefix + i + 1, `hash-cloud-${i}`)
        )
    ]

    const result = compareRecoveryRawSources(local, cloud)

    assert.equal(result.degraded, true)
    assert.equal(result.rawMissingCount, middle)
    assert.equal(
        result.rawDiffEntries.filter((entry) => entry.kind === 'common').length,
        prefix
    )
})

const recovered = (
    externalId: string,
    role: RecoveredMessage['role'],
    text: string
): RecoveredMessage => ({
    externalId,
    parentExternalId: null,
    role,
    contentBlocks: [{ type: 'text', text }],
    timestamp: `2026-05-10T10:00:${externalId.slice(-1).padStart(2, '0')}Z`,
    sources: [
        {
            sourceRef: 'local-session',
            sourceFile: '/tmp/session.jsonl',
            sourceSeq: Number(externalId.replace(/\D/g, '')) || 1,
            externalId,
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText: JSON.stringify({ id: externalId, role, text }),
            parserName: 'test-recovery-jsonl',
            parserVersion: '1'
        }
    ]
})

const cloudMessage = (
    id: string,
    role: ChatMessage['role'],
    text: string
): ChatMessage => ({
    id,
    sessionId: 'session-1',
    role,
    contentBlocks: [{ type: 'text', text }],
    createdAt: `2026-05-10T10:00:${id.slice(-1).padStart(2, '0')}Z`
})

const sourceRow = (id: string, sourceSeq: number, rawSha256: string) => ({
    id,
    sessionId: 'session-1',
    messageId: null,
    sourceKind: 'local_session_recovery' as const,
    framework: 'claude-code',
    runtime: 'sprites',
    sourceRef: 'local-session',
    sourceFile: '/tmp/session.jsonl',
    sourceSeq,
    runnerSeq: null,
    sourceEventKey: `local:${id}`,
    externalId: id,
    parentExternalId: null,
    rawFormat: 'jsonl' as const,
    rawText: JSON.stringify({ id }),
    rawJson: null,
    rawSha256,
    rawBytes: 32,
    parserName: 'test-recovery-jsonl',
    parserVersion: '1',
    parsedAt: new Date('2026-05-10T10:00:00Z'),
    rawClearedAt: null,
    createdAt: new Date('2026-05-10T10:00:00Z'),
    updatedAt: new Date('2026-05-10T10:00:00Z')
})
