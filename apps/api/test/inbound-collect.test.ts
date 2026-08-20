import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelDeliveryRow } from '@manyfold/db'
import {
    composeCollectedInbound,
    parseStoredInboundEvent
} from '../src/modules/channels/inbound-collect'

let nextId = 1n
const queuedRow = (
    event: Record<string, unknown> | null,
    overrides: Partial<ChannelDeliveryRow> = {}
): ChannelDeliveryRow => ({
    id: (nextId += 1n),
    channelId: 'chn-1',
    chatSessionId: 'sess-1',
    chatMessageId: null,
    direction: 'inbound',
    scopeKey: 'fake:chat-1',
    providerEventId: `evt-${nextId}`,
    providerMessageId: `evt-${nextId}`,
    eventJson: event,
    summaryText: null,
    status: 'queued',
    errorMessage: 'inflight_turn',
    attemptCount: 0,
    sendAttemptStartedAt: null,
    turnMessageId: null,
    nextAttemptAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
})

const storedEvent = (
    text: string,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
    providerEventId: `pe-${text}`,
    chatId: 'chat-1',
    chatType: 'private',
    senderId: 'user-1',
    senderName: 'Alice',
    text,
    threadId: null,
    isMention: false,
    messageId: `pm-${text}`,
    raw: {},
    ...overrides
})

test('collect merges the text-only prefix with the last row as carrier', () => {
    const rows = [
        queuedRow(storedEvent('first')),
        queuedRow(storedEvent('second')),
        queuedRow(storedEvent('third'))
    ]
    const composed = composeCollectedInbound(rows)
    assert.ok(composed)
    assert.equal(composed.carrierId, rows[2].id)
    assert.deepEqual(composed.mergedIds, [rows[0].id, rows[1].id])
    const merged = parseStoredInboundEvent(composed.eventJson)
    assert.ok(merged)
    assert.match(
        merged.text,
        /^\[3 messages arrived while a turn was running — answering together\]/
    )
    assert.match(merged.text, /1\. first\n2\. second\n3\. third/)
    assert.equal(
        merged.messageId,
        'pm-third',
        'reply anchoring follows the newest message'
    )
})

test('collect labels senders only when the merged set has more than one', () => {
    const same = composeCollectedInbound([
        queuedRow(storedEvent('a')),
        queuedRow(storedEvent('b'))
    ])
    assert.ok(same)
    assert.doesNotMatch(String(same.eventJson.text), /\[Alice\]/)

    const mixed = composeCollectedInbound([
        queuedRow(storedEvent('a')),
        queuedRow(storedEvent('b', { senderId: 'user-2', senderName: 'Bob' }))
    ])
    assert.ok(mixed)
    assert.match(String(mixed.eventJson.text), /1\. \[Alice\] a/)
    assert.match(String(mixed.eventJson.text), /2\. \[Bob\] b/)
})

test('attachments and unparseable rows end the merge prefix', () => {
    const withAttachment = composeCollectedInbound([
        queuedRow(storedEvent('text')),
        queuedRow(
            storedEvent('photo', {
                attachments: [{ url: 'https://x/a.png', name: 'a.png' }]
            })
        ),
        queuedRow(storedEvent('after'))
    ])
    assert.equal(
        withAttachment,
        null,
        'prefix of one is not worth a rewrite — replay handles it'
    )

    const withInvalid = composeCollectedInbound([
        queuedRow(null),
        queuedRow(storedEvent('a')),
        queuedRow(storedEvent('b'))
    ])
    assert.equal(withInvalid, null, 'invalid head keeps its own drop path')
})

test('collect returns null for fewer than two mergeable rows', () => {
    assert.equal(composeCollectedInbound([]), null)
    assert.equal(
        composeCollectedInbound([queuedRow(storedEvent('only'))]),
        null
    )
})

test('collect summary is truncated for the delivery ledger', () => {
    const composed = composeCollectedInbound([
        queuedRow(storedEvent('x'.repeat(300))),
        queuedRow(storedEvent('y'))
    ])
    assert.ok(composed)
    assert.ok(composed.summaryText.length <= 200)
    assert.ok(composed.summaryText.endsWith('…'))
})
