import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
    createBrowserErrorLimiter,
    createBrowserTelemetry,
    isForeignBrowserError,
    normalizeBrowserError,
    reportBrowserWebVital
} from '../src/browser-telemetry'

const signature = 'Invalid call to runtime.sendMessage(). Tab not found.'
const origin = 'https://manyfold.test'

test('foreign extension signatures normalize across string, Error and cross-realm objects', () => {
    for (const reason of [
        signature,
        new Error(signature),
        runInNewContext('new Error(message)', { message: signature })
    ])
        assert.equal(
            isForeignBrowserError(normalizeBrowserError(reason), origin),
            true
        )
    assert.equal(
        isForeignBrowserError(
            {
                message: 'other',
                stack: '',
                filename: 'moz-extension://id/background.js'
            },
            origin
        ),
        true
    )
    assert.equal(
        isForeignBrowserError(
            {
                message: signature,
                stack: `at ${origin}/assets/app.js:12:1`,
                filename: ''
            },
            origin
        ),
        false
    )
    assert.equal(
        isForeignBrowserError(
            {
                message: signature,
                stack: '',
                filename: `${origin}/assets/app.js`
            },
            origin
        ),
        false
    )
    assert.equal(
        isForeignBrowserError(
            normalizeBrowserError(new Error('real application failure')),
            origin
        ),
        false
    )
    const hostile = new Proxy(
        {},
        {
            get() {
                throw new Error('getter failure')
            }
        }
    )
    assert.deepEqual(normalizeBrowserError(hostile), {
        message: 'Unknown browser error',
        stack: '',
        filename: ''
    })
    assert.equal(
        normalizeBrowserError(Object.create(null)).message,
        'Unknown browser error'
    )
    assert.equal(normalizeBrowserError(503).message, '503')
    assert.equal(normalizeBrowserError(null).message, 'null')
    assert.equal(
        normalizeBrowserError(Symbol('failed')).message,
        'Symbol(failed)'
    )
})

test('20,000 repeated errors emit one detail and one counted summary per window', () => {
    let now = 0
    const reports: unknown[] = []
    const limiter = createBrowserErrorLimiter({
        now: () => now,
        onSummary: (rows) => reports.push(rows)
    })
    const error = normalizeBrowserError(new Error('first-party failure'))
    let allowed = 0
    for (let i = 0; i < 20_000; i++) if (limiter.allow(error, false)) allowed++
    assert.equal(allowed, 1)
    limiter.flushSummary()
    const rows = reports[0] as Array<{
        fingerprint: string
        suppressedCount: number
        reason: string
    }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].suppressedCount, 19_999)
    assert.equal(rows[0].reason, 'duplicate')
    assert.match(rows[0].fingerprint, /^[a-f\d]{8}$/)
    assert.equal(limiter.allow(error, false), null)
    limiter.flushSummary()
    assert.equal(
        reports.length,
        1,
        'lifecycle flush cannot reset the rate limit'
    )
    now = 60_000
    assert.ok(limiter.allow(error, false))
    limiter.flushSummary()
    assert.equal(reports.length, 2)
    assert.equal((reports[1] as typeof rows)[0].suppressedCount, 1)
})

test('unique-error floods bound both emitted details and fingerprint memory', () => {
    const reports: Array<
        Array<{ fingerprint: string; suppressedCount: number }>
    > = []
    const limiter = createBrowserErrorLimiter({
        onSummary: (rows) => reports.push(rows)
    })
    let emitted = 0
    for (let i = 0; i < 20_000; i++) {
        const unique = String.fromCharCode(
            65 + (i % 26),
            65 + (Math.floor(i / 26) % 26),
            65 + Math.floor(i / 676)
        )
        if (limiter.allow(normalizeBrowserError('error ' + unique), false))
            emitted++
    }
    limiter.flushSummary()
    assert.equal(emitted, 100)
    assert.equal(reports[0].length, 1)
    assert.deepEqual(reports[0][0], {
        fingerprint: 'overflow',
        reason: 'capacity',
        suppressedCount: 19_900
    })
})

const fixture = () => {
    const rows: Array<{
        level: string
        name: string
        fields: Record<string | symbol, unknown>
    }> = []
    let flushed = 0
    const log =
        (level: string) =>
        (name: string, fields: Record<string | symbol, unknown> = {}) => {
            rows.push({ level, name, fields })
        }
    const logger = {
        info: log('info'),
        warn: log('warn'),
        error: log('error'),
        flush: async () => {
            flushed++
        }
    }
    return { rows, logger, flushed: () => flushed }
}

test('Axiom and Sentry independently retain first-party errors and suppress extension floods', async () => {
    const { rows, logger } = fixture()
    const telemetry = createBrowserTelemetry(logger, { origin })
    for (let i = 0; i < 20_000; i++) {
        telemetry.capture('unhandledrejection', signature)
        assert.equal(telemetry.beforeSend({ message: signature }), null)
    }
    const appError = new Error('application failure')
    const event = {
        exception: {
            values: [
                {
                    value: appError.message,
                    stacktrace: {
                        frames: [{ filename: `${origin}/app.js`, in_app: true }]
                    }
                }
            ]
        }
    }
    telemetry.capture('unhandledrejection', appError)
    assert.equal(
        telemetry.beforeSend(event, { originalException: appError }),
        event
    )
    assert.equal(
        telemetry.beforeSend(event, { originalException: appError }),
        null
    )
    await telemetry.flush()
    assert.equal(rows.filter((row) => row.level === 'error').length, 1)
    assert.match(String(rows[0].fields.reason), /application failure/)
    const summaries = rows.filter(
        (row) => row.name === 'browser.error.suppressed'
    )
    assert.equal(summaries.length, 2)
    assert.equal(summaries[0].fields.suppressedCount, 20_000)
    assert.equal(summaries[1].fields.suppressedCount, 20_001)
})

test('error capture and lifecycle flush do not manufacture a telemetry rejection', async () => {
    const logger = {
        info: () => {},
        warn: () => {
            throw new Error('logger failed')
        },
        error: () => {
            throw new Error('logger failed')
        },
        flush: async () => {
            throw new Error('flush failed')
        }
    }
    const telemetry = createBrowserTelemetry(logger, { origin })
    assert.doesNotThrow(() =>
        telemetry.capture('unhandledrejection', new Error('first-party'))
    )
    await assert.doesNotReject(telemetry.flush())
    telemetry.capture('unhandledrejection', signature)
    await assert.doesNotReject(telemetry.flush())
})

test('installed listeners flush on hide/pagehide, never prevent default, and dispose cleanly', async () => {
    const f = fixture()
    const win = new EventTarget() as EventTarget & {
        setInterval: typeof setInterval
        clearInterval: typeof clearInterval
    }
    const timers = new Set<ReturnType<typeof setInterval>>()
    win.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const timer = setInterval(...args)
        timers.add(timer)
        return timer
    }) as typeof setInterval
    win.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
        timers.delete(timer)
        clearInterval(timer)
    }) as typeof clearInterval
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    const telemetry = createBrowserTelemetry(f.logger, { origin })
    const dispose = telemetry.install(
        win as unknown as Window,
        doc as unknown as Document
    )
    const rejection = Object.assign(
        new Event('unhandledrejection', { cancelable: true }),
        { reason: signature }
    )
    win.dispatchEvent(rejection)
    assert.equal(rejection.defaultPrevented, false)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    assert.equal(f.flushed(), 2)
    assert.equal(f.rows.length, 1)
    dispose()
    win.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), {
            reason: 'app failure'
        })
    )
    assert.equal(f.rows.length, 1)
    assert.equal(timers.size, 0)
})

test('Web Vitals projects only scalar fields and normalizes document routes', () => {
    const { rows, logger } = fixture()
    const element: { stateNode?: unknown } = {}
    element.stateNode = element
    const metric = {
        name: 'LCP',
        value: 12,
        rating: 'good',
        delta: 12,
        id: 'metric',
        navigationType: 'navigate',
        entries: [{ element }]
    }
    reportBrowserWebVital(
        logger,
        metric,
        '/agents/agt_abcdefghijklmnopqrstuvwxyz/chat?key=secret'
    )
    const event = rows[0].fields[Symbol.for('logging.event')] as {
        path: string
        webVital: object
        source: string
    }
    assert.equal(event.path, '/agents/:id/chat')
    assert.equal(event.source, 'web-vital')
    assert.deepEqual(event.webVital, {
        name: 'LCP',
        value: 12,
        rating: 'good',
        delta: 12,
        id: 'metric',
        navigationType: 'navigate'
    })
    assert.doesNotThrow(() => JSON.stringify(event))
    reportBrowserWebVital(logger, metric, '/invite/private-token')
    assert.equal(
        (rows[1].fields[Symbol.for('logging.event')] as typeof event).path,
        '/invite/REDACTED'
    )
    assert.equal(metric.entries[0].element.stateNode, element)
})

test('Safari stacks without an error header still retain the error message', () => {
    const { rows, logger } = fixture()
    const telemetry = createBrowserTelemetry(logger, { origin })
    telemetry.capture('unhandledrejection', {
        message: 'original application failure',
        stack: 'handler@https://manyfold.test/app.js:10:2'
    })
    assert.match(String(rows[0].fields.reason), /original application failure/)
    assert.match(String(rows[0].fields.reason), /handler@/)
})

test('error fingerprints keep distinct HTTP status codes separate', () => {
    const limiter = createBrowserErrorLimiter({ onSummary: () => {} })
    const unauthorized = limiter.allow(
        normalizeBrowserError('Request failed: 401'),
        false
    )
    const internal = limiter.allow(
        normalizeBrowserError('Request failed: 500'),
        false
    )
    assert.ok(unauthorized)
    assert.ok(internal)
    assert.notEqual(unauthorized, internal)
})
