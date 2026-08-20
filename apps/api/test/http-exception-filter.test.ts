import 'reflect-metadata'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    HttpException,
    InternalServerErrorException,
    NotFoundException,
    UnprocessableEntityException,
    type ArgumentsHost
} from '@nestjs/common'
import {
    context,
    trace,
    ROOT_CONTEXT,
    type Context,
    type ContextManager
} from '@opentelemetry/api'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'

// The default no-op context manager ignores context.with(), so getActiveSpan()
// inside the filter would never see our span. catch() is synchronous, so a
// plain stack swap is a sufficient real manager.
class SyncContextManager implements ContextManager {
    private current: Context = ROOT_CONTEXT
    active(): Context {
        return this.current
    }
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
        ctx: Context,
        fn: F,
        thisArg?: ThisParameterType<F>,
        ...args: A
    ): ReturnType<F> {
        const previous = this.current
        this.current = ctx
        try {
            return fn.call(thisArg, ...args)
        } finally {
            this.current = previous
        }
    }
    bind<T>(_ctx: Context, target: T): T {
        return target
    }
    enable(): this {
        return this
    }
    disable(): this {
        return this
    }
}

interface Captured {
    status?: number
    body?: {
        ok: boolean
        error: {
            code: string
            message: string
            details?: { kind?: string; traceId?: string }
        }
    }
    headers: Record<string, string>
}

const fakeHost = (captured: Captured): ArgumentsHost =>
    ({
        switchToHttp: () => ({
            getResponse: () => ({
                status(code: number) {
                    captured.status = code
                    return this
                },
                send(body: unknown) {
                    captured.body = body as Captured['body']
                    return this
                },
                header(name: string, value: string) {
                    captured.headers[name] = value
                    return this
                }
            })
        })
    }) as unknown as ArgumentsHost

const SPAN_CONTEXT = {
    traceId: '493568c70d90636e9e5ac1b5ac77527f',
    spanId: '00112233445566aa',
    traceFlags: 1
}

test('a non-HttpException 500 carries the real cause, kind and traceId', () => {
    // The dev502 register failure: PostgresError 23505 used to become a
    // literal 'Internal server error' — no cause, no way to find the trace.
    class PostgresError extends Error {}
    const captured: Captured = { headers: {} }
    assert.ok(context.setGlobalContextManager(new SyncContextManager()))
    try {
        context.with(
            trace.setSpan(
                context.active(),
                trace.wrapSpanContext(SPAN_CONTEXT)
            ),
            () =>
                new HttpExceptionFilter().catch(
                    new PostgresError(
                        'duplicate key value violates unique constraint "agent_runtimes_user_name_unique"'
                    ),
                    fakeHost(captured)
                )
        )
    } finally {
        context.disable()
    }
    assert.equal(captured.status, 500)
    assert.equal(captured.body?.error.code, 'internal_error')
    assert.match(
        captured.body?.error.message ?? '',
        /agent_runtimes_user_name_unique/
    )
    assert.equal(captured.body?.error.details?.kind, 'PostgresError')
    assert.equal(captured.body?.error.details?.traceId, SPAN_CONTEXT.traceId)
})

test('sensitive URL query values are redacted before leaving the API', () => {
    // The sprites exec WSS URL carries key/env/cmd in its query (#264); an
    // exception message quoting it must not echo our injected token back.
    const captured: Captured = { headers: {} }
    new HttpExceptionFilter().catch(
        new Error('wss://sprites.dev/exec?key=SECRETTOKEN&cmd=ls'),
        fakeHost(captured)
    )
    assert.equal(captured.status, 500)
    assert.doesNotMatch(captured.body?.error.message ?? '', /SECRETTOKEN/)
    assert.match(captured.body?.error.message ?? '', /REDACTED/)
})

test('the HttpException branch is unchanged', () => {
    const captured: Captured = { headers: {} }
    new HttpExceptionFilter().catch(
        new NotFoundException('agent runtime art_x not found'),
        fakeHost(captured)
    )
    assert.equal(captured.status, 404)
    assert.equal(captured.body?.error.code, 'not_found')
    assert.equal(
        captured.body?.error.message,
        'agent runtime art_x not found'
    )
    assert.equal(captured.body?.error.details, undefined)
})

test('unexpected failures are reported, expected 4xx ones are not', () => {
    // Sentry is for things nobody chose to return. A 404 or a validation
    // failure is a normal outcome of an authenticated API and would bury the
    // real crashes in noise.
    const reported: unknown[] = []
    const filter = new HttpExceptionFilter((e) => reported.push(e))

    filter.catch(new Error('pool timeout'), fakeHost({ headers: {} }))
    assert.equal(reported.length, 1)

    filter.catch(
        new InternalServerErrorException('upstream exploded'),
        fakeHost({ headers: {} })
    )
    assert.equal(reported.length, 2)

    filter.catch(new NotFoundException('nope'), fakeHost({ headers: {} }))
    filter.catch(
        new UnprocessableEntityException('bad name'),
        fakeHost({ headers: {} })
    )
    assert.equal(reported.length, 2)
})

test('a typed 500 hands its response body to the reporter', () => {
    // #551: Sentry stored only 'daemon detach failed' while the classified
    // reason and identifiers lived exclusively in the exception's response
    // object. The reporter must receive that body as extra context.
    const reported: Array<{ extra?: Record<string, unknown> }> = []
    const filter = new HttpExceptionFilter((_e, extra) =>
        reported.push({ extra })
    )

    filter.catch(
        new InternalServerErrorException({
            code: 'agent.daemon_detach_failed',
            message: 'daemon detach failed',
            details: { reason: 'daemon dh-1 is offline', daemonId: 'dh-1' }
        }),
        fakeHost({ headers: {} })
    )
    assert.equal(reported.length, 1)
    const response = reported[0].extra?.response as {
        details: { reason: string }
    }
    assert.equal(response.details.reason, 'daemon dh-1 is offline')

    filter.catch(
        new HttpException('plain string body', 500),
        fakeHost({ headers: {} })
    )
    assert.equal(reported.length, 2)
    assert.equal(
        reported[1].extra,
        undefined,
        'a string body has nothing structured to attach'
    )
})

test('a filter built without a reporter still answers the request', () => {
    // main.ts injects the real reporter; everything else (tests, any future
    // caller) must not depend on one existing.
    const captured: Captured = { headers: {} }
    new HttpExceptionFilter().catch(new Error('boom'), fakeHost(captured))
    assert.equal(captured.status, 500)
})
