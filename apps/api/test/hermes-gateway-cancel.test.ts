import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'

// #665. The sprite gateway POST carried no signal and the SSE read loop never
// looked at ctx.abortSignal, so a cancel converged locally while the gateway
// kept generating into a socket nobody read — compute and tokens billed for an
// answer that can never be shown.
//
// These run the real sendMessage against a real HTTP gateway with real fetch,
// because the defect is a property of the SOCKET, not of the loop: #513 taught
// this file family that a stubbed `body.getReader()` resolves when the test
// decides and can never fail the way production does, and a mocked fetch has no
// connection to observe closing at all. The load-bearing assertion below is
// server-side — the gateway must SEE the connection go away.
process.env.K8S_INGRESS_SCHEME = 'http'

const HANG_BUDGET_MS = 3_000

interface Gateway {
    host: string
    posts: number
    // Resolves when the server side of the streaming response is torn down.
    closed: Promise<void>
    close: () => Promise<void>
}

const startGateway = async (
    onPost: (res: ServerResponse) => void
): Promise<Gateway> => {
    const open = new Set<ServerResponse>()
    let markClosed = (): void => {}
    const closed = new Promise<void>((resolve) => {
        markClosed = resolve
    })
    const state = { posts: 0 }
    const server: Server = createServer((req, res) => {
        state.posts++
        open.add(res)
        // A client reset surfaces as an error on the response; without a
        // listener node would rethrow it and kill the test process.
        res.on('error', () => {})
        res.on('close', () => markClosed())
        req.resume()
        req.on('end', () => onPost(res))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return {
        host: `127.0.0.1:${port}`,
        get posts() {
            return state.posts
        },
        closed,
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

const delta = (n: number): string =>
    `data: ${JSON.stringify({
        id: `chunk-${n}`,
        choices: [{ delta: { content: `t${n}` } }]
    })}\n\n`

// Drips one delta every intervalMs. Returns a stop handle so no interval can
// outlive its own gateway.
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
        res.write(delta(++n))
    }, intervalMs)
    return () => clearInterval(timer)
}

const makeDb = (host: string) => {
    const rows = [
        [{ runtime: 'sprites', daemonId: null, workspacePath: null }],
        [{ ingressHost: host, runtimeId: 'art_1' }],
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

const buildAdapter = (host: string): HermesAdapter =>
    new HermesAdapter(
        makeDb(host) as never,
        {
            decrypt: () =>
                JSON.stringify({
                    apiServerKey: 'key',
                    primaryModelName: 'hermes-agent'
                })
        } as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        {} as never,
        { updateFrameworkSessionRef: async () => {} } as never
    )

const ctxFor = (abortSignal?: AbortSignal): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'hermes',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: 'fsr-1',
        history: [],
        ...(abortSignal ? { abortSignal } : {})
    }) as ApiChatAdapterContext

const userMessage = (): ChatMessage => ({
    id: 'msg_user',
    sessionId: 'cts_1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-08-08T00:00:00.000Z'
})

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

// Drains in the background so a loop that ignores the cancel shows up as a
// bounded FAILURE instead of hanging the run forever (there is no timeout
// budget on this path to end it).
const drainInBackground = (
    source: AsyncIterable<EmittedChatEvent>
): {
    events: EmittedChatEvent[]
    thrown: { current: Error | null }
    ended: () => Promise<'ended' | 'hung'>
} => {
    const events: EmittedChatEvent[] = []
    const thrown: { current: Error | null } = { current: null }
    const done = (async () => {
        for await (const ev of source) events.push(ev)
    })().catch((err: Error) => {
        thrown.current = err
    })
    return {
        events,
        thrown,
        ended: () =>
            Promise.race([
                done.then(() => 'ended' as const),
                sleep(HANG_BUDGET_MS).then(() => 'hung' as const)
            ])
    }
}

// WHY: the reported defect. The user cancels mid-answer; the turn terminalizes
// locally either way, so the only observable that distinguishes fixed from
// broken is whether the GATEWAY still has a live request to keep generating
// into.
test('cancel mid-body tears the gateway connection down', async () => {
    let stop = (): void => {}
    const gw = await startGateway((res) => {
        stop = trickle(res, 50, 'forever')
    })
    try {
        const adapter = buildAdapter(gw.host)
        const controller = new AbortController()
        const run = drainInBackground(
            adapter.sendMessage(ctxFor(controller.signal), userMessage())
        )
        // Cancel only once the body is genuinely flowing, so this is an
        // abort of an established stream and not of the connect phase.
        while (!run.events.some((ev) => ev.type === 'token')) await sleep(20)
        const abortedAt = Date.now()
        controller.abort()

        const serverSawClose = await Promise.race([
            gw.closed.then(() => true),
            sleep(HANG_BUDGET_MS).then(() => false)
        ])
        assert.ok(
            serverSawClose,
            'the gateway must see the request socket close on cancel — while it stays open the sprite keeps generating and billing an answer nobody will read'
        )
        assert.equal(
            await run.ended(),
            'ended',
            'the SSE read loop must exit on cancel instead of decoding a stream nobody wants'
        )
        assert.ok(
            Date.now() - abortedAt < HANG_BUDGET_MS,
            'cancel must converge promptly, not on some later budget'
        )
        assert.equal(
            run.thrown.current,
            null,
            'a cancel is an expected outcome, not an exception escaping the adapter'
        )
        const last = run.events.at(-1)
        assert.equal(last?.type, 'error')
        assert.equal(
            last?.type === 'error' && last.error.code,
            'hermes_aborted',
            'a cancel is not a network failure — chat.service maps this to cancelled_by_user'
        )
        assert.equal(last?.type === 'error' && last.error.retryable, false)
        assert.ok(
            !run.events.some((ev) => ev.type === 'done'),
            'a cancelled turn must not also report completion'
        )
    } finally {
        stop()
        await gw.close()
    }
})

// WHY: a turn cancelled between dispatch and the first byte is the same leak
// with worse odds — addEventListener never fires for an already-aborted signal,
// so a bridge-controller fix would still open the socket and hand the gateway a
// full turn to run.
test('a turn cancelled before dispatch never reaches the gateway', async () => {
    const gw = await startGateway((res) => {
        sseHeaders(res)
        res.write(delta(1))
        res.write('data: [DONE]\n\n')
        res.end()
    })
    try {
        const adapter = buildAdapter(gw.host)
        const controller = new AbortController()
        controller.abort()
        const run = drainInBackground(
            adapter.sendMessage(ctxFor(controller.signal), userMessage())
        )
        assert.equal(await run.ended(), 'ended')
        assert.equal(
            gw.posts,
            0,
            'an already-cancelled turn must not open a gateway request at all'
        )
        assert.deepEqual(
            run.events.map((ev) => ev.type),
            ['error'],
            'the turn terminalizes on the cancel alone — no tokens, no done'
        )
        assert.equal(
            run.events[0]?.type === 'error' && run.events[0].error.code,
            'hermes_aborted'
        )
    } finally {
        await gw.close()
    }
})

// WHY: blast radius. The abort checks sit on the hot decode path, so an
// uncancelled turn has to keep streaming every delta and finish with `done`.
test('an uncancelled gateway turn still streams every delta and completes', async () => {
    let stop = (): void => {}
    const gw = await startGateway((res) => {
        stop = trickle(res, 20, 3)
    })
    try {
        const adapter = buildAdapter(gw.host)
        const run = drainInBackground(
            adapter.sendMessage(ctxFor(), userMessage())
        )
        assert.equal(await run.ended(), 'ended')
        assert.equal(run.thrown.current, null)
        assert.deepEqual(
            run.events
                .filter((ev) => ev.type === 'token')
                .map((ev) => (ev.type === 'token' ? ev.text : '')),
            ['t1', 't2', 't3']
        )
        assert.equal(run.events.at(-1)?.type, 'done')
        assert.ok(!run.events.some((ev) => ev.type === 'error'))
    } finally {
        stop()
        await gw.close()
    }
})

test('the Hermes gateway adapter marks the owned structured pool exhaustion', async () => {
    const gw = await startGateway((res) => {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(
            JSON.stringify({
                error: {
                    message: 'No available accounts: no available accounts'
                }
            })
        )
    })
    try {
        const run = drainInBackground(
            buildAdapter(gw.host).sendMessage(ctxFor(), userMessage())
        )
        assert.equal(await run.ended(), 'ended')
        const error = run.events.find((event) => event.type === 'error')
        assert.ok(error && error.type === 'error')
        assert.equal(error.managedChannelFailure, 'account_pool_empty')
        assert.equal(error.error.code, 'hermes_upstream')
    } finally {
        await gw.close()
    }
})
