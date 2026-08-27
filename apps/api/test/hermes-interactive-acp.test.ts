import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ExecStreamResult,
    InteractiveExecHandle,
    InteractiveExecRequest
} from '../src/modules/chat/adapters/exec-driver'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// The interactive-ACP path end to end: sendViaInteractiveAcp driving the real
// HermesAcpTurn over a scripted transport, reached through the public
// sendMessage routing (sprites, no runner). What these pin beyond the
// protocol-core tests: the env/cwd the transport is launched with, the event
// mapping and ordinal keys, cancel teardown, the never-suspended error
// contract, and the stderr-based pool-empty classification the gateway 503
// body used to provide.

interface PushQueue<T> {
    iterable: AsyncIterable<T>
    push(item: T): void
    end(): void
}

const pushQueue = <T>(): PushQueue<T> => {
    const items: T[] = []
    let ended = false
    let notify: (() => void) | null = null
    const wake = (): void => {
        const n = notify
        notify = null
        n?.()
    }
    return {
        iterable: {
            [Symbol.asyncIterator]: async function* () {
                while (true) {
                    while (items.length > 0) yield items.shift()!
                    if (ended) return
                    await new Promise<void>((resolve) => {
                        notify = resolve
                    })
                }
            }
        },
        push: (item: T) => {
            items.push(item)
            wake()
        },
        end: () => {
            ended = true
            wake()
        }
    }
}

interface Rig {
    adapter: HermesAdapter
    requests: InteractiveExecRequest[]
    writes: Array<Record<string, unknown>>
    stdout: PushQueue<string>
    stderr: PushQueue<string>
    aborted: () => boolean
    exit: (r: ExecStreamResult) => void
    die: (e: Error) => void
    sessionRefs: Array<{ sessionId: string; ref: string | null }>
    waitFor: (method: string) => Promise<Record<string, unknown>>
    reply: (frame: Record<string, unknown>) => void
    note: (update: Record<string, unknown>) => void
}

const buildRig = (): Rig => {
    const requests: InteractiveExecRequest[] = []
    const writes: Array<Record<string, unknown>> = []
    const waiters: Array<{
        method: string
        resolve: (f: Record<string, unknown>) => void
    }> = []
    const stdout = pushQueue<string>()
    const stderr = pushQueue<string>()
    let aborted = false
    let settled = false
    let resolveResult!: (r: ExecStreamResult) => void
    let rejectResult!: (e: Error) => void
    const result = new Promise<ExecStreamResult>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
    })
    const settleExit = (r: ExecStreamResult): void => {
        if (settled) return
        settled = true
        stdout.end()
        stderr.end()
        resolveResult(r)
    }
    const settleFail = (e: Error): void => {
        if (settled) return
        settled = true
        stdout.end()
        stderr.end()
        rejectResult(e)
    }
    const handle: InteractiveExecHandle = {
        stdout: stdout.iterable,
        stderr: stderr.iterable,
        write: (data: Buffer) => {
            for (const raw of data.toString('utf8').split('\n')) {
                if (!raw.trim()) continue
                const frame = JSON.parse(raw) as Record<string, unknown>
                writes.push(frame)
                const idx = waiters.findIndex((w) => w.method === frame.method)
                if (idx !== -1) waiters.splice(idx, 1)[0].resolve(frame)
            }
        },
        endInput: () => settleExit({ exitCode: 0, stdout: '', stderr: '' }),
        result,
        abort: () => {
            aborted = true
            settleFail(new Error('transport aborted'))
        }
    }
    const execDrivers = {
        forAgent: async () => ({
            driver: {
                stream: () => {
                    throw new Error('one-shot stream must not be used')
                },
                streamInteractive: (req: InteractiveExecRequest) => {
                    requests.push(req)
                    return handle
                }
            },
            creds: {
                primaryModelProvider: 'openrouter',
                primaryModelApiKey: 'sk-or-test',
                primaryModelName: 'nous/hermes-4'
            },
            runtime: 'sprites',
            agent: {
                id: 'agt_1',
                workspacePath: '/home/sprite/ws',
                extras: null
            }
        })
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            runtime: 'sprites',
                            daemonId: null,
                            workspacePath: '/home/sprite/ws',
                            extras: null
                        }
                    ]
                })
            })
        })
    }
    const sessionRefs: Array<{ sessionId: string; ref: string | null }> = []
    const chatRepo = {
        updateFrameworkSessionRef: async (
            sessionId: string,
            ref: string | null
        ) => {
            sessionRefs.push({ sessionId, ref })
        }
    }
    const adapter = new HermesAdapter(
        db as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        {} as never,
        chatRepo as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                keepAliveMs: 1_000,
                livenessTimeoutMs: 1_000,
                timeoutMs: 60_000
            })
        } as never,
        undefined as never,
        execDrivers as never
    )
    return {
        adapter,
        requests,
        writes,
        stdout,
        stderr,
        aborted: () => aborted,
        exit: settleExit,
        die: settleFail,
        sessionRefs,
        waitFor: (method) => {
            const already = writes.find((f) => f.method === method)
            if (already) return Promise.resolve(already)
            return new Promise((resolve) => waiters.push({ method, resolve }))
        },
        reply: (frame) => stdout.push(`${JSON.stringify(frame)}\n`),
        note: (update) =>
            stdout.push(
                `${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: { update }
                })}\n`
            )
    }
}

const ctx = (
    extra: Partial<ApiChatAdapterContext> = {}
): ApiChatAdapterContext =>
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
        frameworkSessionRef: null,
        history: [],
        ...extra
    }) as ApiChatAdapterContext

const USER_MSG = {
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

// Drives the standard handshake in the background while sendMessage streams.
const script = (
    rig: Rig,
    opts: { sessionId?: string; answer?: () => void } = {}
): void => {
    void (async () => {
        const init = await rig.waitFor('initialize')
        rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
        const create = await rig.waitFor('session/new')
        rig.reply({
            jsonrpc: '2.0',
            id: create.id,
            result: { sessionId: opts.sessionId ?? 'sess_live' }
        })
        const prompt = await rig.waitFor('session/prompt')
        opts.answer?.()
        rig.reply({
            jsonrpc: '2.0',
            id: prompt.id,
            result: {
                stopReason: 'end_turn',
                usage: { inputTokens: 3, outputTokens: 5 }
            }
        })
    })()
}

test('a no-runner sprite turn runs the full ACP conversation over the interactive transport', async () => {
    const rig = buildRig()
    script(rig, {
        answer: () => {
            rig.note({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'hel' }
            })
            rig.note({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'lo' }
            })
            rig.note({ sessionUpdate: 'turn_end', usage: { total: 8 } })
        }
    })
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))

    assert.equal(rig.requests.length, 1)
    const req = rig.requests[0]
    assert.deepEqual(req.cmd, ['hermes', 'acp', '--accept-hooks'])
    assert.equal(req.dir, '/home/sprite/ws')
    // The ceiling bounds the child's whole lifetime.
    assert.equal(req.timeoutMs, 60_000)
    // The alias is what makes a non-custom provider usable from an exec'd
    // child; YOLO is what keeps a headless turn from deadlocking on approval.
    assert.equal(req.env?.OPENROUTER_API_KEY, 'sk-or-test')
    assert.equal(req.env?.HERMES_YOLO_MODE, '1')

    assert.equal(
        events
            .filter((e) => e.type === 'token')
            .map((e) => (e as { text: string }).text)
            .join(''),
        'hello'
    )
    const sources = events.filter((e) => e.type === 'raw_source')
    assert.deepEqual(
        sources.map(
            (s) => (s as { source: { externalId: string } }).source.externalId
        ),
        ['hermes-acp-1', 'hermes-acp-2']
    )
    assert.deepEqual(rig.sessionRefs, [{ sessionId: 'cts_1', ref: 'sess_live' }])
    const usage = events.find((e) => e.type === 'usage')
    assert.ok(usage, 'usage from the prompt result must be emitted')
    assert.equal(events.at(-1)?.type, 'done')
    // Graceful shutdown: EOF, not a kill.
    assert.equal(rig.aborted(), false)
})

test('cancel tears the transport down and terminalizes as hermes_aborted', async () => {
    const rig = buildRig()
    const controller = new AbortController()
    void (async () => {
        const init = await rig.waitFor('initialize')
        rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
        const create = await rig.waitFor('session/new')
        rig.reply({
            jsonrpc: '2.0',
            id: create.id,
            result: { sessionId: 'sess_live' }
        })
        await rig.waitFor('session/prompt')
        rig.note({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial' }
        })
        // let the partial flush through before cancelling
        setTimeout(() => controller.abort(), 20)
    })()
    const events = await drain(
        rig.adapter.sendMessage(
            ctx({ abortSignal: controller.signal } as never),
            USER_MSG
        )
    )
    assert.equal(rig.aborted(), true, 'the remote child must be torn down')
    const last = events.at(-1) as {
        type: string
        error: { code: string; retryable: boolean }
    }
    assert.equal(last.type, 'error')
    assert.equal(last.error.code, 'hermes_aborted')
    assert.equal(last.error.retryable, false)
    assert.ok(!events.some((e) => e.type === 'done'))
})

test('a fatal stderr line surfaces inline and classifies managed pool exhaustion', async () => {
    const rig = buildRig()
    void (async () => {
        const init = await rig.waitFor('initialize')
        rig.reply({ jsonrpc: '2.0', id: init.id, result: {} })
        const create = await rig.waitFor('session/new')
        rig.reply({
            jsonrpc: '2.0',
            id: create.id,
            result: { sessionId: 'sess_live' }
        })
        await rig.waitFor('session/prompt')
        // The managed proxy's refusal, mirrored to stderr — the shape the
        // gateway used to deliver as a 503 body (#660).
        rig.stderr.push(
            'Aborting: {"error":{"code":503,"message":"No available accounts"}}\n'
        )
    })()
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    const error = events.find((e) => e.type === 'error') as {
        error: { code: string }
        managedChannelFailure?: string
    }
    assert.ok(error, 'the fatal line must surface as an inline error')
    assert.equal(error.error.code, 'hermes_acp_event')
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
})

test('a transport failure is a retryable error, never suspended', async () => {
    const rig = buildRig()
    void (async () => {
        await rig.waitFor('initialize')
        rig.die(new Error('exec dispatch failed'))
    })()
    const events = await drain(rig.adapter.sendMessage(ctx(), USER_MSG))
    assert.ok(
        !events.some((e) => e.type === 'suspended'),
        'nothing can resume an API-owned ACP turn, so it must never suspend'
    )
    const last = events.at(-1) as {
        type: string
        error: { code: string; retryable: boolean }
    }
    assert.equal(last.type, 'error')
    assert.equal(last.error.code, 'hermes_acp_failed')
    assert.equal(last.error.retryable, true)
})
