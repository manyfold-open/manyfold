import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '@manyfold/shared'
import {
    applyRegeneratedUserMessage,
    mergeLatestMessages,
    mergeMessagesById
} from '../src/lib/chatMessages'

const message = (id: string, createdAt: string, text = id): ChatMessage => ({
    id,
    sessionId: 'session-1',
    role: 'user',
    contentBlocks: [{ type: 'text', text }],
    createdAt,
    usage: null
})

test('mergeMessagesById dedupes and keeps chronological order', () => {
    const result = mergeMessagesById(
        [
            message('msg-2', '2026-04-30T00:00:02.000Z'),
            message('msg-4', '2026-04-30T00:00:04.000Z')
        ],
        [
            message('msg-1', '2026-04-30T00:00:01.000Z'),
            message('msg-2', '2026-04-30T00:00:02.000Z', 'updated')
        ]
    )

    assert.deepEqual(
        result.map((item) => [item.id, item.contentBlocks[0]]),
        [
            ['msg-1', { type: 'text', text: 'msg-1' }],
            ['msg-2', { type: 'text', text: 'updated' }],
            ['msg-4', { type: 'text', text: 'msg-4' }]
        ]
    )
})

test('mergeLatestMessages preserves loaded older history and replaces stale tail', () => {
    const result = mergeLatestMessages(
        [
            message('msg-1', '2026-04-30T00:00:01.000Z'),
            message('msg-deleted', '2026-04-30T00:00:04.000Z')
        ],
        [
            message('msg-3', '2026-04-30T00:00:03.000Z'),
            message('msg-5', '2026-04-30T00:00:05.000Z')
        ]
    )

    assert.deepEqual(
        result.map((item) => item.id),
        ['msg-1', 'msg-3', 'msg-5']
    )
})

test('applyRegeneratedUserMessage replaces target and drops following messages', () => {
    const result = applyRegeneratedUserMessage(
        [
            message('msg-1', '2026-04-30T00:00:01.000Z'),
            message('msg-2', '2026-04-30T00:00:02.000Z'),
            message('msg-3', '2026-04-30T00:00:03.000Z')
        ],
        'msg-2',
        message('msg-2', '2026-04-30T00:00:02.000Z', 'edited'),
        ['msg-3']
    )

    assert.deepEqual(
        result.map((item) => [item.id, item.contentBlocks[0]]),
        [
            ['msg-1', { type: 'text', text: 'msg-1' }],
            ['msg-2', { type: 'text', text: 'edited' }]
        ]
    )
})

test('applyRegeneratedUserMessage removes deleted ids when target is not loaded', () => {
    const result = applyRegeneratedUserMessage(
        [
            message('msg-1', '2026-04-30T00:00:01.000Z'),
            message('msg-3', '2026-04-30T00:00:03.000Z')
        ],
        'msg-2',
        message('msg-2', '2026-04-30T00:00:02.000Z', 'edited'),
        ['msg-3']
    )

    assert.deepEqual(
        result.map((item) => item.id),
        ['msg-1', 'msg-2']
    )
})
