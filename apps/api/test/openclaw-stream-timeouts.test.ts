import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent,
    EmittedErrorEvent
} from '../src/modules/chat/chat-adapter'

// #513. The direct gateway path used ONE AbortSignal.timeout for the request
// headers and the entire SSE read, so a turn that was still emitting events
// every few seconds died at the absolute mark and was reported as
// `openclaw_stream_stall` ("went silent"). These tests run the real
// sendMessage against a real HTTP gateway so the budgets are exercised through
// undici's actual abort plumbing, not a stubbed fetch: the point of the fix is
// that aborting the BODY stream is now driven by inactivity, and a mock that
// resolves read() on demand cannot fail the way production did.
//
// Budgets are read from process.env at module load, so the override has to be
// installed before the adapter is imported — hence the dynamic import in each
// test. Real timers on purpose: mocked time cannot prove that a watchdog
// rearms against a socket that is genuinely trickling.
// 1_000 is the adapter's own floor on both budgets; anything smaller is
// clamped up and the test would be asserting against the clamp.
const HEADERS_TIMEOUT_MS = 1_000
const IDLE_TIMEOUT_MS = 1_000
process.env.OPENCLAW_HEADERS_TIMEOUT_MS = String(HEADERS_TIMEOUT_MS)
process.env.OPENCLAW_STREAM_IDLE_TIMEOUT_MS = String(IDLE_TIMEOUT_MS)
process.env.OPENCLAW_PREFLIGHT_TIMEOUT_MS = String(1_000)
process.env.OPENCLAW_PREFLIGHT_BUDGET_MS = String(2_000)
process.env.K8S_INGRESS_SCHEME = 'http'

const GENEROUS_MAX_MS = 30_000

interface Gateway {
    host: string
    close: () => Promise<void>
}

// HEAD `/` is the adapter's preflight and always answers immediately; every
// other request is the chat POST the test is scripting.
const startGateway = async (
    onPost: (res: ServerResponse) => void
): Promise<Gateway> => {
    const open = new Set<ServerResponse>()
    const server: Server = createServer((req, res) => {
        if (req.method === 'HEAD') {
            res.writeHead(200)
            res.end()
            return
        }
        open.add(res)
        req.resume()
        req.on('end', () => onPost(res))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return {
        host: `127.0.0.1:${port}`,
        close: async () => {
            for (const res of open) res.destroy()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }
}

const sseHeaders = (res: ServerResponse): void => {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
    })
}

// Emits one delta every intervalMs. Returns a stop handle so a test can never
// leave an interval running past its own gateway.
const trickle = (
    res: ServerResponse,
    intervalMs: number,
    total: number | 'forever'
): (() => void) => {
    sseHeaders(res)
    let n = 0
    const timer = setInterval(() => {
        if (total !== 'forever' && n >= total) {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
            return
        }
        n++
        res.write(
            `data: ${JSON.stringify({
                id: `chunk-${n}`,
                choices: [{ delta: { content: `t${n}` } }]
            })}\n\n`
        )
    }, intervalMs)
    return () => clearInterval(timer)
}

interface TelemetryEvent {
    name: string
    attrs: Record<string, unknown>
}

const makeDb = (host: string) => {
    const rows = [
        [{ runtime: 'sprites', internalId: 'main', daemonId: null }],
        [
            {
                ingressHost: host,
                runtimeId: 'art_1',
                framework: 'openclaw',
                internalId: 'main',
                name: 'main'
            }
        ],
        [{ payloadCiphertext: 'ct', keyVersion: 1 }]
    ]
    let i = 0
    return {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => rows[Math.min(i++, rows.length - 1)]
                })
            })
        })
    }
}

const buildAdapter = async (
    host: string,
    maxDurationMs: number
): Promise<{
    adapter: { sendMessage: OpenclawSend }
    events: TelemetryEvent[]
}> => {
    const { OpenclawAdapter } =
        await import('../src/modules/chat/adapters/openclaw.adapter')
    const events: TelemetryEvent[] = []
    const adapter = new OpenclawAdapter(
        makeDb(host) as never,
        {
            decrypt: () =>
                JSON.stringify({
                    gatewayToken: 'tok',
                    primaryModelName: 'claude'
                })
        } as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        {} as never,
        {} as never,
        {
            event: (name: string, attrs: Record<string, unknown>) =>
                events.push({ name, attrs })
        } as never,
        undefined,
        {
            getCachedChatExecTimeoutMs: async () => ({
                keepAliveMs: 20_000,
                livenessTimeoutMs: 75_000,
                timeoutMs: maxDurationMs
            })
        } as never
    )
    return { adapter, events }
}

type OpenclawSend = (
    ctx: ApiChatAdapterContext,
    message: ChatMessage
) => AsyncIterable<EmittedChatEvent>

const ctxFor = (abortSignal?: AbortSignal): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'openclaw',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        // truthy so the post-success session-ref backfill (an exec through
        // drivers, not stubbed here) is skipped
        frameworkSessionRef: 'fsr-1',
        history: [],
        ...(abortSignal ? { abortSignal } : {})
    }) as ApiChatAdapterContext

const userMessage = (): ChatMessage => ({
    id: 'msg_user',
    sessionId: 'cts_1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-08-05T00:00:00.000Z'
})

const drain = async (
    source: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of source) out.push(ev)
    return out
}

const onlyError = (events: EmittedChatEvent[]): EmittedErrorEvent => {
    const err = events.find((ev) => ev.type === 'error')
    assert.ok(err, `expected an error event, got ${events.map((e) => e.type)}`)
    return err as EmittedErrorEvent
}

const outcomeOf = (events: TelemetryEvent[]): Record<string, unknown> => {
    const ev = events.find((e) => e.name === 'openclaw_chat_completed')
    assert.ok(ev, 'the adapter must emit openclaw_chat_completed')
    return ev.attrs
}

// WHY: this is the reported bug verbatim. The turn keeps producing events the
// whole time and simply runs longer than the inactivity budget; before the
// split that was a guaranteed truncation labelled "stream went silent".
test('a stream that keeps emitting past the inactivity budget completes normally', async () => {
    let stop = (): void => {}
    const gw = await startGateway((res) => {
        stop = trickle(res, 150, 12)
    })
    try {
        const { adapter } = await buildAdapter(gw.host, GENEROUS_MAX_MS)
        const startedAt = Date.now()
        const events = await drain(adapter.sendMessage(ctxFor(), userMessage()))
        const elapsed = Date.now() - startedAt
        assert.ok(
            elapsed > IDLE_TIMEOUT_MS,
            `the turn must outlive the ${IDLE_TIMEOUT_MS}ms inactivity budget for this test to mean anything (ran ${elapsed}ms)`
        )
        assert.ok(
            !events.some((ev) => ev.type === 'error'),
            'an actively streaming turn must not surface any error'
        )
        const tokens = events.filter((ev) => ev.type === 'token')
        assert.equal(
            tokens.length,
            12,
            'every delta emitted before [DONE] must reach the caller'
        )
        assert.equal(events.at(-1)?.type, 'done')
    } finally {
        stop()
        await gw.close()
    }
})

// WHY: the inactivity budget must still catch a genuinely wedged upstream —
// the fix widens what counts as alive, it does not remove the detector.
test('true silence after headers still yields a retryable openclaw_stream_stall', async () => {
    const gw = await startGateway((res) => {
        sseHeaders(res)
        res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`
        )
        // then nothing, forever
    })
    try {
        const { adapter, events: telemetry } = await buildAdapter(
            gw.host,
            GENEROUS_MAX_MS
        )
        const events = await drain(adapter.sendMessage(ctxFor(), userMessage()))
        const { error } = onlyError(events)
        assert.equal(error.code, 'openclaw_stream_stall')
        assert.equal(
            error.retryable,
            true,
            'a wedged upstream is worth retrying'
        )
        assert.match(error.message, /went silent/)
        const attrs = outcomeOf(telemetry)
        assert.equal(
            attrs['nca.timeout_kind'],
            'stream_idle',
            'triage must be able to tell WHICH budget fired without reading the message'
        )
        assert.ok(
            (attrs['nca.last_activity_age_ms'] as number) >= IDLE_TIMEOUT_MS,
            'the stall must be reported with how long the stream had actually been silent'
        )
        assert.equal(attrs['nca.stream_idle_timeout_ms'], IDLE_TIMEOUT_MS)
    } finally {
        await gw.close()
    }
})

// WHY: connect-phase failure and mid-stream silence are different operational
// problems (gateway busy booting vs upstream model hung) and #36 split the
// codes for exactly that reason; the split budgets must preserve it.
test('headers that never arrive fail as openclaw_no_response, not as a stall', async () => {
    const gw = await startGateway(() => {
        // accept the POST and never write a status line
    })
    try {
        const { adapter, events: telemetry } = await buildAdapter(
            gw.host,
            GENEROUS_MAX_MS
        )
        const events = await drain(adapter.sendMessage(ctxFor(), userMessage()))
        const { error } = onlyError(events)
        assert.equal(error.code, 'openclaw_no_response')
        assert.equal(error.retryable, true)
        assert.match(error.message, /response headers within 1s/)
        assert.equal(outcomeOf(telemetry)['nca.timeout_kind'], 'headers')
    } finally {
        await gw.close()
    }
})

// WHY: a wall-clock ceiling still exists (it is what stops a looping agent from
// billing a sprite for hours) but it is a DIFFERENT failure from silence, and
// conflating the two is what made the original telemetry lie.
test('the total cap fires under its own code while the stream is still active', async () => {
    const MAX_MS = 900
    let stop = (): void => {}
    const gw = await startGateway((res) => {
        stop = trickle(res, 100, 'forever')
    })
    try {
        const { adapter, events: telemetry } = await buildAdapter(
            gw.host,
            MAX_MS
        )
        const events = await drain(adapter.sendMessage(ctxFor(), userMessage()))
        const { error } = onlyError(events)
        assert.equal(
            error.code,
            'openclaw_turn_timeout',
            'a still-streaming turn stopped by the ceiling must never be reported as a stall'
        )
        assert.equal(
            error.retryable,
            false,
            'an identical retry hits the same configured ceiling — the remedy is raising it'
        )
        assert.ok(
            events.some((ev) => ev.type === 'token'),
            'the deltas produced before the ceiling still reach the caller'
        )
        const attrs = outcomeOf(telemetry)
        assert.equal(attrs['nca.timeout_kind'], 'max_duration')
        assert.equal(
            attrs['nca.max_duration_ms'],
            MAX_MS,
            'the cap comes from the admin chat exec budget, not an openclaw constant'
        )
        assert.ok(
            (attrs['nca.last_activity_age_ms'] as number) < IDLE_TIMEOUT_MS,
            'the stream was demonstrably alive when the ceiling cut it'
        )
    } finally {
        stop()
        await gw.close()
    }
})

// WHY: the direct path never wired ctx.abortSignal into the request, so a
// cancel left the gateway generating into a socket nobody read. Widening the
// budgets makes that leak last far longer, so cancel has to be immediate.
test('user cancel aborts the live request immediately', async () => {
    let stop = (): void => {}
    const gw = await startGateway((res) => {
        stop = trickle(res, 100, 'forever')
    })
    try {
        const { adapter } = await buildAdapter(gw.host, GENEROUS_MAX_MS)
        const controller = new AbortController()
        const startedAt = Date.now()
        setTimeout(() => controller.abort(), 250)
        const events = await drain(
            adapter.sendMessage(ctxFor(controller.signal), userMessage())
        )
        const elapsed = Date.now() - startedAt
        assert.ok(
            elapsed < IDLE_TIMEOUT_MS + 250,
            `cancel must return promptly, not wait out a budget (took ${elapsed}ms)`
        )
        const { error } = onlyError(events)
        assert.equal(
            error.code,
            'openclaw_aborted',
            'a cancel is not a timeout — chat.service maps this to cancelled_by_user'
        )
        assert.equal(error.retryable, false)
    } finally {
        stop()
        await gw.close()
    }
})
