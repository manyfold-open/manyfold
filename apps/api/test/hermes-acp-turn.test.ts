import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecStreamResult, InteractiveExecHandle } from '../src/modules/chat/adapters/exec-driver'
import {
    HermesAcpTurn,
    type AcpEvent
} from '../src/modules/chat/adapters/hermes-acp-client'

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

interface FakeTransport {
    handle: InteractiveExecHandle
    stdout: PushQueue<string>
    stderr: PushQueue<string>
    writes: string[]
    endedInput: () => boolean
    aborted: () => boolean
    exit(result: ExecStreamResult): void
    die(err: Error): void
    // parse the last written JSON-RPC frame
    lastFrame(): Record<string, unknown>
}

const makeFakeTransport = (): FakeTransport => {
    const stdout = pushQueue<string>()
    const stderr = pushQueue<string>()
    const writes: string[] = []
    let endedInput = false
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
    return {
        handle: {
            stdout: stdout.iterable,
            stderr: stderr.iterable,
            write: (data: Buffer) => writes.push(data.toString('utf8')),
            endInput: () => {
                endedInput = true
                settleExit({ exitCode: 0, stdout: '', stderr: '' })
            },
            result,
            abort: () => {
                aborted = true
                settleFail(new Error('transport aborted'))
            }
        },
        stdout,
        stderr,
        writes,
        endedInput: () => endedInput,
        aborted: () => aborted,
        exit: settleExit,
        die: settleFail,
        lastFrame: () =>
            JSON.parse(writes[writes.length - 1]) as Record<string, unknown>
    }
}

const nextTick = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

const waitFor = async (cond: () => boolean, what: string): Promise<void> => {
    const start = Date.now()
    while (!cond()) {
        if (Date.now() - start > 3_000)
            throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

const makeTurn = (
    fake: FakeTransport
): { turn: HermesAcpTurn; events: AcpEvent[] } => {
    const events: AcpEvent[] = []
    const turn = new HermesAcpTurn({
        transport: fake.handle,
        onEvent: (ev) => events.push(ev)
    })
    return { turn, events }
}

test('drives initialize/new/prompt and surfaces streamed events in order', async () => {
    const fake = makeFakeTransport()
    const { turn, events } = makeTurn(fake)

    const init = turn.initialize(1_000)
    await waitFor(() => fake.writes.length === 1, 'initialize frame')
    const initFrame = fake.lastFrame()
    assert.equal(initFrame.method, 'initialize')
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: initFrame.id, result: { protocolVersion: 1 } })}\n`
    )
    assert.deepEqual(await init, { protocolVersion: 1 })

    const session = turn.newSession({ cwd: '/w', timeoutMs: 1_000 })
    await waitFor(() => fake.writes.length === 2, 'session/new frame')
    const newFrame = fake.lastFrame()
    assert.equal(newFrame.method, 'session/new')
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: newFrame.id, result: { sessionId: 'sess-9' } })}\n`
    )
    assert.equal(await session, 'sess-9')
    assert.equal(turn.currentSessionId, 'sess-9')

    const prompt = turn.prompt({
        prompt: 'hi',
        timeouts: { idleTimeoutMs: 1_000, maxDurationMs: 5_000 }
    })
    await waitFor(() => fake.writes.length === 3, 'prompt frame')
    const promptFrame = fake.lastFrame()
    assert.equal(promptFrame.method, 'session/prompt')
    const note = (update: Record<string, unknown>): string =>
        `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } })}\n`
    // split across chunks to prove line reassembly
    const thinking = note({ sessionUpdate: 'agent_thought_chunk', content: { text: 'mull' } })
    fake.stdout.push(thinking.slice(0, 10))
    fake.stdout.push(thinking.slice(10))
    fake.stdout.push(note({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello ' } }))
    fake.stdout.push(
        note({
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            name: 'shell',
            rawInput: { cmd: 'ls' }
        })
    )
    fake.stdout.push(note({ sessionUpdate: 'usage_update', tokens: 5 }))
    fake.stdout.push(note({ sessionUpdate: 'turn_end', usage: { total: 9 } }))
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: promptFrame.id, result: { stopReason: 'end_turn' } })}\n`
    )
    const promptResult = await prompt
    assert.equal(promptResult?.stopReason, 'end_turn')
    assert.deepEqual(events, [
        { type: 'thinking', text: 'mull' },
        { type: 'text', text: 'hello ' },
        {
            type: 'tool_call',
            toolCallId: 't1',
            toolName: 'shell',
            input: { cmd: 'ls' }
        },
        { type: 'usage_update', usage: { sessionUpdate: 'usage_update', tokens: 5 } },
        { type: 'turn_end', usage: { total: 9 } }
    ])

    await turn.close()
    assert.equal(fake.endedInput(), true)
})

test('auto-approves permission asks and rejects unknown agent requests', async () => {
    const fake = makeFakeTransport()
    makeTurn(fake)
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: {} })}\n`
    )
    await waitFor(() => fake.writes.length === 1, 'permission reply')
    const approve = fake.lastFrame() as {
        id: string
        result: { outcome: { optionId: string } }
    }
    assert.equal(approve.id, 'perm-1')
    assert.equal(approve.result.outcome.optionId, 'approve_for_session')

    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'x-1', method: 'fs/read_text_file', params: {} })}\n`
    )
    await waitFor(() => fake.writes.length === 2, 'method-not-found reply')
    const denied = fake.lastFrame() as { error: { code: number } }
    assert.equal(denied.error.code, -32601)
})

test('idle budget fires on silence but is rearmed by any frame, stdout or stderr', async () => {
    const fake = makeFakeTransport()
    const { turn } = makeTurn(fake)
    const silent = turn.request('session/prompt', {}, {
        idleTimeoutMs: 80,
        maxDurationMs: 5_000
    })
    await assert.rejects(silent, /produced no output for 80ms/)

    const active = turn.request('session/prompt', {}, {
        idleTimeoutMs: 120,
        maxDurationMs: 5_000
    })
    await waitFor(() => fake.writes.length === 2, 'second frame written')
    const frame = fake.lastFrame()
    // stderr chatter alone must keep the request alive past its idle budget
    for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 60))
        fake.stderr.push(`progress ${i}\n`)
    }
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`
    )
    await active
})

test('max-duration budget caps a request that never stops streaming', async () => {
    const fake = makeFakeTransport()
    const { turn } = makeTurn(fake)
    const capped = turn.request('session/prompt', {}, {
        idleTimeoutMs: 200,
        maxDurationMs: 150
    })
    const keepStreaming = setInterval(() => fake.stderr.push('chunk\n'), 30)
    try {
        await assert.rejects(
            capped,
            /still streaming when it hit its 150ms maximum duration/
        )
    } finally {
        clearInterval(keepStreaming)
    }
})

test('fatal stderr rejects in-flight requests and fails later ones fast', async () => {
    const fake = makeFakeTransport()
    const { turn, events } = makeTurn(fake)
    const inflight = turn.request('session/prompt', {}, 5_000)
    await waitFor(() => fake.writes.length === 1, 'prompt frame')
    fake.stderr.push('Retrying (attempt 1/3)...\n')
    await nextTick()
    fake.stderr.push('Aborting due to non-retryable error\n')
    await assert.rejects(inflight, /Aborting due to non-retryable error/)
    assert.equal(events.length, 1)
    const fatalEv = events[0] as {
        type: string
        message: string
        detail?: string
    }
    assert.equal(fatalEv.type, 'error')
    assert.equal(fatalEv.message, 'Aborting due to non-retryable error')
    // detail carries the tail so classifiers see context beyond the one line
    assert.match(fatalEv.detail ?? '', /Retrying \(attempt 1\/3\)/)
    await assert.rejects(
        turn.request('initialize', {}, 5_000),
        /Aborting due to non-retryable error/
    )
})

test('transport death rejects every pending request with the exit reason', async () => {
    const fake = makeFakeTransport()
    const { turn } = makeTurn(fake)
    const inflight = turn.request('session/prompt', {}, 5_000)
    await waitFor(() => fake.writes.length === 1, 'prompt frame')
    fake.stderr.push('ERROR provider exploded\n')
    await nextTick()
    fake.exit({ exitCode: 17, stdout: '', stderr: '' })
    await assert.rejects(inflight, /ERROR provider exploded/)
})

test('abort tears the transport down and rejects pending requests', async () => {
    const fake = makeFakeTransport()
    const { turn } = makeTurn(fake)
    const inflight = turn.request('session/prompt', {}, 5_000)
    await waitFor(() => fake.writes.length === 1, 'prompt frame')
    const rejected = assert.rejects(inflight, /hermes acp turn aborted/)
    turn.abort()
    assert.equal(fake.aborted(), true)
    await rejected
    await assert.rejects(
        turn.request('initialize', {}, 5_000),
        /already closed/
    )
})

test('close gives an EOF-deaf child a bounded grace, then tears it down', async () => {
    const fake = makeFakeTransport()
    // A transport whose endInput does NOT settle the result: the child
    // ignores EOF. close() must not park for the transport budget.
    const stubborn: InteractiveExecHandle = {
        ...fake.handle,
        endInput: () => {}
    }
    const turn = new HermesAcpTurn({
        transport: stubborn,
        onEvent: () => {},
        closeGraceMs: 50
    })
    const started = Date.now()
    await turn.close()
    assert.ok(
        Date.now() - started < 3_000,
        'close must return within the grace window'
    )
    assert.equal(fake.aborted(), true, 'the transport must be torn down')
})

// PR: tool outputs. tool_call_update was normalized and then dropped, so
// hermes was the only exec framework whose tool calls never showed results.
test('decodes terminal tool_call_update frames into tool_result events', async () => {
    const fake = makeFakeTransport()
    const { turn, events } = makeTurn(fake)
    const prompt = turn.request('session/prompt', {}, {
        idleTimeoutMs: 2_000,
        maxDurationMs: 5_000
    })
    const note = (update: Record<string, unknown>): string =>
        `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } })}\n`
    // pending/in_progress carry no outcome yet and must not emit
    fake.stdout.push(
        note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'pending' })
    )
    fake.stdout.push(
        note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' })
    )
    // rawOutput wins over content blocks
    fake.stdout.push(
        note({
            sessionUpdate: 'tool_call_update',
            toolCallId: 't1',
            status: 'completed',
            rawOutput: 'total 4',
            content: [{ type: 'content', content: { type: 'text', text: 'ignored' } }]
        })
    )
    // no rawOutput: text blocks concatenate, diff blocks reduce to their path
    fake.stdout.push(
        note({
            sessionUpdate: 'tool_call_update',
            toolCallId: 't2',
            status: 'failed',
            content: [
                { type: 'content', content: { type: 'text', text: 'boom' } },
                { type: 'diff', path: 'a.txt', newText: 'x' }
            ]
        })
    )
    // missing toolCallId is undecodable
    fake.stdout.push(
        note({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'zz' })
    )
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })}\n`
    )
    await prompt
    assert.deepEqual(events, [
        { type: 'tool_result', toolCallId: 't1', status: 'completed', result: 'total 4' },
        { type: 'tool_result', toolCallId: 't2', status: 'failed', result: 'boom\nedited a.txt' }
    ])
})

// Seen on hermes-agent 0.20.6 [2026-08-29]: 'approve_for_session' matches no
// advertised option id, and an unknown id maps to DENY on both approval
// bridges — every file edit was auto-rejected. The answer must come from the
// request's own options.
test('auto-approve picks from the request options, session-scoped grant first', async () => {
    const fake = makeFakeTransport()
    makeTurn(fake)
    // terminal-command ask, upstream option order: the first allow_always-kind
    // option is the session-scoped one, which is the grant a headless client
    // should burn — not the config-persisting allow_always.
    fake.stdout.push(
        `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-2',
            method: 'session/request_permission',
            params: {
                options: [
                    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
                    { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
                    { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
                    { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
                ]
            }
        })}\n`
    )
    await waitFor(() => fake.writes.length === 1, 'permission reply')
    const terminalAsk = fake.lastFrame() as {
        result: { outcome: { optionId: string } }
    }
    assert.equal(terminalAsk.result.outcome.optionId, 'allow_session')

    // edit ask: only allow_once / deny exist, and approval is the literal
    // comparison option_id == "allow_once"
    fake.stdout.push(
        `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-3',
            method: 'session/request_permission',
            params: {
                options: [
                    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
                    { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
                ]
            }
        })}\n`
    )
    await waitFor(() => fake.writes.length === 2, 'edit reply')
    const editAsk = fake.lastFrame() as {
        result: { outcome: { optionId: string } }
    }
    assert.equal(editAsk.result.outcome.optionId, 'allow_once')
})

// PR: interactive permissions. In the ask modes the client forwards
// session/request_permission to the user instead of auto-answering, keeps the
// idle budget alive while a human decides, and denies on timeout with the
// request's own reject option.
test('interactive policy forwards the ask, delivers the answer, and emits the resolution', async () => {
    const fake = makeFakeTransport()
    const events: AcpEvent[] = []
    const turn = new HermesAcpTurn({
        transport: fake.handle,
        onEvent: (ev) => events.push(ev),
        permissionPolicy: 'interactive',
        permissionTimeoutMs: 5_000
    })
    fake.stdout.push(
        `${JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'session/request_permission',
            params: {
                options: [
                    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
                    { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
                ],
                toolCall: {
                    toolCallId: 'edit-approval-1',
                    title: 'Approve edit: a.txt',
                    kind: 'edit',
                    status: 'pending',
                    content: [{ type: 'diff', path: 'a.txt', newText: 'x' }],
                    rawInput: { tool: 'write_file', arguments: { path: 'a.txt' } }
                }
            }
        })}\n`
    )
    await waitFor(() => events.length === 1, 'permission request event')
    assert.deepEqual(events[0], {
        type: 'permission_request',
        requestId: '7',
        toolCallId: 'edit-approval-1',
        title: 'Approve edit: a.txt',
        detail: 'a.txt',
        options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
        ]
    })
    assert.equal(fake.writes.length, 0, 'no auto-answer in interactive mode')
    assert.deepEqual(turn.pendingPermissionIds, ['7'])

    assert.equal(turn.respondPermission('7', 'allow_once'), 'delivered')
    await waitFor(() => fake.writes.length === 1, 'child reply')
    const reply = fake.lastFrame() as {
        id: number
        result: { outcome: { optionId: string } }
    }
    assert.equal(reply.id, 7)
    assert.equal(reply.result.outcome.optionId, 'allow_once')
    assert.deepEqual(events[1], {
        type: 'permission_resolution',
        requestId: '7',
        outcome: 'selected',
        optionId: 'allow_once'
    })
    assert.equal(turn.respondPermission('7', 'allow_once'), 'unknown')
    await turn.close()
})

test('an unanswered ask denies on timeout with the reject option', async () => {
    const fake = makeFakeTransport()
    const events: AcpEvent[] = []
    const turn = new HermesAcpTurn({
        transport: fake.handle,
        onEvent: (ev) => events.push(ev),
        permissionPolicy: 'interactive',
        permissionTimeoutMs: 60
    })
    fake.stdout.push(
        `${JSON.stringify({
            jsonrpc: '2.0',
            id: 9,
            method: 'session/request_permission',
            params: {
                options: [
                    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
                    { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
                ]
            }
        })}\n`
    )
    await waitFor(() => fake.writes.length === 1, 'timeout reply')
    const reply = fake.lastFrame() as {
        result: { outcome: { optionId: string } }
    }
    assert.equal(reply.result.outcome.optionId, 'deny')
    assert.deepEqual(
        events.find((e) => e.type === 'permission_resolution'),
        {
            type: 'permission_resolution',
            requestId: '9',
            outcome: 'timeout',
            optionId: 'deny'
        }
    )
    await turn.close()
})

test('a pending ask keeps the idle budget alive and close() cancels it', async () => {
    const fake = makeFakeTransport()
    const events: AcpEvent[] = []
    const turn = new HermesAcpTurn({
        transport: fake.handle,
        onEvent: (ev) => events.push(ev),
        permissionPolicy: 'interactive',
        permissionTimeoutMs: 60_000,
        permissionKeepAliveMs: 25
    })
    const prompt = turn.request('session/prompt', {}, {
        idleTimeoutMs: 120,
        maxDurationMs: 10_000
    })
    fake.stdout.push(
        `${JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'session/request_permission',
            params: {
                options: [
                    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }
                ]
            }
        })}\n`
    )
    await waitFor(() => turn.pendingPermissionIds.length === 1, 'pending ask')
    // 3x the idle budget of silence: only the keepalive can have survived it
    await new Promise((resolve) => setTimeout(resolve, 360))
    fake.stdout.push(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })}\n`
    )
    await prompt
    await turn.close()
    const resolution = events.find((e) => e.type === 'permission_resolution')
    assert.deepEqual(resolution, {
        type: 'permission_resolution',
        requestId: '3',
        outcome: 'cancelled',
        optionId: null
    })
})
