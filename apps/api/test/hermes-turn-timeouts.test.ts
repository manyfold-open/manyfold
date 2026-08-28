import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesAcpTurn } from '../src/modules/chat/adapters/hermes-acp-client'
import type { InteractiveExecHandle } from '../src/modules/chat/adapters/exec-driver'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// #556. `session/prompt` is a LONG-LIVED ACP request: it streams the whole
// answer as session/update notifications and only resolves at the end. Both
// halves of hermes gave it a single response deadline that the notifications
// never reset, which made it a wall-clock cap on the turn rather than a hang
// detector — every turn longer than the budget was truncated while it was
// still emitting.
//
// These drive the real HermesAcpTurn over a fake interactive transport so the
// rearming happens through the actual stdout/stderr ingest path. Real timers
// with small budgets: mocked time cannot prove that a watchdog rearms against
// a child that is genuinely trickling.

interface FakeChild {
    // Frames the client wrote to the child, already decoded.
    sent: Array<Record<string, unknown>>
    emit: (kind: 'stdout' | 'stderr', data: string) => void
    line: (frame: Record<string, unknown>) => void
    notify: () => void
    waitFor: (method: string) => Promise<Record<string, unknown>>
}

const pushQueue = (): {
    iterable: AsyncIterable<string>
    push: (item: string) => void
} => {
    const items: string[] = []
    let notify: (() => void) | null = null
    return {
        iterable: {
            [Symbol.asyncIterator]: async function* () {
                while (true) {
                    while (items.length > 0) yield items.shift()!
                    await new Promise<void>((resolve) => {
                        notify = resolve
                    })
                    notify = null
                }
            }
        },
        push: (item: string) => {
            items.push(item)
            const n = notify
            notify = null
            n?.()
        }
    }
}

const buildClient = (): { client: HermesAcpTurn; child: FakeChild } => {
    const sent: Array<Record<string, unknown>> = []
    const waiters: Array<{
        method: string
        resolve: (f: Record<string, unknown>) => void
    }> = []
    const stdout = pushQueue()
    const stderr = pushQueue()
    const transport: InteractiveExecHandle = {
        stdout: stdout.iterable,
        stderr: stderr.iterable,
        write: (data: Buffer) => {
            for (const raw of data.toString('utf8').split('\n')) {
                if (!raw.trim()) continue
                const frame = JSON.parse(raw) as Record<string, unknown>
                sent.push(frame)
                const idx = waiters.findIndex((w) => w.method === frame.method)
                if (idx !== -1) waiters.splice(idx, 1)[0].resolve(frame)
            }
        },
        endInput: () => {},
        // Never settles: a settled result means the child exited, which
        // rejects every pending request.
        result: new Promise(() => {}),
        abort: () => {}
    }
    const client = new HermesAcpTurn({ transport, onEvent: () => {} })
    const emit = (kind: 'stdout' | 'stderr', data: string): void => {
        if (kind === 'stdout') stdout.push(data)
        else stderr.push(data)
    }
    const child: FakeChild = {
        sent,
        emit,
        line: (frame) => emit('stdout', `${JSON.stringify(frame)}\n`),
        notify: () =>
            child.line({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: 'tick' }
                    }
                }
            }),
        waitFor: (method) => {
            const already = sent.find((f) => f.method === method)
            if (already) return Promise.resolve(already)
            return new Promise((resolve) => waiters.push({ method, resolve }))
        }
    }
    return { client, child }
}

// Brings the client to the point where prompt() is legal, using the same
// handshake the adapter performs.
const handshake = async (
    client: HermesAcpTurn,
    child: FakeChild
): Promise<void> => {
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
}

const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

// WHY: the reported bug verbatim — the turn keeps streaming the whole time and
// simply runs longer than the inactivity budget.
test('a prompt that keeps streaming past the idle budget resolves normally', async () => {
    const { client, child } = buildClient()
    await handshake(client, child)
    const startedAt = Date.now()
    const pending = client.prompt({
        prompt: 'hi',
        timeouts: { idleTimeoutMs: 300, maxDurationMs: 20_000 }
    })
    const promptFrame = await child.waitFor('session/prompt')
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 100))
        child.notify()
    }
    child.line({
        jsonrpc: '2.0',
        id: promptFrame.id,
        result: { stopReason: 'end_turn' }
    })
    const result = await pending
    const elapsed = Date.now() - startedAt
    assert.ok(
        elapsed > 300,
        `the prompt must outlive the 300ms idle budget for this test to mean anything (ran ${elapsed}ms)`
    )
    assert.equal((result as { stopReason: string }).stopReason, 'end_turn')
    client.abort()
})

// WHY: widening what counts as alive must not remove the hang detector — a
// hermes that never answers is the failure this budget exists for.
test('a prompt with no output at all fails on the idle budget', async () => {
    const { client, child } = buildClient()
    await handshake(client, child)
    const pending = client.prompt({
        prompt: 'hi',
        timeouts: { idleTimeoutMs: 300, maxDurationMs: 20_000 }
    })
    await child.waitFor('session/prompt')
    await assert.rejects(pending, /produced no output for 300ms/)
    client.abort()
})

// WHY: a ceiling still exists, but it is a DIFFERENT failure from silence.
// Conflating the two is what made the original message describe the opposite
// of what happened.
test('an endlessly streaming prompt fails on the max-duration budget, not the idle one', async () => {
    const { client, child } = buildClient()
    await handshake(client, child)
    const pending = client.prompt({
        prompt: 'hi',
        timeouts: { idleTimeoutMs: 10_000, maxDurationMs: 600 }
    })
    await child.waitFor('session/prompt')
    const ticker = setInterval(() => child.notify(), 80)
    try {
        await assert.rejects(pending, /600ms maximum duration/)
    } finally {
        clearInterval(ticker)
    }
    client.abort()
})

// WHY: a long silent tool call can produce nothing on stdout while hermes still
// logs progress on stderr. Treating only stdout as activity would time out a
// turn that is demonstrably alive.
test('stderr output alone counts as activity', async () => {
    const { client, child } = buildClient()
    await handshake(client, child)
    const pending = client.prompt({
        prompt: 'hi',
        timeouts: { idleTimeoutMs: 300, maxDurationMs: 20_000 }
    })
    const promptFrame = await child.waitFor('session/prompt')
    // Deliberately benign: the fatal-stderr patterns would reject instead.
    const ticker = setInterval(
        () => child.emit('stderr', 'running tool: build\n'),
        100
    )
    await new Promise((r) => setTimeout(r, 900))
    clearInterval(ticker)
    await settle()
    child.line({
        jsonrpc: '2.0',
        id: promptFrame.id,
        result: { stopReason: 'end_turn' }
    })
    const result = await pending
    assert.equal((result as { stopReason: string }).stopReason, 'end_turn')
    client.abort()
})

// WHY: the runner-carried transport had the same single-timer shape, so the
// daemon has to be told the split. A runner that predates it reads only
// timeoutMs, which must keep its old value rather than inherit the ceiling.
test('turn.start carries the split budgets and keeps the legacy timeoutMs', async () => {
    const calls: Array<{
        payload: Record<string, unknown>
        timeoutMs?: number
    }> = []
    const registry = {
        streamRpc: (args: {
            payload: Record<string, unknown>
            timeoutMs?: number
            onEvent?: (kind: string, data: string, seq?: number) => void
        }) => {
            calls.push({ payload: args.payload, timeoutMs: args.timeoutMs })
            return {
                refId: 'ref_test',
                result: Promise.resolve({ stopReason: 'end_turn' }),
                cancel: () => {}
            }
        }
    }
    const MAX_MS = 7_200_000
    const adapter = new HermesAdapter(
        {} as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        registry as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                keepAliveMs: 20_000,
                livenessTimeoutMs: 75_000,
                timeoutMs: MAX_MS
            })
        } as never
    )
    const ctx = {
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'hermes',
        runtimeKind: 'daemon',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: []
    } as unknown as ApiChatAdapterContext
    const message: ChatMessage = {
        id: 'msg_user',
        sessionId: 'cts_1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }],
        createdAt: '2026-08-05T00:00:00.000Z'
    }
    const send = (
        adapter as unknown as {
            sendViaTurnRpc: (
                c: ApiChatAdapterContext,
                m: ChatMessage,
                a: { daemonId: string; cwd: string | null }
            ) => AsyncIterable<EmittedChatEvent>
        }
    ).sendViaTurnRpc(ctx, message, { daemonId: 'dh_1', cwd: '/w' })
    for await (const _ of send) void _
    assert.equal(calls.length, 1)
    const payload = calls[0].payload
    assert.equal(
        payload.timeoutMs,
        240_000,
        'a runner that predates the split reads only timeoutMs and must keep its old absolute cap'
    )
    assert.equal(payload.idleTimeoutMs, 240_000)
    assert.equal(
        payload.maxDurationMs,
        MAX_MS,
        'the ceiling comes from the admin chat exec budget, not a hermes constant'
    )
    assert.equal(
        calls[0].timeoutMs,
        MAX_MS + 10_000,
        'the RPC deadline is a third absolute clock and must stay above the turn cap'
    )
})
