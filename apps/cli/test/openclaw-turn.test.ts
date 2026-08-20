import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The openclaw half of turn.start. The daemon holds the SSE socket (the
// gateway cancels a run when it closes), journals one frame per line, and —
// the part that matters — only writes a `stopReason` when the gateway ended
// the stream ON PURPOSE (`[DONE]` or a protocol-terminal error frame). A
// stream that just stops must never look finished to a restarted API: that is
// the truncation-labelled-success failure the hermes drills made expensive.
//
// daemonPaths is resolved from homedir() at import time, so HOME is redirected
// before the dynamic import to keep this off the developer's real daemon.
const home = mkdtempSync(join(tmpdir(), 'mf-openclaw-turn-'))
process.env.HOME = home
process.env.MF_PROFILE = 'openclawturntest'

const { runOpenclawTurn } = await import('../src/daemon/openclaw-turn')
const { readEventsFrom, readFinal, readMeta } = await import(
    '../src/daemon/exec-buffer'
)

const sse = (res: ServerResponse, payload: string): void => {
    res.write(`data: ${payload}\n\n`)
}

const listen = (
    handler: (res: ServerResponse, headers: Record<string, unknown>) => void
): Promise<{ server: Server; url: string }> =>
    new Promise((resolve) => {
        const server = createServer((req, res) => {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache'
            })
            handler(res, req.headers)
        })
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number }
            resolve({ server, url: `http://127.0.0.1:${addr.port}/v1/chat/completions` })
        })
    })

// Same as listen() but the status line is never written, so the client sits in
// the connect phase.
const listenSilentHeaders = (): Promise<{ server: Server; url: string }> =>
    new Promise((resolve) => {
        const server = createServer((req) => req.resume())
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number }
            resolve({
                server,
                url: `http://127.0.0.1:${addr.port}/v1/chat/completions`
            })
        })
    })

const trickle = (
    res: ServerResponse,
    intervalMs: number,
    total: number | 'forever'
): (() => void) => {
    let n = 0
    const timer = setInterval(() => {
        if (total !== 'forever' && n >= total) {
            clearInterval(timer)
            sse(res, '[DONE]')
            res.end()
            return
        }
        n++
        sse(res, JSON.stringify({ choices: [{ delta: { content: `t${n}` } }] }))
    }, intervalMs)
    return () => clearInterval(timer)
}

interface SentEvent {
    kind: string
    data: string
}

const makeCtx = (
    refId: string
): {
    ctx: {
        refId: string
        sendEvent: (kind: string, data: string, seq?: number) => void
        onCancel: (h: () => void) => void
    }
    events: SentEvent[]
    cancel: () => void
} => {
    const events: SentEvent[] = []
    let cancelHandler: (() => void) | null = null
    return {
        ctx: {
            refId,
            sendEvent: (kind, data) => {
                events.push({ kind, data })
            },
            onCancel: (h) => {
                cancelHandler = h
            }
        },
        events,
        cancel: () => cancelHandler?.()
    }
}

const run = (
    _refId: string,
    url: string,
    h: ReturnType<typeof makeCtx>,
    extra: Record<string, unknown> = {}
) =>
    runOpenclawTurn({
        payload: {
            framework: 'openclaw',
            url,
            token: 'gw_secret',
            body: { model: 'openclaw', stream: true },
            timeoutMs: 10_000,
            ...extra
        } as never,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })

test('a [DONE] stream completes with a stopReason and one frame per line', async () => {
    let sawAuth: unknown
    const { server, url } = await listen((res, headers) => {
        sawAuth = headers.authorization
        sse(res, JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'hel' } }] }))
        sse(res, JSON.stringify({ id: 'c2', choices: [{ delta: { content: 'lo' } }] }))
        sse(res, JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } }))
        sse(res, '[DONE]')
        res.end()
    })
    try {
        const h = makeCtx('oc-happy-1')
        const ack = await run('oc-happy-1', url, h)
        assert.equal(ack.ok, true, ack.error)
        // stopReason is the API's licence to emit `done`.
        assert.equal(
            (ack.payload as { stopReason: string }).stopReason,
            'done'
        )
        // The gateway token travelled with the request the daemon made.
        assert.equal(sawAuth, 'Bearer gw_secret')
        // One JSON frame per buffer line; [DONE] is completion evidence, not
        // content, and stays out of the stream.
        const lines = h.events
            .filter((e) => e.kind === 'stdout')
            .map((e) => e.data.trim())
        assert.equal(lines.length, 3)
        for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
        assert.ok(!lines.some((l) => l.includes('[DONE]')))
        // Replay sees exactly what was streamed.
        const replay = readEventsFrom('oc-happy-1', 0).filter(
            (e) => e.kind === 'stdout'
        )
        assert.deepEqual(
            replay.map((e) => e.data.trim()),
            lines
        )
        assert.equal(readMeta('oc-happy-1')?.status, 'completed')
        // The token must not be recoverable from the buffer.
        const meta = readMeta('oc-happy-1')
        assert.ok(!JSON.stringify(meta?.payload).includes('gw_secret'))
    } finally {
        server.close()
    }
})

test('a stream that just stops leaves NO stopReason — never a fake finish', async () => {
    const { server, url } = await listen((res) => {
        sse(res, JSON.stringify({ choices: [{ delta: { content: 'partial ans' } }] }))
        // Gateway dies mid-run: connection ends without [DONE].
        setTimeout(() => res.destroy(), 50)
    })
    try {
        const h = makeCtx('oc-trunc-1')
        const ack = await run('oc-trunc-1', url, h)
        assert.equal(ack.ok, false)
        assert.match(ack.error ?? '', /without \[DONE\]|terminated|closed|aborted/i)
        const final = readFinal('oc-trunc-1')
        assert.equal(final?.ok, false)
        assert.equal(
            (final?.payload as { stopReason: string | null }).stopReason,
            null
        )
        // The partial content is still durable for the replay.
        assert.ok(
            readEventsFrom('oc-trunc-1', 0).some((e) =>
                e.data.includes('partial ans')
            )
        )
    } finally {
        server.close()
    }
})

test('an inline error frame is protocol-terminal and journals for replay', async () => {
    const { server, url } = await listen((res) => {
        sse(res, JSON.stringify({ error: { message: 'upstream 401: bad key' } }))
        res.end()
    })
    try {
        const h = makeCtx('oc-err-1')
        const ack = await run('oc-err-1', url, h)
        assert.equal(ack.ok, true)
        assert.equal(
            (ack.payload as { stopReason: string }).stopReason,
            'error'
        )
        // The error frame itself is in the buffer — a resumed API reads the
        // same failure the live one surfaced.
        assert.ok(
            readEventsFrom('oc-err-1', 0).some((e) =>
                e.data.includes('upstream 401')
            )
        )
    } finally {
        server.close()
    }
})

// #513, runner-carried half. The daemon had ONE absolute timer over the whole
// turn, so the runner transport truncated an actively-streaming turn exactly
// like the API direct path did — fixing only the API would have re-introduced
// the bug the moment turn.start rolled out. The three budgets below are the
// same three the API now sends.
test('a stream that keeps emitting past the idle budget is not truncated', async () => {
    let stop = (): void => {}
    const { server, url } = await listen((res) => {
        stop = trickle(res, 100, 12)
    })
    try {
        const h = makeCtx('oc-active-1')
        const startedAt = Date.now()
        const ack = await run('oc-active-1', url, h, {
            timeoutMs: 60_000,
            headersTimeoutMs: 60_000,
            idleTimeoutMs: 400,
            maxDurationMs: 60_000
        })
        const elapsed = Date.now() - startedAt
        assert.ok(
            elapsed > 400,
            `the turn must outlive the 400ms idle budget for this test to mean anything (ran ${elapsed}ms)`
        )
        assert.equal(ack.ok, true, ack.error)
        assert.equal(
            (ack.payload as { stopReason: string }).stopReason,
            'done',
            'an active stream still reaches [DONE] — the idle watchdog rearms on every chunk'
        )
        assert.equal(
            readEventsFrom('oc-active-1', 0).filter((e) => e.kind === 'stdout')
                .length,
            12
        )
    } finally {
        stop()
        server.close()
    }
})

// WHY: the daemon owns COMPLETION evidence, so each budget has to be
// distinguishable in the final it writes — a restarted API triages from this
// string, and "timed out" told it nothing about which clock ran out.
test('each budget reports itself distinctly in the final', async () => {
    // node only flushes the status line on the first body write, so the frame
    // is what makes this "silent AFTER headers" rather than a connect stall.
    const silence = await listen((res) => {
        sse(res, JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }))
    })
    try {
        const h = makeCtx('oc-idle-1')
        const ack = await run('oc-idle-1', silence.url, h, {
            timeoutMs: 60_000,
            idleTimeoutMs: 300,
            maxDurationMs: 60_000
        })
        assert.equal(ack.ok, false)
        assert.match(ack.error ?? '', /went silent for 300ms/)
        assert.equal(
            (readFinal('oc-idle-1')?.payload as { stopReason: string | null })
                .stopReason,
            null,
            'a stalled stream is still unfinished — never a fake completion'
        )
    } finally {
        silence.server.close()
    }

    const headless = await listenSilentHeaders()
    try {
        const h = makeCtx('oc-headers-1')
        const ack = await run('oc-headers-1', headless.url, h, {
            timeoutMs: 60_000,
            headersTimeoutMs: 300,
            idleTimeoutMs: 60_000,
            maxDurationMs: 60_000
        })
        assert.equal(ack.ok, false)
        assert.match(ack.error ?? '', /no response headers within 300ms/)
    } finally {
        headless.server.close()
    }

    let stop = (): void => {}
    const endless = await listen((res) => {
        stop = trickle(res, 80, 'forever')
    })
    try {
        const h = makeCtx('oc-max-1')
        const ack = await run('oc-max-1', endless.url, h, {
            timeoutMs: 60_000,
            headersTimeoutMs: 60_000,
            idleTimeoutMs: 60_000,
            maxDurationMs: 500
        })
        assert.equal(ack.ok, false)
        assert.match(ack.error ?? '', /500ms maximum duration/)
        assert.ok(
            readEventsFrom('oc-max-1', 0).some((e) => e.kind === 'stdout'),
            'the frames produced before the ceiling stay durable for a replay'
        )
    } finally {
        stop()
        endless.server.close()
    }
})

// WHY: a runner that understands the split can still be driven by an API that
// predates it. timeoutMs then backs all three budgets, and because the max
// clock starts first it is the one that fires — i.e. the payload degenerates
// to exactly the single absolute cap it used to mean, rather than losing its
// bound.
test('a payload with only the legacy timeoutMs degenerates to the old single cap', async () => {
    let stop = (): void => {}
    const { server, url } = await listen((res) => {
        stop = trickle(res, 50, 'forever')
    })
    try {
        const h = makeCtx('oc-legacy-1')
        const startedAt = Date.now()
        const ack = await run('oc-legacy-1', url, h, { timeoutMs: 300 })
        assert.equal(ack.ok, false)
        assert.match(ack.error ?? '', /300ms maximum duration/)
        assert.ok(
            Date.now() - startedAt < 3_000,
            'an actively streaming turn under a legacy payload is still bounded'
        )
    } finally {
        stop()
        server.close()
    }
})

test('cancel aborts the fetch and records an aborted, unfinished stream', async () => {
    const { server, url } = await listen((res) => {
        sse(res, JSON.stringify({ choices: [{ delta: { content: 'x' } }] }))
        // then hang — the client cancels
    })
    try {
        const h = makeCtx('oc-cancel-1')
        const ackPromise = run('oc-cancel-1', url, h)
        await new Promise((r) => setTimeout(r, 150))
        h.cancel()
        const ack = await ackPromise
        assert.equal(ack.ok, false)
        assert.match(ack.error ?? '', /cancelled/)
        assert.equal(readMeta('oc-cancel-1')?.status, 'aborted')
        assert.equal(
            (readFinal('oc-cancel-1')?.payload as { stopReason: string | null })
                .stopReason,
            null
        )
    } finally {
        server.close()
    }
})
