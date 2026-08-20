import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import {
    isDaemonNotDispatchedError,
    isDaemonOfflineTransportError,
    isDaemonResumeSuspendError,
    type ApiChatAdapterContext,
    type ApiChatResumeContext,
    type EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// #570: a resume attach reverses the burden of proof. For the INITIAL send a
// lookup failure ("offline; no active websocket" / "is not connected" /
// "websocket lease is stale") correctly means "nothing was dispatched, fail
// retryably" — but on a resume the daemon's hello has ALREADY reported the
// stream and the DB holds runner frames, so the same strings mean "the socket
// died between hello and attach". Staging 2026-08-05: a pong timeout landed
// while a queued resume waited behind a long-lived peer resume; the attach hit
// `offline; no active websocket` and wrote a terminal `codex_exec_failed` over
// a turn that had streamed to exact runner cursor 56, permanently excluding it
// from every later hello. These pin the split: resume attach suspends on
// lookup-offline, the initial send still fails retryably.

const LOOKUP_OFFLINE_REASONS = [
    'daemon dh_x is offline; no active websocket',
    'daemon dh_x is not connected',
    'daemon dh_x websocket lease is stale on this api instance'
]

test('the resume-suspend set is the union of both transport classes', () => {
    for (const reason of [
        ...LOOKUP_OFFLINE_REASONS,
        'daemon dh_x rpc failed: connection replaced',
        'exec stream failed: connection closed',
        'daemon disconnected',
        'daemon rpc broker shutting down'
    ]) {
        assert.ok(
            isDaemonResumeSuspendError(reason),
            `a hello-proven stream must suspend on: ${reason}`
        )
    }
})

test('the resume-suspend set still excludes real execution failures', () => {
    // Over-matching here would park genuinely broken resumes open forever.
    for (const reason of [
        'codex exited 1: some failure',
        'spawn codex ENOENT',
        'exec timed out after 7200000ms',
        'rpc exec.resume timed out',
        'HTTP 502'
    ]) {
        assert.ok(!isDaemonResumeSuspendError(reason), `must fail: ${reason}`)
    }
})

test('the initial-send classification is untouched (#481/#512 guard)', () => {
    // The fix must not leak resume semantics into the dispatch path: a lookup
    // failure on the initial send still means nothing ran, so suspending it
    // would park a zero-output turn for minutes (the exact #481/#512 shape).
    for (const reason of LOOKUP_OFFLINE_REASONS) {
        assert.ok(isDaemonNotDispatchedError(reason))
        assert.ok(!isDaemonOfflineTransportError(reason))
    }
})

// The real transport surfaces a lookup failure as a rejected handle.result
// with an already-ended stdout (DaemonExecDriver closes the sinks before
// rethrowing), so that is exactly what these fakes reproduce.
const offlineHandle = (reason: string) => {
    const result = Promise.reject(new Error(reason))
    // Mark handled: the adapters attach their catch a few microtasks later.
    result.catch(() => {})
    return {
        stdout: (async function* (): AsyncGenerator<string> {})(),
        stderr: (async function* (): AsyncGenerator<string> {})(),
        result,
        abort: () => {},
        lastDeliveredSeq: () => 0
    }
}

const adminSettings = {
    isFeatureEnabled: async () => true,
    getCachedChatExecTimeoutMs: async () => ({
        timeoutMs: 1000,
        keepAliveMs: 1000,
        livenessTimeoutMs: 1000
    })
}

const chatRepo = { updateFrameworkSessionRef: async () => {} }
const pricing = { priceFor: () => null }

const resumeCtx = (): ApiChatResumeContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        runtimeKind: 'sprites',
        model: 'gpt-5',
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: 'thread-1',
        history: [],
        daemonId: 'dh_runner',
        daemonExecRef: 'msg_1',
        fromSeq: 12
    }) as unknown as ApiChatResumeContext

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

const assertSuspended = (events: EmittedChatEvent[], reason: string): void => {
    const suspended = events.find((e) => e.type === 'suspended')
    assert.ok(suspended, `must suspend, got: ${JSON.stringify(events)}`)
    if (suspended.type !== 'suspended') return
    assert.equal(suspended.daemonId, 'dh_runner')
    assert.equal(suspended.daemonExecRef, 'msg_1')
    assert.equal(suspended.reason, reason)
    // A suspended turn must stay open: neither terminal may follow.
    assert.ok(!events.some((e) => e.type === 'error'))
    assert.ok(!events.some((e) => e.type === 'done'))
}

test('a codex resume attach that finds the daemon offline suspends, never terminalizes', async () => {
    for (const reason of LOOKUP_OFFLINE_REASONS) {
        const drivers = {
            daemonDriverFor: () => ({
                stream: () => offlineHandle(reason),
                resumeStream: () => offlineHandle(reason)
            })
        }
        const adapter = new CodexAdapter(
            drivers as never,
            chatRepo as never,
            pricing as never,
            adminSettings as never
        )
        const events = await drain(adapter.resumeMessage(resumeCtx() as never))
        assertSuspended(events, reason)
    }
})

test('a gemini resume attach that finds the daemon offline suspends too', async () => {
    for (const reason of LOOKUP_OFFLINE_REASONS) {
        const drivers = {
            daemonDriverFor: () => ({
                stream: () => offlineHandle(reason),
                resumeStream: () => offlineHandle(reason)
            })
        }
        const adapter = new GeminiCliAdapter(
            drivers as never,
            chatRepo as never,
            pricing as never,
            adminSettings as never
        )
        const events = await drain(adapter.resumeMessage(resumeCtx() as never))
        assertSuspended(events, reason)
    }
})

test('a claude resume attach that finds the daemon offline suspends too', async () => {
    for (const reason of LOOKUP_OFFLINE_REASONS) {
        const drivers = {
            daemonDriverFor: () => ({
                stream: () => offlineHandle(reason),
                resumeStream: () => offlineHandle(reason)
            })
        }
        const adapter = new ClaudeCodeAdapter(
            drivers as never,
            chatRepo as never,
            adminSettings as never
        )
        const events = await drain(adapter.resumeMessage(resumeCtx() as never))
        assertSuspended(events, reason)
    }
})

test('a mid-resume socket loss still suspends (the pre-#570 behaviour survives)', async () => {
    const reason = 'daemon dh_runner rpc failed: connection replaced'
    const drivers = {
        daemonDriverFor: () => ({
            stream: () => offlineHandle(reason),
            resumeStream: () => offlineHandle(reason)
        })
    }
    const adapter = new CodexAdapter(
        drivers as never,
        chatRepo as never,
        pricing as never,
        adminSettings as never
    )
    const events = await drain(adapter.resumeMessage(resumeCtx() as never))
    assertSuspended(events, reason)
})

test('the initial codex dispatch hitting a lookup failure still fails retryably', async () => {
    // The #481/#512 regression guard at the adapter level: the same string
    // that suspends a resume must terminalize an initial send immediately —
    // nothing ran, so the caller can safely re-send at once.
    const reason = 'daemon dh_x is offline; no active websocket'
    const drivers = {
        forAgent: async () => ({
            driver: { stream: () => offlineHandle(reason) },
            agent: { daemonId: 'dh_x', workspacePath: null, extras: {} },
            creds: null,
            runtime: 'daemon'
        }),
        daemonDriverFor: () => ({ stream: () => offlineHandle(reason) })
    }
    const adapter = new CodexAdapter(
        drivers as never,
        chatRepo as never,
        pricing as never,
        adminSettings as never
    )
    const ctx = {
        ...(resumeCtx() as unknown as Record<string, unknown>),
        daemonId: undefined,
        daemonExecRef: undefined,
        fromSeq: undefined,
        runnerDaemonId: undefined,
        frameworkSessionRef: null
    } as unknown as ApiChatAdapterContext
    const userMessage = {
        id: 'msg_u',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }]
    }
    const events = await drain(adapter.sendMessage(ctx, userMessage as never))
    assert.ok(!events.some((e) => e.type === 'suspended'))
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.error.code, 'codex_exec_failed')
    assert.equal(error.error.retryable, true)
})
