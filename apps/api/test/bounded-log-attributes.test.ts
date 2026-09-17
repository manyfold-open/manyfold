import assert from 'node:assert/strict'
import test from 'node:test'
import {
    InMemoryLogRecordExporter,
    LoggerProvider,
    SimpleLogRecordProcessor
} from '@opentelemetry/sdk-logs'
import {
    BoundedLogAttributesProcessor,
    FLATTENED_LOG_ATTRIBUTE_KEYS
} from '../src/common/telemetry/bounded-log-attributes-processor'
import { CredentialRedactionLogProcessor } from '../src/common/telemetry/credential-redaction-processors'

const harness = () => {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({
        processors: [
            new CredentialRedactionLogProcessor(
                new BoundedLogAttributesProcessor(
                    new SimpleLogRecordProcessor(exporter)
                )
            )
        ]
    })
    return {
        exporter,
        provider,
        logger: provider.getLogger('bounded-log-fixture')
    }
}

test('fixed scalar compatibility names retain their query paths after redaction', async (t) => {
    const { exporter, provider, logger } = harness()
    t.after(() => provider.shutdown())
    assert.equal(new Set(FLATTENED_LOG_ATTRIBUTE_KEYS).size, 214)
    for (const key of FLATTENED_LOG_ATTRIBUTE_KEYS)
        logger.emit({
            body: 'compatibility',
            attributes: { [key]: 'safe-value' }
        })
    await provider.forceFlush()
    const records = exporter.getFinishedLogRecords()
    assert.equal(records.length, 214)
    for (const [index, key] of FLATTENED_LOG_ATTRIBUTE_KEYS.entries())
        assert.deepEqual(
            records[index].attributes,
            key === 'url.query' ? {} : { [key]: 'safe-value' }
        )
})

test('new keys, maps and heterogeneous arrays retain types without growing exported attribute paths', async (t) => {
    const { exporter, provider, logger } = harness()
    t.after(() => provider.shutdown())
    for (let i = 0; i < 500; i++) {
        logger.emit({
            body: 'dynamic fixture',
            attributes: {
                context: 'Fixture',
                durationMs: i,
                [`counter.${i}`]: i,
                [`result.${i}`]: {
                    count: i,
                    pending: false,
                    values: ['ok', i, null, { nested: true }]
                }
            }
        })
    }
    await provider.forceFlush()
    const records = exporter.getFinishedLogRecords()
    assert.equal(records.length, 500)
    for (const [index, record] of records.entries()) {
        assert.equal(record.droppedAttributesCount, 0)
        assert.deepEqual(Object.keys(record.attributes).sort(), [
            'context',
            'custom',
            'durationMs'
        ])
        assert.equal(record.attributes.durationMs, index)
        assert.deepEqual(record.attributes.custom, {
            [`counter.${index}`]: index,
            [`result.${index}`]: {
                count: index,
                pending: false,
                values: ['ok', index, null, { nested: true }]
            }
        })
    }
})

test('a preserved name with a nested value moves intact into the map', async (t) => {
    const { exporter, provider, logger } = harness()
    t.after(() => provider.shutdown())
    logger.emit({
        body: 'nested compatibility',
        attributes: {
            context: { newKey: { anotherKey: 3 } },
            detail: ['safe', { dynamic: false }],
            durationMs: [1, 2, 3],
            reason: [true, 'safe', 1]
        }
    })
    await provider.forceFlush()
    assert.deepEqual(exporter.getFinishedLogRecords()[0].attributes, {
        durationMs: [1, 2, 3],
        reason: [true, 'safe', 1],
        custom: {
            context: { newKey: { anotherKey: 3 } },
            detail: ['safe', { dynamic: false }]
        }
    })
})

test('custom input cannot overwrite compatible attributes and nested credentials remain redacted', async (t) => {
    const { exporter, provider, logger } = harness()
    t.after(() => provider.shutdown())
    logger.emit({
        body: 'failure token=synthetic-private',
        attributes: {
            context: 'TrustedContext',
            custom: {
                context: 'cannot overwrite',
                trace_id: 'cannot overwrite',
                nested: { authorization: 'Bearer synthetic-private' },
                values: [
                    { api_key: 'synthetic-private' },
                    'https://fixture.invalid?token=synthetic-private'
                ]
            },
            constructor: 'ordinary key',
            newValue: { token: 'synthetic-private', safe: 7 },
            'url.query': 'token=synthetic-private'
        }
    })
    await provider.forceFlush()
    const record = exporter.getFinishedLogRecords()[0]
    assert.equal(record.attributes.context, 'TrustedContext')
    assert(!('trace_id' in record.attributes))
    assert(!('url.query' in record.attributes))
    assert(!JSON.stringify(record).includes('synthetic-private'))
    assert.deepEqual(record.attributes.custom, {
        custom: {
            context: 'cannot overwrite',
            trace_id: 'cannot overwrite',
            nested: { authorization: 'REDACTED' },
            values: [
                { api_key: 'REDACTED' },
                'https://fixture.invalid/?token=REDACTED'
            ]
        },
        constructor: 'ordinary key',
        newValue: { token: 'REDACTED', safe: 7 }
    })
})
