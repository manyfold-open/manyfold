import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent,
    EmittedErrorEvent
} from '../src/modules/chat/chat-adapter'

// With keep-alive default-off (#108 phase 2) cold wake becomes the COMMON
// narranexus path and the preflight retry budget is the user-visible recovery
// contract. Every test drives the real sendMessage inheritance chain
// (NarraNexusChatAdapter -> OpenclawAdapter -> sendOpenAiCompat) so a future
// sendMessage override can't silently drop preflight.
//
// The preflight budgets are computed from process.env at module load, so the
// override must be in place before the adapters are imported — hence the
// dynamic import() inside each test instead of a hoisted static import.
const NARRANEXUS_BUDGET_MS = 1_500
process.env.NARRANEXUS_PREFLIGHT_BUDGET_MS = String(NARRANEXUS_BUDGET_MS)
delete process.env.OPENCLAW_PREFLIGHT_BUDGET_MS
delete process.env.OPENCLAW_PREFLIGHT_TIMEOUT_MS
delete process.env.K8S_INGRESS_SCHEME

// Mirrors the adapter's OPENCLAW_PREFLIGHT_RETRY_DELAY_MS so mock-time ticks
// land exactly on the retry sleeps.
const RETRY_DELAY_MS = 500
const OPENCLAW_DEFAULT_BUDGET_MS = 30_000
const INGRESS_HOST = 'gw.example.com'
const BASE_URL = `https://${INGRESS_HOST}`

interface PreflightCall {
    url: string
    method: string
    at: number
}

const recordCall = (
    calls: PreflightCall[],
    input: unknown,
    init?: { method?: string }
): PreflightCall => {
    const entry = {
        url: String(input),
        method: init?.method ?? 'GET',
        at: Date.now()
    }
    calls.push(entry)
    return entry
}

// AbortSignal.timeout rejections carry name 'TimeoutError'; the adapter keys
// the budget-bearing "within Ns" message off that name.
const timeoutError = (): Error =>
    Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })

const makeDb = (resultQueue: Array<Array<Record<string, unknown>>>) => {
    let i = 0
    return {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        resultQueue[Math.min(i++, resultQueue.length - 1)]
                })
            })
        })
    }
}

// sendMessage hits the db three times: the agent row, the resolveRuntime
// agent row, then the runtime credentials row.
const adapterArgs = (framework: 'narranexus' | 'openclaw') =>
    [
        makeDb([
            [{ runtime: 'sprites', internalId: 'main', daemonId: null }],
            [
                {
                    ingressHost: INGRESS_HOST,
                    runtimeId: 'rt-1',
                    framework,
                    internalId:
                        framework === 'narranexus' ? 'narranexus' : 'main',
                    name: 'main'
                }
            ],
            [{ payloadCiphertext: 'ct', keyVersion: 1 }]
        ]) as never,
        {
            decrypt: () =>
                framework === 'narranexus'
                    ? JSON.stringify({ gatewayToken: 'tok' })
                    : JSON.stringify({
                        gatewayToken: 'tok',
                        primaryModelName: 'claude'
                    })
        } as never,
        {} as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        {} as never,
        { event: () => {} } as never
    ] as const

const fakeCtx = (
    framework: 'narranexus' | 'openclaw'
): ApiChatAdapterContext => ({
    userId: 'u-1',
    agentId: 'a-1',
    runtimeId: 'rt-1',
    sessionId: 's-1',
    messageId: 'm-1',
    framework,
    runtimeKind: 'sprites',
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    // truthy so the post-success session-ref backfill (a drivers/fs exec
    // outside preflight's scope) is skipped
    frameworkSessionRef: 'fsr-1',
    history: []
})

const userMessage = (): ChatMessage => ({
    id: 'msg-1',
    sessionId: 's-1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-06-01T00:00:00.000Z'
})

const withFetch = async (
    stub: (input: unknown, init?: { method?: string }) => Promise<unknown>,
    fn: () => Promise<void>
): Promise<void> => {
    const orig = globalThis.fetch
    globalThis.fetch = stub as never
    try {
        await fn()
    } finally {
        globalThis.fetch = orig
    }
}

const sseResponse = (frames: string[]) => {
    const encoder = new TextEncoder()
    let next = 0
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
            getReader: () => ({
                read: async () =>
                    next < frames.length
                        ? { value: encoder.encode(frames[next++]), done: false }
                        : { value: undefined, done: true }
            })
        }
    }
}

// Drains the send under mocked setTimeout+Date: each round lets microtasks
// settle, then advances virtual time by one retry delay so the 30s/60s
// budgets elapse instantly and attempt timestamps are deterministic.
const collectUnderMockTime = async (
    t: TestContext,
    events: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    let done = false
    let collected: EmittedChatEvent[] = []
    let failure: unknown = null
    const pump = async (): Promise<EmittedChatEvent[]> => {
        const out: EmittedChatEvent[] = []
        for await (const ev of events) out.push(ev)
        return out
    }
    pump().then(
        (out) => {
            collected = out
            done = true
        },
        (err) => {
            failure = err
            done = true
        }
    )
    for (let i = 0; i < 500 && !done; i++) {
        await new Promise((resolve) => setImmediate(resolve))
        if (!done) t.mock.timers.tick(RETRY_DELAY_MS)
    }
    assert.ok(
        done,
        'send did not settle under mock time — preflight is awaiting something other than setTimeout'
    )
    if (failure) throw failure
    return collected
}

const onlyError = (events: EmittedChatEvent[]): EmittedErrorEvent => {
    assert.equal(
        events.length,
        1,
        'a preflight failure must be the only emitted event — the send must never reach the chat POST'
    )
    assert.equal(events[0].type, 'error')
    return events[0] as EmittedErrorEvent
}

// WHY: a never-binding gateway is what a failed cold wake looks like under
// default-off keep-alive; the user must get a framework-attributed retryable
// error instead of the send hanging into the 240s chat fetch timeout.
test('narranexus send against a never-binding socket retries HEAD until its budget then yields narranexus_not_ready', async (t) => {
    const { NarraNexusChatAdapter } = await import(
        '../src/modules/narranexus/narranexus-chat.adapter'
    )
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const calls: PreflightCall[] = []
    await withFetch(
        async (input, init) => {
            recordCall(calls, input, init)
            throw new Error('connect ECONNREFUSED 198.51.100.7:443')
        },
        async () => {
            const adapter = new NarraNexusChatAdapter(
                ...adapterArgs('narranexus')
            )
            const events = await collectUnderMockTime(
                t,
                adapter.sendMessage(fakeCtx('narranexus'), userMessage())
            )
            const { error } = onlyError(events)
            assert.equal(
                error.code,
                'narranexus_not_ready',
                'D6: the not-ready code derives from this.framework so narranexus failures are attributed to narranexus, not openclaw'
            )
            assert.equal(
                error.retryable,
                true,
                'cold wake is the common default-off path — the client must be told to retry'
            )
            assert.match(
                error.message,
                /^narranexus gateway/,
                'the message is framework-attributed via this.framework'
            )
            const heads = calls.filter((c) => c.method === 'HEAD')
            assert.equal(
                heads.length,
                calls.length,
                'no non-HEAD request may fire while the gateway never binds'
            )
            assert.ok(
                heads.every((c) => c.url === BASE_URL),
                'preflight probes the gateway root, not the completions endpoint'
            )
            assert.ok(
                heads.length >= 2,
                'preflight must RETRY — a cold wake needs more than one attempt, not a single-shot probe'
            )
            assert.ok(
                heads.every((c) => c.at < NARRANEXUS_BUDGET_MS),
                'no attempt may start at or past the budget'
            )
            assert.ok(
                (heads.at(-1)?.at ?? 0) + RETRY_DELAY_MS >=
                    NARRANEXUS_BUDGET_MS,
                'preflight must keep retrying until the budget is exhausted, not give up early'
            )
        }
    )
})

// WHY: the budget is env-tunable (NARRANEXUS_PREFLIGHT_BUDGET_MS) because the
// default-off cold wake now includes startService + run.sh boot and is
// unmeasured — ops must be able to adjust it without a release.
test('narranexus preflight budget honors NARRANEXUS_PREFLIGHT_BUDGET_MS', async (t) => {
    const { NarraNexusChatAdapter } = await import(
        '../src/modules/narranexus/narranexus-chat.adapter'
    )
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const calls: PreflightCall[] = []
    await withFetch(
        async (input, init) => {
            recordCall(calls, input, init)
            throw timeoutError()
        },
        async () => {
            const adapter = new NarraNexusChatAdapter(
                ...adapterArgs('narranexus')
            )
            const events = await collectUnderMockTime(
                t,
                adapter.sendMessage(fakeCtx('narranexus'), userMessage())
            )
            const { error } = onlyError(events)
            assert.equal(error.code, 'narranexus_not_ready')
            assert.match(
                error.message,
                /within 1\.5s/,
                'the user-visible budget must be the NARRANEXUS_PREFLIGHT_BUDGET_MS override (1.5s), not the 60s default'
            )
            assert.ok(
                calls.every((c) => c.at < NARRANEXUS_BUDGET_MS),
                'the retry loop must stop at the env-configured budget'
            )
        }
    )
})

// WHY: a gateway that binds mid-budget is the NORMAL cold-wake recovery; the
// retry loop exists to absorb wake latency and then deliver the turn in the
// same send, not merely to fail politely.
test('narranexus preflight that binds on attempt 3 within budget proceeds to the chat completions POST', async (t) => {
    const { NarraNexusChatAdapter } = await import(
        '../src/modules/narranexus/narranexus-chat.adapter'
    )
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const calls: PreflightCall[] = []
    await withFetch(
        async (input, init) => {
            const entry = recordCall(calls, input, init)
            if (entry.method === 'HEAD') {
                const headAttempt = calls.filter(
                    (c) => c.method === 'HEAD'
                ).length
                if (headAttempt < 3)
                    throw new Error('connect ECONNREFUSED 198.51.100.7:443')
                return { ok: true, status: 200 }
            }
            return sseResponse([
                'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
                'data: [DONE]\n\n'
            ])
        },
        async () => {
            const adapter = new NarraNexusChatAdapter(
                ...adapterArgs('narranexus')
            )
            const events = await collectUnderMockTime(
                t,
                adapter.sendMessage(fakeCtx('narranexus'), userMessage())
            )
            assert.ok(
                !events.some((ev) => ev.type === 'error'),
                'a socket that binds within budget must not surface any error'
            )
            assert.ok(
                events.some(
                    (ev) => ev.type === 'token' && ev.text === 'hello'
                ),
                'the turn streamed through after preflight recovered'
            )
            assert.equal(
                events.at(-1)?.type,
                'done',
                'the send completes in the SAME call that absorbed the wake latency'
            )
            const heads = calls.filter((c) => c.method === 'HEAD')
            assert.equal(
                heads.length,
                3,
                'preflight stops probing as soon as the socket binds'
            )
            const posts = calls.filter((c) => c.method === 'POST')
            assert.equal(posts.length, 1)
            assert.equal(
                posts[0].url,
                `${BASE_URL}/v1/chat/completions`,
                'after preflight passes, the send proceeds to the chat completions POST'
            )
            assert.ok(
                posts[0].at < NARRANEXUS_BUDGET_MS,
                'recovery happened within the configured budget'
            )
        }
    )
})

// WHY: parameterizing the budget (D6) must not move openclaw's behavior —
// the 30s default and the openclaw_not_ready code are pinned so the
// narranexus override can never leak into the base adapter.
test('openclaw preflight pinned unchanged: 30s default budget and openclaw_not_ready', async (t) => {
    const { OpenclawAdapter } = await import(
        '../src/modules/chat/adapters/openclaw.adapter'
    )
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const calls: PreflightCall[] = []
    await withFetch(
        async (input, init) => {
            recordCall(calls, input, init)
            throw timeoutError()
        },
        async () => {
            const adapter = new OpenclawAdapter(...adapterArgs('openclaw'))
            const events = await collectUnderMockTime(
                t,
                adapter.sendMessage(fakeCtx('openclaw'), userMessage())
            )
            const { error } = onlyError(events)
            assert.equal(
                error.code,
                'openclaw_not_ready',
                'openclaw keeps its own framework-derived code — narranexus parameterization must not change it'
            )
            assert.equal(error.retryable, true)
            assert.match(
                error.message,
                /^openclaw gateway/,
                'the message stays openclaw-attributed'
            )
            assert.match(
                error.message,
                /within 30s/,
                'the openclaw default budget stays 30s'
            )
            const heads = calls.filter((c) => c.method === 'HEAD')
            assert.ok(
                heads.every((c) => c.at < OPENCLAW_DEFAULT_BUDGET_MS),
                'no attempt may start at or past the 30s default budget'
            )
            assert.ok(
                (heads.at(-1)?.at ?? 0) + RETRY_DELAY_MS >=
                    OPENCLAW_DEFAULT_BUDGET_MS,
                'openclaw retried for the FULL 30s default — the NARRANEXUS_PREFLIGHT_BUDGET_MS override must not leak into openclaw'
            )
        }
    )
})
