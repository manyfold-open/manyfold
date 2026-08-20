import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type {
    ApiChatConvergeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import {
    A2aChatAdapter,
    DEFAULT_CONVERGE_POLL_INTERVAL_MS,
    DifyChatAdapter,
    LangflowChatAdapter,
    resolveConvergePollIntervalMs
} from '../src/modules/chat/adapters/external-api.adapter'
import { MAX_TIMER_DELAY_MS } from '../src/modules/chat/turn-budgets'

process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'
// Real polls, real sleeps: the still-running case has to actually come back.
process.env.MF_EXTERNAL_CONVERGE_POLL_MS = '20'

// #670. A deploy kills the relay for a dify/langflow/a2a turn, but the upstream
// finishes anyway — the answer exists, was paid for, and the user used to get a
// retryable `server_restart` instead. These drive the real convergence path an
// adopted turn takes against real node:http upstreams (#513: a mocked fetch
// cannot prove which URL is called or what a 500 does to the loop), and pin the
// two halves that matter equally: the recoveries that land, and the ones that
// must NOT be faked.

const CTX_BASE = {
    userId: 'user_1',
    agentId: 'agt_1',
    sessionId: 'cts_1',
    messageId: 'assistant-message-1'
}

const convergeCtx = (
    over: Partial<ApiChatConvergeContext>
): ApiChatConvergeContext => ({
    ...CTX_BASE,
    frameworkSessionRef: null,
    upstreamTaskId: null,
    upstreamMessageId: null,
    abortSignal: new AbortController().signal,
    ...over
})

const fakeDb = (framework: string, remoteRef: Record<string, unknown>) =>
    ({
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: 'agt_1',
                            userId: 'user_1',
                            extras: {
                                externalBinding: {
                                    providerId: 'ueap_1',
                                    framework,
                                    remoteRef
                                }
                            }
                        }
                    ]
                })
            })
        })
    }) as never

const fakeProviders = (framework: string, endpointUrl: string) =>
    ({
        resolveForUser: async () => ({
            provider: framework,
            endpointUrl,
            apiKey: 'test-key',
            metadata: {}
        })
    }) as never

const fakeRepo = {} as never

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 2_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await delay(5)
    assert.ok(predicate(), label)
}

const startServer = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{
    origin: string
    requests: string[]
    close: () => Promise<void>
}> => {
    const requests: string[] = []
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`)
        handler(req, res)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

// Every wait in here is capped: a convergence loop that never terminates is a
// real failure mode of this feature, and a test that hangs on it reports
// nothing.
const collectBounded = async (
    stream: AsyncIterable<EmittedChatEvent> | null,
    ms = 4_000
): Promise<EmittedChatEvent[]> => {
    assert.ok(stream, 'expected a convergence stream, got null')
    const events: EmittedChatEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
    })
    try {
        const drain = (async () => {
            for await (const event of stream) events.push(event)
            return 'done' as const
        })()
        const outcome = await Promise.race([drain, expiry])
        assert.notEqual(
            outcome,
            'timeout',
            `convergence did not terminate within ${ms}ms`
        )
        return events
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const difyAdapter = (endpointUrl: string): DifyChatAdapter =>
    new DifyChatAdapter(
        fakeDb('dify', { userIdentifier: 'user_1' }),
        fakeProviders('dify', endpointUrl),
        fakeRepo
    )

const a2aAdapter = (rpcUrl: string): A2aChatAdapter =>
    new A2aChatAdapter(
        fakeDb('a2a', { rpcUrl }),
        fakeProviders('a2a', rpcUrl),
        fakeRepo
    )

const difyMessagesServer = async (
    pages: Array<Array<Record<string, unknown>>>
): Promise<Awaited<ReturnType<typeof startServer>>> => {
    let call = 0
    return startServer((req, res) => {
        req.resume()
        const page = pages[Math.min(call, pages.length - 1)]
        call += 1
        if (!req.url?.startsWith('/v1/messages')) {
            res.writeHead(404)
            res.end()
            return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: page, has_more: false, limit: 100 }))
    })
}

test('a completed dify turn is delivered as replace + done under the same message id', async () => {
    const server = await difyMessagesServer([
        [
            { id: 'other-msg', answer: 'a different turn' },
            { id: 'dify-msg-1', answer: 'the full recovered answer' }
        ]
    ])
    try {
        const events = await collectBounded(
            difyAdapter(`${server.origin}/v1`).convergeTurn(
                convergeCtx({
                    frameworkSessionRef: 'conv-1',
                    upstreamMessageId: 'dify-msg-1',
                    upstreamTaskId: 'task-1'
                })
            )
        )
        assert.deepEqual(events, [
            {
                type: 'replace',
                text: 'the full recovered answer',
                reason: 'upstream_converged'
            },
            { type: 'done', finalMessageId: 'assistant-message-1' }
        ])
        // Scoped to the conversation AND matched by message id: picking the
        // newest row instead would have returned another turn's answer, which
        // the decoy row above is there to catch.
        assert.match(
            server.requests[0],
            /^GET \/v1\/messages\?conversation_id=conv-1&user=user_1&limit=100$/
        )
    } finally {
        await server.close()
    }
})

test('a dify turn still generating is polled until the answer lands', async () => {
    const server = await difyMessagesServer([
        // Row not written yet.
        [],
        // Row exists, answer still empty.
        [{ id: 'dify-msg-1', answer: '' }],
        [{ id: 'dify-msg-1', answer: 'arrived late' }]
    ])
    try {
        const events = await collectBounded(
            difyAdapter(`${server.origin}/v1`).convergeTurn(
                convergeCtx({
                    frameworkSessionRef: 'conv-1',
                    upstreamMessageId: 'dify-msg-1'
                })
            )
        )
        assert.equal(events.length, 2)
        assert.deepEqual(events[0], {
            type: 'replace',
            text: 'arrived late',
            reason: 'upstream_converged'
        })
        assert.equal(server.requests.length, 3, 'polled until it converged')
    } finally {
        await server.close()
    }
})

test('a dify turn that failed upstream terminalizes retryably with its message', async () => {
    const server = await difyMessagesServer([
        [
            {
                id: 'dify-msg-1',
                answer: '',
                status: 'error',
                error: 'model provider quota exceeded'
            }
        ]
    ])
    try {
        const events = await collectBounded(
            difyAdapter(`${server.origin}/v1`).convergeTurn(
                convergeCtx({
                    frameworkSessionRef: 'conv-1',
                    upstreamMessageId: 'dify-msg-1'
                })
            )
        )
        assert.deepEqual(events, [
            {
                type: 'error',
                error: {
                    code: 'dify_upstream_failed',
                    message: 'model provider quota exceeded',
                    retryable: true
                }
            }
        ])
    } finally {
        await server.close()
    }
})

// A 5xx is a blip, not a verdict — but an unreachable upstream must not park
// the turn until the idle budget lapses half an hour later.
test('a dify upstream that keeps 500ing gives up retryably instead of polling forever', async () => {
    const server = await startServer((req, res) => {
        req.resume()
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('upstream down')
    })
    try {
        const events = await collectBounded(
            difyAdapter(`${server.origin}/v1`).convergeTurn(
                convergeCtx({
                    frameworkSessionRef: 'conv-1',
                    upstreamMessageId: 'dify-msg-1'
                })
            )
        )
        assert.equal(events.length, 1)
        const event = events[0]
        assert.equal(event.type, 'error')
        if (event.type !== 'error') return
        assert.equal(event.error.code, 'external_converge_failed')
        assert.equal(event.error.retryable, true)
        assert.equal(server.requests.length, 5, 'bounded by the failure streak')
    } finally {
        await server.close()
    }
})

const a2aServer = async (
    tasks: Array<Record<string, unknown>>
): Promise<Awaited<ReturnType<typeof startServer>>> => {
    let call = 0
    return startServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc = JSON.parse(raw) as {
                id: string | number
                method: string
                params?: { id?: string }
            }
            if (rpc.method !== 'tasks/get') {
                res.writeHead(404)
                res.end()
                return
            }
            const result = tasks[Math.min(call, tasks.length - 1)]
            call += 1
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: rpc.id,
                    result: { ...result, id: rpc.params?.id }
                })
            )
        })
    })
}

test('a completed a2a task is delivered from its artifacts as replace + done', async () => {
    const server = await a2aServer([
        {
            kind: 'task',
            contextId: 'ctx-1',
            status: { state: 'completed' },
            artifacts: [
                {
                    artifactId: 'a1',
                    parts: [{ kind: 'text', text: 'answer ' }]
                },
                {
                    artifactId: 'a2',
                    parts: [{ kind: 'text', text: 'part two' }]
                }
            ]
        }
    ])
    try {
        const events = await collectBounded(
            a2aAdapter(`${server.origin}/rpc`).convergeTurn(
                convergeCtx({ upstreamTaskId: 'task-9' })
            )
        )
        assert.deepEqual(events, [
            {
                type: 'replace',
                text: 'answer \npart two',
                reason: 'upstream_converged'
            },
            { type: 'done', finalMessageId: 'assistant-message-1' }
        ])
    } finally {
        await server.close()
    }
})

test('a working a2a task is polled until it reaches a terminal state', async () => {
    const server = await a2aServer([
        { kind: 'task', contextId: 'ctx-1', status: { state: 'working' } },
        {
            kind: 'task',
            contextId: 'ctx-1',
            status: { state: 'completed' },
            artifacts: [
                {
                    artifactId: 'a1',
                    parts: [{ kind: 'text', text: 'done now' }]
                }
            ]
        }
    ])
    try {
        const events = await collectBounded(
            a2aAdapter(`${server.origin}/rpc`).convergeTurn(
                convergeCtx({ upstreamTaskId: 'task-9' })
            )
        )
        assert.equal(events.length, 2)
        assert.equal(server.requests.length, 2)
    } finally {
        await server.close()
    }
})

test('a failed a2a task terminalizes with the upstream detail', async () => {
    const server = await a2aServer([
        {
            kind: 'task',
            contextId: 'ctx-1',
            status: {
                state: 'failed',
                message: {
                    kind: 'message',
                    role: 'agent',
                    messageId: 'm1',
                    parts: [{ kind: 'text', text: 'tool crashed' }]
                }
            }
        }
    ])
    try {
        const events = await collectBounded(
            a2aAdapter(`${server.origin}/rpc`).convergeTurn(
                convergeCtx({ upstreamTaskId: 'task-9' })
            )
        )
        assert.deepEqual(events, [
            {
                type: 'error',
                error: {
                    code: 'a2a_failed',
                    message: 'tool crashed',
                    retryable: false
                }
            }
        ])
    } finally {
        await server.close()
    }
})

// Not `cancelled_by_user`: this user's cancel goes through the local abort, so
// reporting one here would misattribute an upstream decision to them.
test('a cancelled a2a task is reported as an upstream cancellation', async () => {
    const server = await a2aServer([
        { kind: 'task', contextId: 'ctx-1', status: { state: 'canceled' } }
    ])
    try {
        const events = await collectBounded(
            a2aAdapter(`${server.origin}/rpc`).convergeTurn(
                convergeCtx({ upstreamTaskId: 'task-9' })
            )
        )
        assert.equal(events.length, 1)
        const event = events[0]
        assert.equal(event.type, 'error')
        if (event.type !== 'error') return
        assert.equal(event.error.code, 'a2a_upstream_cancelled')
        assert.notEqual(event.error.code, 'cancelled_by_user')
    } finally {
        await server.close()
    }
})

// The honest-degrade half. Each of these MUST return null so the caller falls
// back to the retryable server_restart terminal; a stream here would hold the
// turn open on a recovery that can never arrive.
test('langflow is never converged: it has no upstream query API', () => {
    const adapter = new LangflowChatAdapter(
        fakeDb('langflow', { flowId: 'flow-1' }),
        fakeProviders('langflow', 'http://127.0.0.1:1/'),
        fakeRepo
    )
    assert.equal(
        adapter.convergeTurn(
            convergeCtx({
                frameworkSessionRef: 'lf-session-1',
                upstreamTaskId: 'task-1',
                upstreamMessageId: 'msg-1'
            })
        ),
        null
    )
})

test('a dify turn orphaned before its refs landed is not converged', () => {
    const adapter = difyAdapter('http://127.0.0.1:1/v1')
    assert.equal(
        adapter.convergeTurn(convergeCtx({ frameworkSessionRef: 'conv-1' })),
        null,
        'no message id: the messages API cannot say which answer is this turn'
    )
    assert.equal(
        adapter.convergeTurn(convergeCtx({ upstreamMessageId: 'dify-msg-1' })),
        null,
        'no conversation id: the messages API cannot be queried at all'
    )
    // A task id alone is a cancel handle, not a lookup key.
    assert.equal(
        adapter.convergeTurn(convergeCtx({ upstreamTaskId: 'task-1' })),
        null
    )
})

test('an a2a turn orphaned before its task id landed is not converged', () => {
    assert.equal(
        a2aAdapter('http://127.0.0.1:1/rpc').convergeTurn(
            convergeCtx({ frameworkSessionRef: 'ctx-1' })
        ),
        null
    )
})

// #670's second finding: the same node timer overflow #668 found in the turn
// budgets, on a knob that reaches setTimeout just as directly. A delay above
// 2^31-1 is not a longer timer — node rewrites it to 1ms, with only a
// TimeoutOverflowWarning on stderr — and this loop resets its failure streak on
// every `running` poll, so "poll the upstream less often" turned into a ~1ms
// hammer on someone else's API for as long as the turn budget allowed.

const withPollIntervalEnv = async (
    value: string,
    fn: () => void | Promise<void>
): Promise<void> => {
    const saved = process.env.MF_EXTERNAL_CONVERGE_POLL_MS
    try {
        process.env.MF_EXTERNAL_CONVERGE_POLL_MS = value
        await fn()
    } finally {
        if (saved === undefined) delete process.env.MF_EXTERNAL_CONVERGE_POLL_MS
        else process.env.MF_EXTERNAL_CONVERGE_POLL_MS = saved
    }
}

test('a poll interval above the node timer ceiling clamps DOWN, exactly', async () => {
    // 2^31, one past the ceiling: the smallest value an operator can type that
    // overflows, and ~24.9 days, which is what they meant by "basically never".
    await withPollIntervalEnv('2147483648', () => {
        const resolved = resolveConvergePollIntervalMs()
        assert.equal(resolved, MAX_TIMER_DELAY_MS)
        assert.equal(resolved, 2 ** 31 - 1)
        // The failure this replaces produced a perfectly valid-looking number,
        // so pin the direction too: clamping an over-ceiling request can only
        // ever make the poll slower than an unset env would.
        assert.ok(resolved > DEFAULT_CONVERGE_POLL_INTERVAL_MS)
    })
})

test('the ceiling value itself is honoured, and junk falls back to the default', async () => {
    await withPollIntervalEnv(String(MAX_TIMER_DELAY_MS), () => {
        assert.equal(resolveConvergePollIntervalMs(), MAX_TIMER_DELAY_MS)
    })
    // Infinity is the other way to write "never poll again"; it cannot be armed
    // at all, so it must land on the default rather than on 1ms.
    for (const junk of ['1e400', 'never', '0', '-1', '']) {
        await withPollIntervalEnv(junk, () => {
            assert.equal(
                resolveConvergePollIntervalMs(),
                DEFAULT_CONVERGE_POLL_INTERVAL_MS,
                junk
            )
        })
    }
})

// The behaviour, against a real upstream that never finishes: the clamp is only
// worth anything if the second poll is actually 24.9 days away.
test('an over-ceiling poll interval does not hammer the upstream', async () => {
    const server = await difyMessagesServer([
        [{ id: 'dify-msg-1', answer: '' }]
    ])
    const controller = new AbortController()
    try {
        await withPollIntervalEnv('2147483648', async () => {
            const drained = collectBounded(
                difyAdapter(`${server.origin}/v1`).convergeTurn(
                    convergeCtx({
                        frameworkSessionRef: 'conv-1',
                        upstreamMessageId: 'dify-msg-1',
                        abortSignal: controller.signal
                    })
                )
            )
            await waitFor(
                () => server.requests.length >= 1,
                'expected the first poll to reach the upstream'
            )
            // Room for ~150 polls at the 1ms node would have armed.
            await delay(150)
            assert.equal(
                server.requests.length,
                1,
                'the next poll is a timer ceiling away, not 1ms'
            )
            controller.abort()
            assert.deepEqual(
                await drained,
                [],
                'aborting an adopted turn ends the loop without inventing a terminal'
            )
        })
    } finally {
        await server.close()
    }
})
