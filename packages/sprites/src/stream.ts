import {
    request as httpRequest,
    type IncomingMessage,
    type OutgoingHttpHeaders
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { classifyHttpStatus, retryAfterMs, SpritesError } from './errors'
import { redact, redactHeaders } from './redaction'
import type {
    SpriteUpgradeEvent,
    SpriteUpgradeResult,
    SpritesLogger
} from './types'

// A line longer than this is not an event, and a stream past the total is
// not one worth reading on.
const MAX_LINE_BYTES = 64 * 1024
const MAX_STREAM_BYTES = 1024 * 1024
const MAX_ERROR_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 512

const TERMINAL: Record<string, SpriteUpgradeResult['outcome']> = {
    completed: 'completed',
    failed: 'failed',
    error: 'failed',
    skipped: 'skipped'
}

export interface UpgradeWatch {
    url: string
    // For messages: the path as the REST client names it.
    path: string
    authHeader: string
    body?: Record<string, unknown>
    onAccepted?: () => void
    onEvent?: (event: SpriteUpgradeEvent) => void
    signal?: AbortSignal
    connectTimeoutMs: number
    timeoutMs: number
    idleTimeoutMs: number
    logger: SpritesLogger
}

const textField = (
    data: Record<string, unknown> | undefined,
    ...keys: string[]
): string | null => {
    for (const key of keys) {
        const value = data?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return null
}

const safeJson = (text: string): unknown => {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

const headerOf = (res: IncomingMessage, name: string): string | undefined => {
    const value = res.headers[name]
    return Array.isArray(value) ? value[0] : value
}

// Watches an upgrade's NDJSON stream to its terminal event. node:http(s)
// rather than fetch, because fetch ends a body that has been quiet for 300 s.
// Measured on local [2026-10-19]: a storage-migrating upgrade sent nothing
// for 329 s after starting_machine while it copied the disk, and an upgrade
// whose watcher hung up 3 s in still applied about 30 s later.
// A refusal before the stream starts (409, storage migration not allowed)
// rejects like any request; once accepted, the watch only ever resolves.
export const watchUpgrade = (
    watch: UpgradeWatch
): Promise<SpriteUpgradeResult> =>
    new Promise((resolve, reject) => {
        const target = new URL(watch.url)
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest
        const payload =
            watch.body === undefined ? undefined : JSON.stringify(watch.body)
        const named: Record<string, string> = {
            Authorization: watch.authHeader,
            Accept: 'application/x-ndjson'
        }
        if (payload !== undefined) named['Content-Type'] = 'application/json'
        const headers: OutgoingHttpHeaders = {
            ...named,
            ...(payload !== undefined
                ? { 'Content-Length': Buffer.byteLength(payload) }
                : {})
        }
        watch.logger.debug('sprites.request', {
            method: 'POST',
            url: watch.url,
            headers: redactHeaders(named)
        })

        let settled = false
        let accepted = false
        let targetVersion: string | null = null
        let lastEvent: string | null = null
        let idleTimer: NodeJS.Timeout | undefined
        let totalTimer: NodeJS.Timeout | undefined

        const finish = (result: SpriteUpgradeResult | Error): void => {
            if (settled) return
            settled = true
            clearTimeout(connectTimer)
            clearTimeout(idleTimer)
            clearTimeout(totalTimer)
            watch.signal?.removeEventListener('abort', onAbort)
            req.destroy()
            if (result instanceof Error) reject(result)
            else resolve(result)
        }
        const stop = (
            stoppedBecause: NonNullable<SpriteUpgradeResult['stoppedBecause']>
        ): void =>
            finish({
                outcome: 'incomplete',
                targetVersion,
                message: null,
                lastEvent,
                stoppedBecause
            })
        const failed = (message: string): SpritesError =>
            new SpritesError(
                'transient',
                `sprites.dev POST ${watch.path} ${message}`
            )
        const onAbort = (): void => {
            if (accepted) stop('aborted')
            else finish(failed('aborted'))
        }
        const armIdle = (): void => {
            clearTimeout(idleTimer)
            idleTimer = setTimeout(() => stop('idle'), watch.idleTimeoutMs)
        }

        const handleLine = (line: string): void => {
            if (Buffer.byteLength(line) > MAX_LINE_BYTES) return
            const event = safeJson(line) as SpriteUpgradeEvent | undefined
            // Anything that is not an event (a banner, a blank keepalive).
            if (!event || typeof event.type !== 'string') return
            lastEvent = event.type
            targetVersion =
                textField(event.data, 'target_version') ?? targetVersion
            watch.onEvent?.(event)
            const outcome = TERMINAL[event.type]
            if (!outcome) return
            const message = textField(event.data, 'message', 'error', 'reason')
            finish({
                outcome,
                targetVersion,
                message: message
                    ? redact(message).slice(0, MAX_MESSAGE_CHARS)
                    : null,
                lastEvent
            })
        }

        const onRefused = (res: IncomingMessage, status: number): void => {
            const chunks: Buffer[] = []
            let size = 0
            res.on('data', (chunk: Buffer) => {
                if (size >= MAX_ERROR_BODY_BYTES) return
                chunks.push(chunk)
                size += chunk.length
            })
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                const code = classifyHttpStatus(status)
                watch.logger.warn('sprites.error', {
                    status,
                    code,
                    body: redact(text).slice(0, 2048)
                })
                finish(
                    new SpritesError(
                        code,
                        `sprites.dev POST ${watch.path} → ${status}`,
                        status,
                        safeJson(text) ?? text,
                        {
                            retryAfterMs: retryAfterMs(
                                headerOf(res, 'retry-after')
                            )
                        }
                    )
                )
            })
            res.on('error', (err) =>
                finish(failed(`network error: ${err.message}`))
            )
        }

        const onAccepted = (res: IncomingMessage): void => {
            accepted = true
            clearTimeout(connectTimer)
            watch.onAccepted?.()
            armIdle()
            totalTimer = setTimeout(() => stop('timeout'), watch.timeoutMs)
            let buffer = ''
            let total = 0
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
                if (settled) return
                total += Buffer.byteLength(chunk)
                if (total > MAX_STREAM_BYTES) return stop('too_large')
                armIdle()
                buffer += chunk
                let at: number
                while (!settled && (at = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, at).trim()
                    buffer = buffer.slice(at + 1)
                    if (line) handleLine(line)
                }
                if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) buffer = ''
            })
            res.on('end', () => {
                if (buffer.trim()) handleLine(buffer.trim())
                stop('ended')
            })
            res.on('error', () => stop('ended'))
        }

        const req = send(target, { method: 'POST', headers }, (res) => {
            const status = res.statusCode ?? 0
            if (status >= 200 && status < 300) onAccepted(res)
            else onRefused(res, status)
        })
        const connectTimer = setTimeout(
            () => finish(failed(`timed out after ${watch.connectTimeoutMs}ms`)),
            watch.connectTimeoutMs
        )
        req.on('error', (err) => {
            if (accepted) stop('ended')
            else finish(failed(`network error: ${err.message}`))
        })
        if (watch.signal?.aborted) {
            finish(failed('aborted'))
            return
        }
        watch.signal?.addEventListener('abort', onAbort, { once: true })
        req.end(payload)
    })
