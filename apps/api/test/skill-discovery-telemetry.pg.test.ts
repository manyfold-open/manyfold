import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { gunzipSync, inflateSync } from 'node:zlib'
import path from 'node:path'
import test from 'node:test'
import { createDb, skillRepoScans } from '@manyfold/db'
import { eq } from 'drizzle-orm'
import { githubFixture } from './helpers/github-discovery-fixture'

const RUN = process.env.RUN_PG_E2E === '1'
for (const mode of ['upstream', 'busy'] as const)
    test(
        `real exporters retain the independent ${mode} failure without source URLs, credentials or request identity`,
        { skip: !RUN, timeout: 30_000 },
        async (t) => {
            const db = createDb(process.env.DATABASE_URL!)
            if (mode === 'busy')
                await db.insert(skillRepoScans).values({
                    key: JSON.stringify([
                        'private-source-owner',
                        'private-source-repository',
                        'main'
                    ]),
                    holderId: 'fixture-busy-holder',
                    expiresAt: new Date(Date.now() + 60_000)
                })
            t.after(async () => {
                await db
                    .delete(skillRepoScans)
                    .where(
                        eq(
                            skillRepoScans.key,
                            JSON.stringify([
                                'private-source-owner',
                                'private-source-repository',
                                'main'
                            ])
                        )
                    )
                await db.$client.end()
            })
            const github = await githubFixture(t)
            github.state.failPath = '/commits/'
            github.state.failStatus = 403
            github.state.failBody =
                'personal access token lifetime policy private-upstream-body private-platform-credential'
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
                            for (
                                let index = 1;
                                index < lines.length;
                                index += 2
                            )
                                envelopes.push({
                                    type: JSON.parse(lines[index]).type,
                                    event: JSON.parse(lines[index + 1])
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
            assert.ok(address && typeof address !== 'string')
            const apiRoot = path.resolve(__dirname, '..')
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    'test/fixtures/skill-discovery-telemetry.mjs'
                ],
                {
                    cwd: apiRoot,
                    env: {
                        PATH: process.env.PATH,
                        HOME: process.env.HOME,
                        TMPDIR: process.env.TMPDIR,
                        NODE_ENV: 'test',
                        TS_NODE_PROJECT: path.join(apiRoot, 'tsconfig.json'),
                        TSX_TSCONFIG_PATH: path.join(apiRoot, 'tsconfig.json'),
                        FLY_APP_NAME: 'isolated-telemetry-fixture',
                        MF_DEPLOY_ENV: 'test',
                        AXIOM_API_TOKEN: 'fixture-only',
                        AXIOM_DATASET: 'fixture',
                        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
                        OTEL_LOGS_EXPORTER: 'none',
                        OTEL_METRICS_EXPORTER: 'none',
                        SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
                        SENTRY_TRACES_SAMPLE_RATE: '1',
                        PG_FIXTURE_URL: process.env.DATABASE_URL,
                        GITHUB_FIXTURE_ORIGIN: github.origin,
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
            const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
            t.after(() => {
                clearTimeout(timer)
                child.kill('SIGKILL')
            })
            const [code, signal] = await once(child, 'exit')
            clearTimeout(timer)
            assert.equal(signal, null, output)
            assert.equal(code, 0, output)
            assert.deepEqual(errors, [])
            const spans = traces
                .flatMap((batch) => batch.resourceSpans ?? [])
                .flatMap((resource) =>
                    resource.scopeSpans.flatMap((scope: any) => scope.spans)
                )
            const scan = spans.find(
                (span) => span.name === 'skill.discovery.scan'
            )
            assert.ok(scan, JSON.stringify(spans))
            assert.ok(!scan.parentSpanId)
            assert.ok(
                spans.some((span) =>
                    JSON.stringify(span).includes('/ordinary-control')
                ),
                'unrelated outgoing spans remain enabled'
            )
            const event = envelopes.find(
                (entry) =>
                    entry.type === 'event' &&
                    JSON.stringify(entry).includes(
                        mode === 'busy'
                            ? 'Skill discovery is busy'
                            : 'credential_policy'
                    )
            )
            assert.ok(event)
            assert.equal(event.event.user, undefined)
            const emitted = JSON.stringify({ spans, logs, envelopes, output })
            for (const forbidden of [
                'private-source-owner',
                'private-source-repository',
                'private-platform-credential',
                'private-upstream-body'
            ])
                assert.ok(
                    !emitted.includes(forbidden),
                    `export contains ${forbidden}`
                )
            assert.ok(
                !JSON.stringify({ scan, event }).includes(
                    'private-request-user'
                )
            )
            assert.ok(
                github.requests.every(
                    (request) => request.headers.authorization === undefined
                )
            )
        }
    )
