import test from 'node:test'
import assert from 'node:assert/strict'
import type {
    UserModelProviderSummary,
    UserModelProviderUsage,
    UserModelProviderUsageReport
} from '@manyfold/shared'
import {
    buildSpendRows,
    spendTotals,
    spendWindowFrom,
    totalTokens
} from '../src/lib/modelProviderSpend'
import { daysAgoIso } from '../src/lib/usageFormat'

const provider = (id: string, name = id): UserModelProviderSummary =>
    ({
        id,
        providerName: name,
        inferenceProtocol: 'openai_chat_completions',
        builtInId: null,
        externalAccountId: null,
        apiKeyMasked: 'sk-***abcd',
        baseUrl: null,
        modelsListUrl: null,
        source: 'byo',
        managedService: null,
        managedKeyId: null,
        managedBrand: null,
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
        lastTestModels: null,
        enabledModels: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
    }) as UserModelProviderSummary

const usage = (
    patch: Partial<UserModelProviderUsage>
): UserModelProviderUsage =>
    ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        unpricedEventCount: 0,
        eventCount: 0,
        lastUsedAt: null,
        ...patch
    }) as UserModelProviderUsage

const report = (
    rows: UserModelProviderUsageReport['rows']
): UserModelProviderUsageReport => ({ from: null, to: null, rows })

test('spendWindowFrom follows the inclusive-of-today convention', () => {
    assert.equal(spendWindowFrom('all'), undefined)
    assert.equal(spendWindowFrom('7d'), daysAgoIso(6))
    assert.equal(spendWindowFrom('30d'), daysAgoIso(29))
})

test('a missing report leaves usage null rather than zero', () => {
    // Not-loaded and never-used must not render the same: one is "we do not
    // know", the other is "we know it is nothing".
    const rows = buildSpendRows([provider('a')], null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].usage, null)

    const zeroed = buildSpendRows([provider('a')], report([]))
    assert.equal(zeroed[0].usage?.eventCount, 0)
    assert.equal(zeroed[0].usage?.costUsd, null)
})

test('providers join their usage row and unused providers zero-fill', () => {
    const rows = buildSpendRows(
        [provider('a'), provider('b')],
        report([
            {
                modelProviderId: 'a',
                usage: usage({ costUsd: 2, eventCount: 3, inputTokens: 10 })
            }
        ])
    )
    const a = rows.find((r) => r.provider?.id === 'a')
    const b = rows.find((r) => r.provider?.id === 'b')
    assert.equal(a?.usage?.costUsd, 2)
    assert.equal(a?.usage?.eventCount, 3)
    assert.equal(b?.usage?.eventCount, 0)
})

test('the unattributed group appears only when it carries events', () => {
    const empty = buildSpendRows(
        [provider('a')],
        report([{ modelProviderId: null, usage: usage({ eventCount: 0 }) }])
    )
    assert.equal(
        empty.some((r) => r.key === 'unattributed'),
        false
    )

    const withSpend = buildSpendRows(
        [provider('a')],
        report([
            {
                modelProviderId: null,
                usage: usage({ costUsd: 0.5, eventCount: 2 })
            }
        ])
    )
    const row = withSpend.find((r) => r.key === 'unattributed')
    assert.ok(row)
    assert.equal(row.provider, null)
    assert.equal(row.usage?.costUsd, 0.5)
})

test('rows sort priced first, then unknown cost, then never used', () => {
    const rows = buildSpendRows(
        [
            provider('unused'),
            provider('unknown'),
            provider('cheap'),
            provider('rich')
        ],
        report([
            {
                modelProviderId: 'cheap',
                usage: usage({ costUsd: 1, eventCount: 1 })
            },
            {
                modelProviderId: 'rich',
                usage: usage({ costUsd: 9, eventCount: 1 })
            },
            {
                modelProviderId: 'unknown',
                usage: usage({ costUsd: null, eventCount: 4 })
            }
        ])
    )
    assert.deepEqual(
        rows.map((r) => r.provider?.id),
        ['rich', 'cheap', 'unknown', 'unused']
    )
})

test('totals sum only the priced rows and carry the unpriced count', () => {
    const rows = buildSpendRows(
        [provider('a'), provider('b')],
        report([
            {
                modelProviderId: 'a',
                usage: usage({
                    costUsd: 2,
                    unpricedEventCount: 1,
                    eventCount: 3
                })
            },
            {
                modelProviderId: 'b',
                usage: usage({
                    costUsd: null,
                    unpricedEventCount: 5,
                    eventCount: 5
                })
            }
        ])
    )
    assert.deepEqual(spendTotals(rows), {
        costUsd: 2,
        unpricedEventCount: 6,
        eventCount: 8
    })
})

test('a total over nothing priced stays null, never zero', () => {
    const rows = buildSpendRows(
        [provider('a')],
        report([
            {
                modelProviderId: 'a',
                usage: usage({
                    costUsd: null,
                    unpricedEventCount: 2,
                    eventCount: 2
                })
            }
        ])
    )
    assert.equal(spendTotals(rows).costUsd, null)
    assert.equal(
        spendTotals(buildSpendRows([provider('a')], null)).costUsd,
        null
    )
})

test('totalTokens adds every token column', () => {
    assert.equal(
        totalTokens(
            usage({
                inputTokens: 1,
                outputTokens: 2,
                cacheReadTokens: 4,
                cacheCreationTokens: 8
            })
        ),
        15
    )
})
