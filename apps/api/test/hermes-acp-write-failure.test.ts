import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesAcpClient } from '../src/modules/chat/adapters/hermes-acp-client'

// #561: request() arms its idle/max timers and registers the pending entry
// BEFORE writing the frame to daemon exec.input. When that write failed, the
// catch only deleted the map entry: both timers stayed armed against an
// internal promise request() never returns, so the surviving timer's late
// reject surfaced as an unhandledRejection. apps/api/src/main.ts escalates any
// unhandled rejection to a fatal exit, so one failed daemon write killed the
// whole API replica after the budget elapsed instead of failing only the
// current Hermes turn.
//
// These drive the real HermesAcpClient over a fake registry whose exec.input
// rejects, with real (tiny) budgets: the regression IS the timer that fires
// after request() has already thrown, so mocked time proves nothing.

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const captureUnhandled = async (
    body: () => Promise<void>
): Promise<string[]> => {
    const seen: string[] = []
    const onUnhandled = (reason: unknown): void => {
        seen.push(reason instanceof Error ? reason.message : String(reason))
    }
    process.on('unhandledRejection', onUnhandled)
    try {
        await body()
    } finally {
        process.off('unhandledRejection', onUnhandled)
    }
    return seen
}

interface FakeChild {
    line: (frame: Record<string, unknown>) => void
    waitFor: (method: string) => Promise<Record<string, unknown>>
}

const buildClient = (opts: {
    failWrites: () => boolean
}): { client: HermesAcpClient; child: FakeChild } => {
    const sent: Array<Record<string, unknown>> = []
    const waiters: Array<{
        method: string
        resolve: (f: Record<string, unknown>) => void
    }> = []
    let onEvent: ((kind: string, data: string) => void) | null = null
    const registry = {
        streamRpc: (args: {
            onEvent: (kind: string, data: string) => void
        }) => {
            onEvent = args.onEvent
            return {
                refId: 'ref_fake',
                // Never settles: a settled exec result means the child
                // exited, which rejects every pending request and would mask
                // the write-failure path under test.
                result: new Promise<Record<string, unknown> | undefined>(
                    () => {}
                ),
                cancel: () => {}
            }
        },
        rpc: async (args: {
            method: string
            payload: Record<string, unknown>
        }) => {
            if (args.method !== 'exec.input') return {}
            if (opts.failWrites())
                throw new Error('exec.input write failed')
            const text = Buffer.from(
                String(args.payload.data),
                'base64'
            ).toString('utf8')
            for (const raw of text.split('\n')) {
                if (!raw.trim()) continue
                const frame = JSON.parse(raw) as Record<string, unknown>
                sent.push(frame)
                const idx = waiters.findIndex((w) => w.method === frame.method)
                if (idx !== -1) waiters.splice(idx, 1)[0].resolve(frame)
            }
            return {}
        }
    }
    const client = new HermesAcpClient({
        registry: registry as never,
        daemonId: 'dh_fake',
        onEvent: () => {}
    })
    const child: FakeChild = {
        line: (frame) =>
            onEvent?.('stdout', `${JSON.stringify(frame)}\n`),
        waitFor: (method) => {
            const already = sent.find((f) => f.method === method)
            if (already) return Promise.resolve(already)
            return new Promise((resolve) => waiters.push({ method, resolve }))
        }
    }
    return { client, child }
}

const pendingSize = (client: HermesAcpClient): number =>
    (client as unknown as { pending: Map<number, unknown> }).pending.size

// WHY: the caller already received the write error, so anything the leaked
// timers produce afterwards has no consumer by construction. The sleep runs
// well past the 50ms budget shared by both timers — before the fix the
// max-duration timer rejects "hermes initialize was still streaming..." right
// there and the collector catches what production would escalate to exit(1).
test('a handshake write failure rejects with the write error and leaves no timer armed', async () => {
    const seen = await captureUnhandled(async () => {
        const { client } = buildClient({ failWrites: () => true })
        await client.start({ timeoutMs: 10_000, cwd: '/tmp' })
        await assert.rejects(
            client.initialize(50),
            /exec\.input write failed/,
            'the caller must see the original transport error, not a timeout'
        )
        assert.equal(
            pendingSize(client),
            0,
            'the failed request must not stay in the pending map'
        )
        await sleep(250)
        client.abort()
    })
    assert.deepEqual(
        seen,
        [],
        'no rejection may be left for the process-level fatal handler'
    )
})

// WHY: session/prompt is the split-budget request, so a leak here arms TWO
// independent timers (#556) — both must die with the write. The handshake
// succeeds first so the failure hits a client in its normal streaming state.
test('a prompt write failure after a healthy handshake releases both split budgets', async () => {
    let failWrites = false
    const { client, child } = buildClient({ failWrites: () => failWrites })
    await client.start({ timeoutMs: 10_000, cwd: '/tmp' })
    const init = client.initialize(5_000)
    const initFrame = await child.waitFor('initialize')
    child.line({ jsonrpc: '2.0', id: initFrame.id, result: {} })
    await init
    const created = client.newSession({ cwd: '/tmp', timeoutMs: 5_000 })
    const newFrame = await child.waitFor('session/new')
    child.line({
        jsonrpc: '2.0',
        id: newFrame.id,
        result: { sessionId: 'sess_1' }
    })
    await created
    failWrites = true
    const seen = await captureUnhandled(async () => {
        await assert.rejects(
            client.prompt({
                prompt: 'hi',
                timeouts: { idleTimeoutMs: 60, maxDurationMs: 120 }
            }),
            /exec\.input write failed/,
            'the caller must see the original transport error, not a timeout'
        )
        assert.equal(
            pendingSize(client),
            0,
            'the failed request must not stay in the pending map'
        )
        await sleep(400)
        client.abort()
    })
    assert.deepEqual(
        seen,
        [],
        'neither the idle nor the max-duration timer may reject after the write failed'
    )
})
