import assert from 'node:assert/strict'
import test from 'node:test'
import { contextUsageFromMessageMetadata } from '../src/modules/chat/message-page'
import type { ChatMessage as DbChatMessage } from '@manyfold/db'

// The read-back half of the context-usage metadata: what runAdapter merged
// into capability_events_json must survive the trip into ChatMessage, and
// junk shapes must read as absent rather than as zeros.
const row = (capabilityEventsJson: unknown): DbChatMessage =>
    ({ capabilityEventsJson }) as DbChatMessage

test('reads {size, used} out of the message metadata', () => {
    assert.deepEqual(
        contextUsageFromMessageMetadata(
            row({ model: 'm', contextUsage: { size: 256000, used: 900 } })
        ),
        { size: 256000, used: 900 }
    )
})

test('clamps a negative used and refuses a non-positive size', () => {
    assert.deepEqual(
        contextUsageFromMessageMetadata(
            row({ contextUsage: { size: 100, used: -5 } })
        ),
        { size: 100, used: 0 }
    )
    assert.equal(
        contextUsageFromMessageMetadata(
            row({ contextUsage: { size: 0, used: 5 } })
        ),
        null
    )
})

test('absent, null, non-object and non-numeric shapes read as absent', () => {
    assert.equal(contextUsageFromMessageMetadata(row(null)), null)
    assert.equal(contextUsageFromMessageMetadata(row({ model: 'm' })), null)
    assert.equal(
        contextUsageFromMessageMetadata(row({ contextUsage: 'big' })),
        null
    )
    assert.equal(
        contextUsageFromMessageMetadata(
            row({ contextUsage: { size: '256000', used: 900 } })
        ),
        null
    )
    assert.equal(
        contextUsageFromMessageMetadata(
            row({ contextUsage: { size: Infinity, used: 1 } })
        ),
        null
    )
})
