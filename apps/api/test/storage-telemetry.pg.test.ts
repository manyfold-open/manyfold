import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { gunzipSync, inflateSync } from 'node:zlib'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { storageFixture, waitFor } from './helpers/storage-fixture'

const RUN = process.env.RUN_PG_E2E === '1'
for (const mode of ['exec', 'admission', 'short_lease'] as const)
    test(
        `real storage exporters retain safe ${mode} failure without exec URLs, paths or caller identity`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const h = await storageFixture(t)
            const trigger = `storage_admission_${h.hostId}`
            if (mode === 'admission') {
                await h.db.execute(
                    sql`create function ${sql.identifier(trigger)}() returns trigger language plpgsql as $$ begin raise exception 'private-storage-upstream-body private-storage-token'; end $$`
                )
                await h.db.execute(
                    sql`create trigger ${sql.identifier(trigger)} before update on runtime_hosts for each row when (OLD.id = ${sql.raw(`'${h.hostId}'`)}) execute function ${sql.identifier(trigger)}()`
                )
            }
            try {
                const agent = await h.addAgent({
                    workspace: '/private-storage-workspace',
                    config: '/private-storage-config'
                })
                const traces: any[] = []
                const logs: any[] = []
                const envelopes: any[] = []
                const errors: string[] = []
                const receiver = createServer((req, res) => {
                    const chunks: Buffer[] = []
                    req.on('data', (chunk) => chunks.push(chunk))
                    req.on('end', () => {
                        try {
                            let data = Buffer.concat(chunks)
                            if (req.headers['content-encoding'] === 'gzip')
                                data = gunzipSync(data)
                            if (req.headers['content-encoding'] === 'deflate')
                                data = inflateSync(data)
                            if (req.url?.startsWith('/v1/traces'))
                                traces.push(JSON.parse(data.toString()))
                            else if (req.url?.startsWith('/v1/logs'))
                                logs.push(JSON.parse(data.toString()))
                            else {
                                const lines = data.toString().trim().split('\n')
                                for (let i = 1; i < lines.length; i += 2)
                                    envelopes.push({
                                        type: JSON.parse(lines[i]).type,
                                        event: JSON.parse(lines[i + 1])
                                    })
                            }
                        } catch (error) {
                            errors.push(String(error))
                        }
                        res.end('{}')
                    })
                })
                receiver.listen(0, '127.0.0.1')
                await once(receiver, 'listening')
                t.after(async () => {
                    receiver.closeAllConnections()
                    await new Promise<void>((resolve) =>
                        receiver.close(() => resolve())
                    )
                })
                const address = receiver.address()
                assert(address && typeof address === 'object')
                const apiRoot = path.resolve(__dirname, '..')
                const child = spawn(
                    process.execPath,
                    ['--import', 'tsx', 'test/fixtures/storage-telemetry.mjs'],
                    {
                        cwd: apiRoot,
                        env: {
                            PATH: process.env.PATH,
                            HOME: process.env.HOME,
                            TMPDIR: process.env.TMPDIR,
                            NODE_ENV: 'test',
                            TS_NODE_PROJECT: path.join(
                                apiRoot,
                                'tsconfig.json'
                            ),
                            TSX_TSCONFIG_PATH: path.join(
                                apiRoot,
                                'tsconfig.json'
                            ),
                            FLY_APP_NAME: 'isolated-storage-fixture',
                            MF_DEPLOY_ENV: 'test',
                            AXIOM_API_TOKEN: 'fixture-only',
                            AXIOM_DATASET: 'fixture',
                            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
                            OTEL_LOGS_EXPORTER: 'none',
                            OTEL_METRICS_EXPORTER: 'none',
                            SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
                            SENTRY_TRACES_SAMPLE_RATE: '1',
                            PG_FIXTURE_URL: process.env.DATABASE_URL,
                            SPRITE_FIXTURE_ORIGIN: h.origin,
                            STORAGE_FIXTURE_HOST: h.hostId,
                            STORAGE_FIXTURE_MODE: mode,
                            DOTENV_CONFIG_PATH: '/dev/null'
                        },
                        stdio: ['ignore', 'pipe', 'pipe']
                    }
                )
                let output = ''
                child.stdout.on('data', (chunk) => {
                    output += chunk
                })
                child.stderr.on('data', (chunk) => {
                    output += chunk
                })
                const terminal = once(child, 'close')
                const timer = setTimeout(() => child.kill('SIGKILL'), 25_000)
                t.after(() => {
                    clearTimeout(timer)
                    child.kill('SIGKILL')
                })
                if (mode === 'exec') {
                    try {
                        await waitFor(
                            () =>
                                h.sockets.length === 1 ||
                                child.exitCode !== null,
                            15_000
                        )
                    } catch (error) {
                        throw new Error(`${String(error)}\n${output}`)
                    }
                    assert.equal(h.sockets.length, 1, output)
                    h.sockets[0].send(
                        Buffer.concat([
                            Buffer.from([0x01]),
                            Buffer.from(
                                `__NCA_STORAGE_PHASE__ df start 1000000\n\0__NCA_STORAGE_PATH__\0${1}\0/private-storage-output\0\n__NCA_STORAGE_PHASE__ df end 2000000\n`
                            )
                        ])
                    )
                    h.sockets[0].send(
                        Buffer.concat([
                            Buffer.from([0x02]),
                            Buffer.from(
                                'private-storage-upstream-body private-storage-token'
                            )
                        ])
                    )
                    h.finish(h.sockets[0], 0, 1)
                }
                const [code, signal] = await terminal
                clearTimeout(timer)
                assert.equal(signal, null, output)
                assert.equal(code, 0, output)
                assert.deepEqual(errors, [])
                const spans = traces
                    .flatMap((batch) => batch.resourceSpans ?? [])
                    .flatMap((resource) =>
                        resource.scopeSpans.flatMap((scope: any) => scope.spans)
                    )
                const measurement = spans.find(
                    (span) => span.name === 'sprite.storage.measure'
                )
                assert(measurement, JSON.stringify(spans))
                assert(!measurement.parentSpanId)
                const attrs = Object.fromEntries(
                    measurement.attributes.map((attr: any) => [
                        attr.key,
                        attr.value.stringValue ?? attr.value.intValue
                    ])
                )
                if (mode !== 'admission')
                    assert.match(attrs.holderId, /^sma_[a-z2-7]{26}$/)
                else assert.equal(h.sockets.length, 0)
                assert.equal(attrs.trigger, 'chat')
                const actualTimeout =
                    mode === 'short_lease'
                        ? Number(/fixture exec timeout (\d+)/.exec(output)?.[1])
                        : mode === 'exec'
                          ? 8000
                          : undefined
                if (mode === 'admission')
                    assert.equal(
                        attrs.timeoutMs,
                        undefined,
                        'admission has no single configured timeout'
                    )
                else
                    assert.equal(
                        Number(attrs.timeoutMs),
                        actualTimeout,
                        'span budget must match the actual SDK timer'
                    )
                if (mode === 'short_lease') {
                    assert(actualTimeout! > 0 && actualTimeout! <= 500)
                    assert.equal(h.sockets.length, 1)
                }
                assert(
                    spans.some((span) =>
                        JSON.stringify(span).includes(
                            '/ordinary-storage-control'
                        )
                    ),
                    'unrelated automatic HTTP spans remain enabled'
                )
                const failure = envelopes.find(
                    (entry) =>
                        entry.type === 'event' &&
                        JSON.stringify(entry).includes(
                            'sprite_storage_measure_failed'
                        )
                )
                assert(failure, JSON.stringify(envelopes))
                assert.equal(failure.event.user, undefined)
                assert.deepEqual(failure.event.fingerprint, [
                    'sprite_storage_measurement',
                    mode === 'exec'
                        ? 'command'
                        : mode === 'short_lease'
                          ? 'timeout'
                          : 'persistence'
                ])
                assert.equal(
                    failure.event.contexts?.trace?.trace_id,
                    measurement.traceId
                )
                assert(Number(failure.event.extra.durationMs) >= 0)
                assert.equal(failure.event.extra.timeoutMs, actualTimeout)
                if (mode === 'short_lease')
                    assert(
                        Number(failure.event.extra.durationMs) < 2000,
                        'the real timeout must use the remaining lease, not the 8s cap'
                    )
                assert.equal(
                    failure.event.extra.phase,
                    mode === 'exec'
                        ? 'df'
                        : mode === 'short_lease'
                          ? 'first_byte'
                          : 'admission'
                )
                const records = logs
                    .flatMap((batch) => batch.resourceLogs ?? [])
                    .flatMap((resource) =>
                        resource.scopeLogs.flatMap(
                            (scope: any) => scope.logRecords
                        )
                    )
                if (mode !== 'admission')
                    assert(
                        records.some(
                            (record) =>
                                record.body?.stringValue ===
                                'sprite_storage_phase'
                        )
                    )
                assert(
                    records.some(
                        (record) =>
                            record.body?.stringValue ===
                            'sprite_storage_measure_failed'
                    )
                )
                for (const record of records.filter((entry) =>
                    [
                        'sprite_storage_measure_failed',
                        'sprite_storage_phase'
                    ].includes(entry.body?.stringValue)
                )) {
                    const budget = record.attributes.find(
                        (attribute: any) => attribute.key === 'timeoutMs'
                    )
                    assert.equal(
                        budget
                            ? Number(
                                  budget.value.intValue ??
                                      budget.value.doubleValue
                              )
                            : undefined,
                        actualTimeout
                    )
                }
                const emitted = JSON.stringify({
                    measurement,
                    records,
                    failure
                })
                for (const forbidden of [
                    h.hostId,
                    h.userId,
                    agent.id,
                    'private-storage-request-user',
                    'private-storage-token',
                    'private-storage-workspace',
                    'private-storage-config',
                    'private-storage-output',
                    'private-storage-upstream-body',
                    '__NCA_STORAGE_SEP__',
                    'cmd=',
                    '/exec?'
                ])
                    assert(
                        !emitted.includes(forbidden),
                        `measurement export contains ${forbidden}`
                    )
                const all = JSON.stringify({ spans, logs, envelopes, output })
                for (const forbidden of [
                    h.hostId,
                    h.userId,
                    agent.id,
                    'private-storage-token',
                    'private-storage-workspace',
                    'private-storage-config',
                    'private-storage-output',
                    'private-storage-upstream-body',
                    '__NCA_STORAGE_SEP__',
                    'cmd=',
                    '/exec?'
                ])
                    assert(
                        !all.includes(forbidden),
                        `automatic exporter contains ${forbidden}`
                    )
                assert(
                    !JSON.stringify(measurement).includes(
                        'exception.stacktrace'
                    )
                )
            } finally {
                if (mode === 'admission') {
                    await h.db.execute(
                        sql`drop trigger ${sql.identifier(trigger)} on runtime_hosts`
                    )
                    await h.db.execute(
                        sql`drop function ${sql.identifier(trigger)}()`
                    )
                }
            }
        }
    )
