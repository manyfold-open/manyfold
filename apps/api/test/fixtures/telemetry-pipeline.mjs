import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('tsconfig-paths/register')
const { performance } = require('node:perf_hooks')
const { otel, flushOtelLogs, flushSentrySpans } = require('../../src/otel.ts')
const Sentry = require('@sentry/node')
const { context, ROOT_CONTEXT, trace } = require('@opentelemetry/api')
const {
    captureApiException,
    flushSentry,
    setSentryRequestContext
} = require('../../src/sentry.ts')
const {
    inBackgroundContext
} = require('../../src/common/telemetry/background-context.ts')
const http = require('node:http')
const tracer = trace.getTracer('telemetry-fixture')
const mode = process.argv[2]

const get = (url) =>
    new Promise((resolve, reject) => {
        http.get(url, (response) => {
            response.resume()
            response.on('end', resolve)
        }).on('error', reject)
    })

async function workload() {
    const postgres = require('postgres')
    const sql = postgres(process.env.PG_FIXTURE_URL, { max: 1 })
    const fastify = require('fastify')()
    fastify.addHook('preHandler', async () => {})
    fastify.get('/fixture', async () => {
        setSentryRequestContext('request-fixture', { owner: 'request-fixture' })
        return tracer.startActiveSpan('business.work', async (span) => {
            try {
                await sql`select 42 as answer`
                captureApiException(new Error('request fixture error'))
                return { ok: true }
            } finally {
                span.end()
            }
        })
    })
    const origin = await fastify.listen({ host: '127.0.0.1', port: 0 })
    for (let i = 0; i < 2; i++) await get(origin + '/fixture')
    await inBackgroundContext(async () => {
        await tracer.startActiveSpan('background.work', async (span) => {
            try {
                await sql`select 7 as answer`
                captureApiException(new Error('background fixture error'))
            } finally {
                span.end()
            }
        })
    })()
    await fastify.close()
    await sql.end()
    await flushSentrySpans()
    await flushSentry(2000)
    await otel.shutdown()
}

async function lifecycle() {
    const { SentrySpanProcessor } = require('@sentry/opentelemetry')
    const forceFlush = SentrySpanProcessor.prototype.forceFlush
    let pendingRoot
    // End the fixture root at the real flush boundary so its transaction
    // cannot escape via the SDK's earlier automatic debounce.
    SentrySpanProcessor.prototype.forceFlush = function () {
        pendingRoot?.end()
        pendingRoot = undefined
        return forceFlush.call(this)
    }
    require('reflect-metadata')
    const { Module, Controller, Get } = require('@nestjs/common')
    const { ConfigService } = require('@nestjs/config')
    const { ChatService } = require('../../src/modules/chat/chat.service.ts')
    const { startApiServer } = require('../../src/server-bootstrap.ts')
    class FixtureController {
        ready() {
            return { ok: true }
        }
    }
    Controller('fixture')(FixtureController)
    Get()(
        FixtureController.prototype,
        'ready',
        Object.getOwnPropertyDescriptor(FixtureController.prototype, 'ready')
    )
    class FixtureModule {}
    Module({
        controllers: [FixtureController],
        providers: [
            {
                provide: ConfigService,
                useValue: {
                    get: (key) =>
                        key === 'PORT' ? process.env.PORT : undefined
                }
            },
            {
                provide: ChatService,
                useValue: {
                    activeTurnCount: () => 0,
                    prepareForShutdown: () =>
                        mode === 'fatal'
                            ? new Promise(() => {})
                            : Promise.resolve({
                                  drainOutcome: 'idle',
                                  activeTurnsAtStart: 0,
                                  activeTurnsRemaining: 0,
                                  handedOffTurns: 0,
                                  handoffOutcome: 'not_needed'
                              })
                }
            }
        ]
    })(FixtureModule)
    startApiServer(FixtureModule)
    process.on('message', () => {
        context.with(ROOT_CONTEXT, () => {
            const root = tracer.startSpan('fresh-boot-backlog')
            pendingRoot = root
            context.with(trace.setSpan(context.active(), root), () => {
                for (let i = 0; i < 2000; i++)
                    tracer.startSpan('backlog.child').end()
            })
            // Leave the root open, as a real in-flight turn would be at a crash.
        })
        process.send({ detectedAt: performance.now() })
        if (mode === 'fatal')
            Promise.reject(new Error('fresh boot fatal fixture'))
        else process.kill(process.pid, 'SIGTERM')
    })
    process.on('exit', () => {
        require('node:fs').writeSync(1, `FIXTURE_EXIT ${performance.now()}\n`)
    })
}

void (mode === 'workload' ? workload() : lifecycle()).catch(async (error) => {
    console.error(error)
    await flushOtelLogs()
    await Sentry.close(1000)
    await otel.shutdown()
    process.exitCode = 2
})
