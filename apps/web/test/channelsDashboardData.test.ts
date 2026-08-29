import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChannelActivityReport, ChannelSummary } from '@manyfold/shared'
import { buildChannelActivityRows } from '../src/lib/channelsDashboardData'

const channel = (id: string, label = id): ChannelSummary =>
    ({
        id,
        userId: 'user_1',
        agentId: 'agt_1',
        agent: { id: 'agt_1', name: 'Agent' },
        provider: 'telegram',
        label,
        status: 'active',
        config: {},
        managed: false,
        inboundUrl: '',
        lastConnectedAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
    }) as unknown as ChannelSummary

const report = (
    rows: ChannelActivityReport['rows']
): ChannelActivityReport => ({
    windowDays: 30,
    since: '2026-01-01T00:00:00.000Z',
    rows
})

const row = (
    channelId: string,
    patch: Partial<ChannelActivityReport['rows'][number]> = {}
): ChannelActivityReport['rows'][number] => ({
    channelId,
    inboundCount: 0,
    outboundCount: 0,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...patch
})

test('a missing report leaves counts null rather than zero', () => {
    // "We could not read the counts" and "this channel is quiet" are
    // different statements; the dashboard renders them differently.
    const rows = buildChannelActivityRows([channel('a')], null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].messageCount, null)
    assert.equal(rows[0].inboundCount, null)
    assert.equal(rows[0].lastMessageAt, null)
})

test('a channel absent from the report zero-fills', () => {
    const rows = buildChannelActivityRows([channel('a')], report([]))
    assert.equal(rows[0].messageCount, 0)
    assert.equal(rows[0].inboundCount, 0)
    assert.equal(rows[0].lastMessageAt, null)
})

test('messageCount is inbound plus outbound', () => {
    const rows = buildChannelActivityRows(
        [channel('a')],
        report([row('a', { inboundCount: 4, outboundCount: 3 })])
    )
    assert.equal(rows[0].messageCount, 7)
    assert.equal(rows[0].inboundCount, 4)
    assert.equal(rows[0].outboundCount, 3)
})

test('lastMessageAt takes the later of the two stamps, either of which may be null', () => {
    const cases: Array<[string | null, string | null, string | null]> = [
        [null, null, null],
        ['2026-02-01T00:00:00.000Z', null, '2026-02-01T00:00:00.000Z'],
        [null, '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z'],
        [
            '2026-02-01T00:00:00.000Z',
            '2026-02-03T00:00:00.000Z',
            '2026-02-03T00:00:00.000Z'
        ],
        [
            '2026-02-05T00:00:00.000Z',
            '2026-02-03T00:00:00.000Z',
            '2026-02-05T00:00:00.000Z'
        ]
    ]
    for (const [lastInboundAt, lastOutboundAt, expected] of cases) {
        const rows = buildChannelActivityRows(
            [channel('a')],
            report([row('a', { lastInboundAt, lastOutboundAt })])
        )
        assert.equal(rows[0].lastMessageAt, expected)
    }
})

test('a channel can have zero messages in the window and still a last message', () => {
    // channel_sessions is never pruned, so this combination is normal, not a
    // contradiction the UI should hide.
    const rows = buildChannelActivityRows(
        [channel('a')],
        report([
            row('a', {
                inboundCount: 0,
                outboundCount: 0,
                lastInboundAt: '2025-06-01T00:00:00.000Z'
            })
        ])
    )
    assert.equal(rows[0].messageCount, 0)
    assert.equal(rows[0].lastMessageAt, '2025-06-01T00:00:00.000Z')
})

test('rows sort most-recent first with never-used channels last', () => {
    const rows = buildChannelActivityRows(
        [channel('zulu'), channel('old'), channel('new'), channel('alpha')],
        report([
            row('old', { lastInboundAt: '2026-01-01T00:00:00.000Z' }),
            row('new', { lastOutboundAt: '2026-03-01T00:00:00.000Z' })
        ])
    )
    assert.deepEqual(
        rows.map((r) => r.channel.id),
        ['new', 'old', 'alpha', 'zulu']
    )
})
