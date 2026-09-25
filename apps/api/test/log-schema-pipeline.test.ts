import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { gunzipSync, inflateSync } from 'node:zlib'

type AnyValue = {
    stringValue?: string
    intValue?: number | string
    doubleValue?: number
    boolValue?: boolean
    arrayValue?: { values: AnyValue[] }
    kvlistValue?: { values: KeyValue[] }
}
type KeyValue = { key: string; value: AnyValue }
const decode = (value: AnyValue): unknown => {
    if (value.kvlistValue) return attributes(value.kvlistValue.values)
    if (value.arrayValue) return value.arrayValue.values.map(decode)
    if (value.intValue !== undefined) return Number(value.intValue)
    return value.stringValue ?? value.doubleValue ?? value.boolValue ?? null
}
const attributes = (values: KeyValue[]): Record<string, unknown> =>
    Object.fromEntries(values.map(({ key, value }) => [key, decode(value)]))

// This models the documented map/flatten and reject-on-new-field contract;
// it is deliberately not evidence of delivery to a hosted receiver.
const flattenedFields = (value: unknown, prefix: string): string[] => {
    if (prefix === 'attributes.custom') return [prefix]
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return [prefix]
    return Object.entries(value).flatMap(([key, child]) =>
        flattenedFields(child, `${prefix}.${key}`)
    )
}

for (const existingFields of [253, 257])
    test(
        `production OTLP batches retain business, ordinary and exit logs with ${existingFields}/257 fields occupied`,
        { timeout: 30_000 },
        async (t) => {
            const schema = new Set([
                'attributes.custom',
                ...[
                    'nca.event',
                    'trace_id',
                    'span_id',
                    'context',
                    'durationMs',
                    'reason',
                    'shutdownOutcome',
                    'exitCode',
                    'errorClass',
                    'errorMessage',
                    'stack'
                ].map((key) => `attributes.${key}`)
            ])
            for (let i = schema.size; i < existingFields; i++)
                schema.add(`fixture.existing.${i}`)
            const records: Array<Record<string, any>> = []
            const stored: Array<Record<string, any>> = []
            const spans: Array<Record<string, any>> = []
            const envelopes: Array<{
                type: string
                event: Record<string, any>
            }> = []
            const replies: Array<{
                status: number
                newFields: string[]
                records: number
            }> = []
            const receiverErrors: string[] = []
            const server = createServer((req, res) => {
                const chunks: Buffer[] = []
                req.on('data', (chunk: Buffer) => chunks.push(chunk))
                req.on('end', () => {
                    try {
                        let bytes = Buffer.concat(chunks)
                        if (req.headers['content-encoding'] === 'gzip')
                            bytes = gunzipSync(bytes)
                        if (req.headers['content-encoding'] === 'deflate')
                            bytes = inflateSync(bytes)
                        if (req.url === '/v1/logs') {
                            const batch = JSON.parse(bytes.toString())
                                .resourceLogs.flatMap(
                                    (resource: any) => resource.scopeLogs
                                )
                                .flatMap((scope: any) => scope.logRecords)
                            records.push(...batch)
                            const newFields = [
                                ...new Set<string>(
                                    batch.flatMap((record: any) =>
                                        flattenedFields(
                                            attributes(record.attributes),
                                            'attributes'
                                        )
                                    )
                                )
                            ].filter((name) => !schema.has(name))
                            const status =
                                schema.size + newFields.length > 257 ? 400 : 200
                            replies.push({
                                status,
                                newFields,
                                records: batch.length
                            })
                            if (status === 200) {
                                for (const name of newFields) schema.add(name)
                                stored.push(...batch)
                            }
                            res.writeHead(status).end(
                                status === 200
                                    ? '{}'
                                    : JSON.stringify({
                                          message: `adding '${newFields[0]}' and ${newFields.length - 1} other fields to dataset fields would exceed the column limit of 257`
                                      })
                            )
                            return
                        }
                        if (req.url === '/v1/traces') {
                            spans.push(
                                ...JSON.parse(bytes.toString())
                                    .resourceSpans.flatMap(
                                        (resource: any) => resource.scopeSpans
                                    )
                                    .flatMap((scope: any) => scope.spans)
                            )
                        } else {
                            const lines = bytes.toString().trim().split('\n')
                            for (let i = 1; i < lines.length; i += 2)
                                envelopes.push({
                                    type: JSON.parse(lines[i]).type,
                                    event: JSON.parse(lines[i + 1])
                                })
                        }
                        res.end('{}')
                    } catch (error) {
                        receiverErrors.push(String(error))
                        res.writeHead(500).end()
                    }
                })
            })
            await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve)
            )
            t.after(async () => {
                server.closeAllConnections()
                await new Promise<void>((resolve) =>
                    server.close(() => resolve())
                )
            })
            const address = server.address()
            assert(address && typeof address !== 'string')
            const directory = await mkdtemp(
                join(tmpdir(), 'manyfold-log-schema-')
            )
            t.after(() => rm(directory, { recursive: true, force: true }))
            const apiRoot = resolve(__dirname, '..')
            const require = createRequire(join(apiRoot, 'package.json'))
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    pathToFileURL(require.resolve('tsx')).href,
                    join(__dirname, 'fixtures/log-schema-pipeline.mjs')
                ],
                {
                    cwd: directory,
                    env: {
                        PATH: process.env.PATH,
                        HOME: process.env.HOME,
                        TMPDIR: process.env.TMPDIR,
                        NODE_ENV: 'test',
                        TS_NODE_PROJECT: join(apiRoot, 'tsconfig.json'),
                        TSX_TSCONFIG_PATH: join(apiRoot, 'tsconfig.json'),
                        FLY_APP_NAME: 'isolated-log-schema-fixture',
                        MF_DEPLOY_ENV: 'test',
                        AXIOM_API_TOKEN: 'fixture-only',
                        AXIOM_DATASET: 'fixture',
                        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
                        OTEL_METRICS_EXPORTER: 'none',
                        OTEL_BSP_SCHEDULE_DELAY: '60000',
                        OTEL_BLRP_SCHEDULE_DELAY: '60000',
                        SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
                        SENTRY_TRACES_SAMPLE_RATE: '1'
                    },
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            )
            const watchdog = setTimeout(() => child.kill('SIGKILL'), 25_000)
            let output = ''
            child.stdout.on('data', (chunk) => {
                output += chunk
            })
            child.stderr.on('data', (chunk) => {
                output += chunk
            })
            const exited = new Promise<number | null>((resolve, reject) => {
                child.once('error', reject)
                child.once('exit', resolve)
            })
            t.after(async () => {
                clearTimeout(watchdog)
                if (child.exitCode === null && child.signalCode === null)
                    child.kill('SIGKILL')
                await exited
            })
            assert.equal(await exited, 0, output)
            clearTimeout(watchdog)
            assert.deepEqual(receiverErrors, [])
            assert.equal(records.length, 4)
            assert(!JSON.stringify(records).includes('synthetic-private'))
            assert.deepEqual(
                replies,
                [
                    { status: 200, newFields: [], records: 3 },
                    { status: 200, newFields: [], records: 1 }
                ],
                output
            )
            assert.equal(
                stored.length,
                4,
                'HTTP success must also preserve all stored fixture rows'
            )
            assert.equal(schema.size, existingFields)
            const business = stored.find(
                (row) => row.body.stringValue === 'fixture.scan'
            )!
            const fields = attributes(business.attributes)
            assert.equal(fields.durationMs, 7)
            assert.equal((fields.custom as any).candidates, 2)
            assert.equal((fields.custom as any).recheckMs, 60_000)
            assert.equal(
                stored.find((row) => row.body.stringValue === 'process.exit')
                    ?.severityNumber,
                17
            )
            assert.deepEqual(
                attributes(
                    stored.find(
                        (row) => row.body.stringValue === 'fixture.structured'
                    )!.attributes
                ),
                {
                    durationMs: [1, 2, 3],
                    custom: {
                        context: { nested: true },
                        custom: {
                            context: 'cannot overwrite',
                            nested: { token: 'REDACTED' }
                        },
                        arbitrary: [
                            7,
                            false,
                            null,
                            { authorization: 'REDACTED' }
                        ]
                    }
                }
            )
            const root = spans.find((span) => span.name === 'fixture.scan')!
            assert(root)
            assert.equal(
                spans.find((span) => span.name === 'fixture.child')
                    ?.parentSpanId,
                root.spanId
            )
            assert.equal(attributes(root.attributes).candidates, 2)
            assert.equal(attributes(root.events[0].attributes).candidates, '2')
            assert(
                envelopes.some((envelope) => envelope.type === 'transaction')
            )
            assert(envelopes.some((envelope) => envelope.type === 'event'))
        }
    )
