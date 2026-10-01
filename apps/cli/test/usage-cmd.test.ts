import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import { json, runMf, type Route } from './fixtures/fake-api'

// The root --agent-id defaults to $MF_AGENT_ID, which a runtime sets.
const NO_AGENT = { MF_AGENT_ID: undefined }

const emptySummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    eventCount: 0,
    fallbackEventCount: 0,
    byModel: []
}

const routes = (over: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /usage/summary': () => json(emptySummary),
    'GET /usage/timeseries': () => json([]),
    'GET /usage/events': () => json({ items: [], nextCursor: null }),
    'GET /usage/sessions': () => json([]),
    'GET /usage/top-agents': () => json([]),
    ...over
})

test('bad usage options are refused before anything is sent', async () => {
    for (const args of [
        ['usage', 'timeseries', '--bucket', 'month'],
        ['usage', 'events', '--limit', 'abc'],
        ['usage', 'events', '--limit', '-1'],
        ['usage', 'events', '--limit', '0'],
        ['usage', 'events', '--limit', '201'],
        ['usage', 'top-agents', '--limit', '101'],
        ['usage', 'summary', '--from', 'garbage'],
        ['usage', 'sessions', '--to', '2026-02-30'],
        ['usage', 'top-agents', '--from', '1']
    ]) {
        const run = await runMf(args, routes(), NO_AGENT)
        assert.ok(run.error instanceof CommanderError, args.join(' '))
        assert.deepEqual(run.calls, [], args.join(' '))
    }
})

test('good options reach the query as given', async () => {
    const events = await runMf(
        [
            'usage',
            'events',
            '--limit',
            '200',
            '--from',
            '2026-10-01',
            '--to',
            '2026-10-02T00:00:00+01:00'
        ],
        routes(),
        NO_AGENT
    )
    assert.equal(events.error, undefined, String(events.error))
    const query = events.calls[0]?.query
    assert.equal(query?.get('limit'), '200')
    assert.equal(query?.get('from'), '2026-10-01')
    assert.equal(query?.get('to'), '2026-10-02T00:00:00+01:00')

    const hourly = await runMf(
        ['usage', 'timeseries', '--bucket', 'hour'],
        routes(),
        NO_AGENT
    )
    assert.equal(hourly.calls[0]?.query.get('bucket'), 'hour')
})
