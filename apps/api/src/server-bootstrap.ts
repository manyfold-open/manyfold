import {
    CHAT_UPLOAD_MAX_COUNT,
    CHAT_UPLOAD_MAX_FILE_BYTES,
    DAEMON_WS_MAX_PAYLOAD_BYTES
} from '@manyfold/shared'
import { otel, flushSentrySpans, flushOtelLogs } from './otel'
import { captureApiException, flushSentry } from './sentry'
import 'reflect-metadata'
import { Readable } from 'node:stream'
import fastifyWebsocket from '@fastify/websocket'
import fastifyMultipart from '@fastify/multipart'
import { NestFactory } from '@nestjs/core'
import {
    FastifyAdapter,
    type NestFastifyApplication
} from '@nestjs/platform-fastify'
import { ValidationPipe, Logger, type Type } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter'
import { OtelNestLogger } from '@/common/telemetry/otel-nest-logger'
import { isRawBodyPath } from '@/common/raw-body-paths'
import { registerChannelFormBodyGuard } from '@/modules/channels/webhook-body-parser'
import { registerOctetStreamParser } from '@/modules/agents/files/octet-stream-parser'
import {
    ChatService,
    type TurnShutdownResult
} from '@/modules/chat/chat.service'
import {
    emitProcessExit,
    processExitLogLine,
    type ProcessExitReason,
    type ProcessExitRecord
} from './process-lifecycle'
import { describeFatalError } from './fatal-error'

const TURN_DRAIN_TIMEOUT_MS = 15_000
const SHUTDOWN_CLOSE_TIMEOUT_MS = 8_500
const SHUTDOWN_TOTAL_TIMEOUT_MS = 27_000
const OTEL_FLUSH_TIMEOUT_MS = 1_000
// Fatal flushes race a busy process's span backlog, which overran the 1s
// budget while handleFatal's hardExit authorised 3s (#528). The signal path
// keeps 1s: its 27s shutdown backstop plus a bigger flush budget would
// collide with fly's 30s kill_timeout.
const FATAL_FLUSH_TIMEOUT_MS = 2_500
const FATAL_HANDOFF_TIMEOUT_MS = 1_000
const WS_DRAIN_TIMEOUT_MS = 5_000

let chatService: ChatService | null = null
let exitRecord: ProcessExitRecord | null = null
let exitFinalizing = false
let fatalHandling = false

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

// Delivery-importance order (#528): the process.exit record first — one small
// POST whose socket write lands before span conversion can starve the event
// loop — then pending Sentry spans, which have to reach the Sentry client
// before the SDK teardown discards them, then the Sentry transport (the fatal
// event leaves here), and the bulk OTel teardown last. The caller races the
// whole chain against its flush budget, so a lost race now only costs the
// least important tail.
const flushTelemetry = async (): Promise<void> => {
    await flushOtelLogs()
    await flushSentrySpans()
    await flushSentry(OTEL_FLUSH_TIMEOUT_MS)
    await otel.shutdown().catch(() => undefined)
}

const finalizeExit = (
    record: ProcessExitRecord,
    onCommitted?: () => void
): void => {
    if (exitFinalizing) return
    exitFinalizing = true
    exitRecord = record
    const flushBudgetMs =
        record.shutdownOutcome === 'fatal'
            ? FATAL_FLUSH_TIMEOUT_MS
            : OTEL_FLUSH_TIMEOUT_MS
    const hardExit = setTimeout(
        () => process.exit(record.exitCode),
        flushBudgetMs + 250
    )
    onCommitted?.()
    try {
        emitProcessExit(record)
    } catch {}
    console.log(processExitLogLine(record))
    void Promise.race([flushTelemetry(), delay(flushBudgetMs)]).finally(() => {
        clearTimeout(hardExit)
        process.exit(record.exitCode)
    })
}

const fatalTurnResult = async (): Promise<TurnShutdownResult | null> => {
    const service = chatService
    if (!service) return null
    return Promise.race([
        service.prepareForShutdown(0),
        delay(FATAL_HANDOFF_TIMEOUT_MS).then(() => null)
    ])
}

const handleFatal = (reason: ProcessExitReason, error: unknown): void => {
    if (fatalHandling || exitFinalizing) return
    fatalHandling = true
    const startedAt = Date.now()
    const detail = describeFatalError(error)
    console.error(`process fatal reason=${reason}`, error)
    const hardExit = setTimeout(() => process.exit(1), 3_000)
    void fatalTurnResult()
        .catch(() => null)
        .then((turns) => {
            finalizeExit(
                {
                    reason,
                    shutdownOutcome: 'fatal',
                    exitCode: 1,
                    durationMs: Date.now() - startedAt,
                    errorClass: detail.errorClass,
                    errorMessage: detail.errorMessage,
                    ...(detail.stack ? { stack: detail.stack } : {}),
                    ...(turns
                        ? {
                              turnDrainOutcome: turns.drainOutcome,
                              activeTurnsAtStart: turns.activeTurnsAtStart,
                              activeTurnsRemaining: turns.activeTurnsRemaining,
                              handedOffTurns: turns.handedOffTurns,
                              handoffOutcome: turns.handoffOutcome
                          }
                        : {})
                },
                () => clearTimeout(hardExit)
            )
        })
}

process.on('uncaughtException', (error) =>
    handleFatal('uncaught_exception', error)
)
process.on('unhandledRejection', (reason) =>
    handleFatal('unhandled_rejection', reason)
)
process.on('exit', (code) => {
    if (exitRecord) return
    console.error(
        `process.exit ${JSON.stringify({
            reason: 'unclassified',
            exitCode: code
        })}`
    )
})

const bootstrap = async (rootModule: Type<unknown>): Promise<void> => {
    const app = await NestFactory.create<NestFastifyApplication>(
        rootModule,
        // forceCloseConnections lets app.close() drop idle keep-alive sockets
        // (e.g. the Vite dev proxy) instead of waiting on them forever, so a
        // restart's graceful shutdown can actually complete.
        new FastifyAdapter({ logger: false, forceCloseConnections: 'idle' }),
        // abortOnError: false — Nest otherwise process.exit(1)s on module init
        // failures before bootstrap().catch can run handleFatal, so boot
        // crashes would leave no process.exit record beyond 'unclassified'.
        { bufferLogs: true, abortOnError: false }
    )
    app.useLogger(new OtelNestLogger())

    const config = app.get(ConfigService)
    const port = Number(config.get('PORT') ?? 2222)
    const corsOrigin = (config.get<string>('CORS_ORIGIN') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

    await app.register(fastifyWebsocket, {
        options: { maxPayload: DAEMON_WS_MAX_PAYLOAD_BYTES }
    })

    await app.register(fastifyMultipart, {
        limits: {
            fileSize: CHAT_UPLOAD_MAX_FILE_BYTES,
            files: CHAT_UPLOAD_MAX_COUNT
        }
    })

    const fastify = app.getHttpAdapter().getInstance()
    registerOctetStreamParser(fastify)
    registerChannelFormBodyGuard(fastify)
    fastify.addHook('preParsing', (req, _reply, payload, done) => {
        const url = req.raw.url ?? ''
        if (!isRawBodyPath(url)) {
            done(null, payload)
            return
        }
        const chunks: Buffer[] = []
        payload.on('data', (chunk: Buffer | string) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        )
        payload.on('end', () => {
            const buf = Buffer.concat(chunks)
            ;(req as unknown as { rawBody?: string }).rawBody =
                buf.toString('utf8')
            done(null, Readable.from([buf]))
        })
        payload.on('error', (err: Error) => done(err))
    })
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter(captureApiException))
    app.enableCors({
        origin: corsOrigin.length > 0 ? corsOrigin : true,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: 86_400
    })

    await app.listen(port, '0.0.0.0')
    Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap')
    chatService = app.get(ChatService)

    let shuttingDown = false
    const handleShutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return
        shuttingDown = true
        const startedAt = Date.now()
        let turns: TurnShutdownResult | null = null
        let appCloseFailed = false
        const totalTimeout = setTimeout(() => {
            finalizeExit({
                reason: 'signal',
                signal,
                shutdownOutcome: 'forced_timeout',
                exitCode: 0,
                durationMs: Date.now() - startedAt,
                ...(turns
                    ? {
                          turnDrainOutcome: turns.drainOutcome,
                          activeTurnsAtStart: turns.activeTurnsAtStart,
                          activeTurnsRemaining:
                              chatService?.activeTurnCount() ??
                              turns.activeTurnsRemaining,
                          handedOffTurns: turns.handedOffTurns,
                          handoffOutcome: turns.handoffOutcome
                      }
                    : {})
            })
        }, SHUTDOWN_TOTAL_TIMEOUT_MS)
        void (async (): Promise<void> => {
            const activeTurnsAtStart = chatService?.activeTurnCount() ?? 0
            Logger.log(
                `shutdown.start signal=${signal} activeTurns=${activeTurnsAtStart}`,
                'Bootstrap'
            )
            turns = (await chatService?.prepareForShutdown(
                TURN_DRAIN_TIMEOUT_MS
            )) ?? {
                drainOutcome: 'idle',
                activeTurnsAtStart: 0,
                activeTurnsRemaining: 0,
                handedOffTurns: 0,
                handoffOutcome: 'not_needed'
            }
            Logger.log(
                `shutdown.turns drain=${turns.drainOutcome} activeAtStart=${turns.activeTurnsAtStart} ` +
                    `remaining=${turns.activeTurnsRemaining} handedOff=${turns.handedOffTurns} ` +
                    `handoff=${turns.handoffOutcome}`,
                'Bootstrap'
            )
            const closeTimeout = setTimeout(() => {
                finalizeExit(
                    {
                        reason: 'signal',
                        signal,
                        shutdownOutcome: 'forced_timeout',
                        exitCode: 0,
                        durationMs: Date.now() - startedAt,
                        turnDrainOutcome: turns?.drainOutcome,
                        activeTurnsAtStart: turns?.activeTurnsAtStart,
                        activeTurnsRemaining:
                            chatService?.activeTurnCount() ??
                            turns?.activeTurnsRemaining,
                        handedOffTurns: turns?.handedOffTurns,
                        handoffOutcome: turns?.handoffOutcome
                    },
                    () => clearTimeout(totalTimeout)
                )
            }, SHUTDOWN_CLOSE_TIMEOUT_MS)
            try {
                const wss = fastify.websocketServer
                if (wss?.clients?.size) {
                    Logger.log(
                        `shutdown.draining ws clients=${wss.clients.size}`,
                        'Bootstrap'
                    )
                    for (const client of wss.clients) {
                        try {
                            client.close(1012, 'service restart')
                        } catch {}
                    }
                    await delay(WS_DRAIN_TIMEOUT_MS)
                }
                await app.close()
            } catch (err) {
                appCloseFailed = true
                Logger.error('shutdown.app_close_failed', err, 'Bootstrap')
            }
            Logger.log('shutdown.complete', 'Bootstrap')
            clearTimeout(closeTimeout)
            clearTimeout(totalTimeout)
            finalizeExit({
                reason: 'signal',
                signal,
                shutdownOutcome: appCloseFailed ? 'close_error' : 'complete',
                exitCode: 0,
                durationMs: Date.now() - startedAt,
                turnDrainOutcome: turns.drainOutcome,
                activeTurnsAtStart: turns.activeTurnsAtStart,
                activeTurnsRemaining:
                    chatService?.activeTurnCount() ??
                    turns.activeTurnsRemaining,
                handedOffTurns: turns.handedOffTurns,
                handoffOutcome: turns.handoffOutcome
            })
        })()
    }
    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))
}

// Shared entry for every API composition root (the OSS AppModule today, the
// cloud root once it ships): identical plugins, prefix, pipes, shutdown and
// fatal-exit orchestration, differing only in which module graph boots.
export const startApiServer = (rootModule: Type<unknown>): void => {
    bootstrap(rootModule).catch((error) => {
        // bufferLogs + OtelNestLogger swallow Logger output when init fails before the
        // buffer flushes; raw console.error keeps boot crashes (e.g. Postgres down) visible
        console.error('bootstrap failed', error)
        Logger.error('bootstrap', error)
        handleFatal('bootstrap_failure', error)
    })
}
