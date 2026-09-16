import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, inflateSync } from 'node:zlib'

assert.equal(
    process.env.RUN_TELEMETRY_E2E,
    '1',
    'requires RUN_TELEMETRY_E2E=1; creates only isolated local fixtures'
)
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(apiRoot, 'package.json'))
const reportDirectory = resolve(process.argv[2])
const fatalOnly = ['fatal', 'deadline'].includes(process.argv[3])
await mkdir(reportDirectory, { recursive: true })
const report = {
    cases: [],
    sdks: {
        sentry: require('@sentry/node').SDK_VERSION,
        otel: require('@opentelemetry/sdk-node/package.json').version
    }
}
let pgName
let pgUrl
const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8' }).trim()
const listen = async (server) => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
}
const close = async (server) => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
}
const waitFor = async (fn) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        try {
            if (await fn()) return
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('fixture readiness timeout')
}
const run = async (
    name,
    mode,
    { dsn = true, rate = '1', receiverDelay = 0, status = 200 } = {}
) => {
    console.log(`running ${name}`)
    const traces = []
    const logs = []
    const envelopes = []
    const receivedAt = []
    const pending = new Set()
    const receiverErrors = []
    const receiver = createServer((request, response) => {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
            try {
                let data = Buffer.concat(chunks)
                if (request.headers['content-encoding'] === 'gzip')
                    data = gunzipSync(data)
                if (request.headers['content-encoding'] === 'deflate')
                    data = inflateSync(data)
                if (request.url.startsWith('/v1/traces'))
                    traces.push(JSON.parse(data))
                else if (request.url.startsWith('/v1/logs'))
                    logs.push(JSON.parse(data))
                else {
                    const lines = data.toString().trim().split('\n')
                    for (let i = 1; i < lines.length; i += 2)
                        envelopes.push({
                            type: JSON.parse(lines[i]).type,
                            event: JSON.parse(lines[i + 1])
                        })
                }
                receivedAt.push(Date.now())
            } catch (error) {
                receiverErrors.push(String(error))
            }
            const timer = setTimeout(() => {
                pending.delete(timer)
                response.writeHead(status).end('{}')
            }, receiverDelay)
            pending.add(timer)
        })
    })
    const sinkPort = await listen(receiver)
    const reservation = createServer()
    const appPort = await listen(reservation)
    await close(reservation)
    // An allowlist prevents inherited production credentials or exporters.
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'test',
        TSX_TSCONFIG_PATH: join(apiRoot, 'tsconfig.json'),
        TS_NODE_PROJECT: join(apiRoot, 'tsconfig.json'),
        FLY_APP_NAME: 'isolated-telemetry-fixture',
        MF_DEPLOY_ENV: 'test',
        AXIOM_API_TOKEN: 'fixture-only',
        AXIOM_DATASET: 'fixture',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${sinkPort}`,
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_BSP_SCHEDULE_DELAY: '60000',
        OTEL_BLRP_SCHEDULE_DELAY: '60000',
        SENTRY_DSN: dsn ? `http://public@127.0.0.1:${sinkPort}/1` : '',
        SENTRY_TRACES_SAMPLE_RATE: rate,
        PORT: String(appPort),
        PG_FIXTURE_URL: pgUrl,
        DOTENV_CONFIG_PATH: '/dev/null'
    }
    const child = spawn(
        process.execPath,
        [
            '--import',
            pathToFileURL(require.resolve('tsx')).href,
            join(apiRoot, 'test/fixtures/telemetry-pipeline.mjs'),
            mode
        ],
        {
            cwd: reportDirectory,
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        }
    )
    let stdout = '',
        stderr = '',
        detectedAt
    child.stdout.on('data', (data) => {
        stdout += data
    })
    child.stderr.on('data', (data) => {
        stderr += data
    })
    child.on('message', (message) => {
        detectedAt = message.detectedAt
    })
    const exited = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', (code, signal) => resolve({ code, signal }))
    })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 45000)
    try {
        if (mode !== 'workload') {
            await waitFor(
                async () =>
                    (await fetch(`http://127.0.0.1:${appPort}/api/fixture`)).ok
            )
            child.send('run')
        }
        const result = await exited
        assert.equal(result.signal, null, stderr)
        assert.equal(result.code, mode === 'fatal' ? 1 : 0, stderr)
        assert.deepEqual(receiverErrors, [])
        const finishedAt = Number(
            stdout.match(/FIXTURE_EXIT (\d+(?:\.\d+)?)/)?.[1]
        )
        const elapsed = finishedAt - detectedAt
        const spans = traces
            .flatMap((batch) => batch.resourceSpans ?? [])
            .flatMap((resource) =>
                resource.scopeSpans.flatMap((scope) =>
                    scope.spans.map((span) => ({
                        ...span,
                        scope: scope.scope.name
                    }))
                )
            )
        const records = logs
            .flatMap((batch) => batch.resourceLogs ?? [])
            .flatMap((resource) =>
                resource.scopeLogs.flatMap((scope) => scope.logRecords)
            )
        await writeFile(
            join(reportDirectory, `${name}.json`),
            JSON.stringify(
                { elapsed, spans, records, envelopes, stdout, stderr },
                null,
                2
            )
        )
        return { elapsed, spans, records, envelopes }
    } finally {
        clearTimeout(watchdog)
        await writeFile(join(reportDirectory, `${name}.log`), stdout + stderr)
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
            await exited
        }
        for (const timer of pending) clearTimeout(timer)
        await close(receiver)
    }
}
const canonicalTree = (spans) => {
    const byId = new Map(spans.map((span) => [span.spanId, span]))
    const key = (span) => [span.scope, span.name, span.kind].join('|')
    return spans
        .map((span) => {
            const ancestors = []
            let parent = byId.get(span.parentSpanId)
            while (parent) {
                ancestors.push(key(parent))
                parent = byId.get(parent.parentSpanId)
            }
            return [key(span), ...ancestors].join(' <- ')
        })
        .sort()
}
try {
    if (!fatalOnly) {
        pgName = 'mf-telemetry-' + randomBytes(5).toString('hex')
        docker(
            'run',
            '-d',
            '--name',
            pgName,
            '-e',
            'POSTGRES_PASSWORD=fixture',
            '-p',
            '127.0.0.1::5432',
            'postgres:16'
        )
        const port = docker('port', pgName, '5432/tcp').split(':').at(-1)
        pgUrl = `postgres://postgres:fixture@127.0.0.1:${port}/postgres`
        await waitFor(() => {
            try {
                docker('exec', pgName, 'pg_isready', '-U', 'postgres')
                return true
            } catch {
                return false
            }
        })
        const off = await run('dsn-off', 'workload', { dsn: false })
        const on = await run('dsn-on', 'workload')
        const zero = await run('dsn-rate-zero', 'workload', { rate: '0' })
        const trees = [off, on, zero].map(({ spans }) => canonicalTree(spans))
        report.workloads = trees
        assert.deepEqual(
            trees[1],
            trees[0],
            'DSN must not change the Axiom span graph'
        )
        assert.deepEqual(
            trees[2],
            trees[0],
            'Sentry ratio cannot control Axiom span creation'
        )
        assert.ok(off.spans.some((span) => span.name === 'business.work'))
        assert.ok(off.spans.some((span) => span.kind === 1))
        assert.ok(off.spans.some((span) => span.kind === 2))
        assert.ok(on.spans.every((span) => span.scope !== '@sentry/node'))
        for (const output of [on, zero]) {
            const events = output.envelopes
                .filter((item) => item.type === 'event')
                .map((item) => item.event)
            assert.ok(
                events.some((event) => event.user?.id === 'request-fixture')
            )
            assert.ok(
                events.some(
                    (event) =>
                        event.exception?.values?.some(
                            (error) =>
                                error.value === 'background fixture error'
                        ) && !event.user?.id
                )
            )
        }
        assert.ok(on.envelopes.some((item) => item.type === 'transaction'))
        assert.equal(
            zero.envelopes.filter((item) => item.type === 'transaction').length,
            0
        )
        report.cases.push(
            'DSN off/on/ratio-zero preserve exact Axiom span trees and error scopes'
        )
    }
    const fatalCases = [
        ['fast', {}],
        ['slow', { receiverDelay: 600 }],
        ['failed', { status: 503 }],
        ['stalled', { receiverDelay: 10000 }]
    ]
    for (const [name, options] of process.argv[3] === 'deadline'
        ? fatalCases.filter(([name]) => name === 'stalled')
        : fatalCases) {
        const output = await run(`fatal-${name}`, 'fatal', options)
        assert.ok(
            output.elapsed <= 3250,
            `fatal ${name} exceeded 3s deadline plus 250ms scheduling tolerance: ${output.elapsed}`
        )
        assert.ok(
            output.records.some(
                (record) => record.body?.stringValue === 'process.exit'
            ),
            `missing exit log: ${name}`
        )
        assert.ok(
            output.envelopes.some(
                (item) =>
                    item.type === 'event' &&
                    item.event.exception?.values?.some(
                        (error) => error.value === 'fresh boot fatal fixture'
                    )
            ),
            `missing fatal Sentry event: ${name}`
        )
        assert.ok(
            output.envelopes.some(
                (item) =>
                    item.type === 'transaction' &&
                    item.event.transaction === 'fresh-boot-backlog' &&
                    item.event.spans?.some(
                        (span) => span.description === 'backlog.child'
                    )
            ),
            `pending transaction did not reach transport before shutdown: ${name}`
        )
        report.cases.push(
            `fresh-boot fatal ${name}: both receiver bodies received, exit ${Math.round(output.elapsed)}ms`
        )
    }
    const signal = await run('signal-stalled', 'signal', {
        receiverDelay: 10000
    })
    assert.ok(
        signal.elapsed <= 1500,
        `signal flush exceeded existing 1s budget: ${signal.elapsed}`
    )
    assert.ok(
        signal.records.some(
            (record) => record.body?.stringValue === 'process.exit'
        )
    )
    report.cases.push(
        `signal retains 1s flush budget: ${Math.round(signal.elapsed)}ms`
    )
    report.pass = true
} finally {
    if (pgName) docker('rm', '-f', '-v', pgName)
    report.cleaned = true
    await writeFile(
        join(reportDirectory, 'result.json'),
        JSON.stringify(report, null, 2)
    )
}
console.log(JSON.stringify(report))
