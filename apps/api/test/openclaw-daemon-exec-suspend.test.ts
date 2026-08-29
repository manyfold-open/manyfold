import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import type { ExecDriver } from '../src/modules/chat/adapters/exec-driver'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'

// #666. The daemon-spawn path (`openclaw agent --json` over exec.start) was the
// last daemon-carrying path that reported a lost socket as a failed run. Every
// other one suspends: the daemon is still running the child and re-reports the
// stream in its next hello, while an error event writes a terminal that makes
// the turn invisible to recovery. These pin which rejections mean "the socket
// died" and which still mean "the run failed" — the distinction #513/#570 and
// the 2026-08-03 double-api-death paid for.

const DAEMON_ID = 'dh_1'
const MESSAGE_ID = 'msg_assistant'

const empty = async function* (): AsyncIterable<string> {}

const makeDrivers = (rejection: Error, execHandles: string[]) => {
    const driver: ExecDriver = {
        stream: (req) => {
            if (req.execHandle) execHandles.push(req.execHandle)
            const result = Promise.reject(rejection)
            // Mirrors observedResult: an unobserved rejection takes the whole
            // instance down (2026-08-03), and the adapter only awaits it later.
            result.catch(() => {})
            return {
                stdout: empty(),
                stderr: empty(),
                result: result as never,
                abort: () => {}
            }
        }
    }
    return {
        forAgent: async () => ({
            driver,
            creds: null,
            runtime: 'daemon',
            agent: {
                id: 'agt_1',
                internalId: 'main',
                daemonId: DAEMON_ID,
                model: null
            }
        })
    }
}

const makeDb = () => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [
                    {
                        runtime: 'daemon',
                        internalId: 'main',
                        daemonId: DAEMON_ID
                    }
                ]
            })
        })
    })
})

const buildAdapter = (
    rejection: Error
): { adapter: OpenclawAdapter; execHandles: string[] } => {
    const execHandles: string[] = []
    const adapter = new OpenclawAdapter(
        makeDb() as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        makeDrivers(rejection, execHandles) as never,
        { event: () => {}, error: () => {} } as never
    )
    return { adapter, execHandles }
}

const ctx = {
    userId: 'user-1',
    agentId: 'agt_1',
    runtimeId: 'art_1',
    sessionId: 'cts_1',
    messageId: MESSAGE_ID,
    framework: 'openclaw',
    runtimeKind: 'daemon',
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    frameworkSessionRef: 'fsr-1',
    history: []
} as ApiChatAdapterContext

const userMessage: ChatMessage = {
    id: 'msg_user',
    sessionId: 'cts_1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-08-08T00:00:00.000Z'
}

const run = async (rejection: Error): Promise<EmittedChatEvent[]> => {
    const { adapter } = buildAdapter(rejection)
    const out: EmittedChatEvent[] = []
    for await (const ev of adapter.sendMessage(ctx, userMessage)) out.push(ev)
    return out
}

// WHY: `connection replaced` IS the reconnect — the daemon re-registering fails
// the RPCs on the socket it just superseded. Terminalizing here killed the turn
// one second before the recovery path would have picked it up (2026-07-26).
test('a connection replaced by the daemon reconnect suspends the turn', async () => {
    const events = await run(new Error('connection replaced'))

    const suspended = events.find((ev) => ev.type === 'suspended')
    assert.ok(
        suspended,
        `a lost socket must suspend, not terminalize; got ${JSON.stringify(events)}`
    )
    assert.equal(
        suspended.type === 'suspended' && suspended.daemonId,
        DAEMON_ID
    )
    assert.equal(
        suspended.type === 'suspended' && suspended.daemonExecRef,
        MESSAGE_ID,
        'the exec ref must be the refId the exec was dispatched under, or no hello can match this turn'
    )
    assert.equal(
        suspended.type === 'suspended' && suspended.reason,
        'connection replaced'
    )
    assert.ok(
        !events.some((ev) => ev.type === 'error'),
        'an error event writes a terminal, which is exactly what makes the turn unrecoverable'
    )
    assert.ok(!events.some((ev) => ev.type === 'done'))
})

// WHY: the exec ref is not a free choice — the resume path finds an orphan by
// (daemon_id, daemon_exec_ref), and chat.service stamps the message with the
// assistant message id. The suspend has to name the same handle the exec was
// dispatched under.
test('the suspended exec ref is the handle the exec was dispatched under', async () => {
    const { adapter, execHandles } = buildAdapter(
        new Error('connection closed')
    )
    const events: EmittedChatEvent[] = []
    for await (const ev of adapter.sendMessage(ctx, userMessage))
        events.push(ev)

    assert.deepEqual(execHandles, [MESSAGE_ID])
    const suspended = events.find((ev) => ev.type === 'suspended')
    assert.equal(
        suspended?.type === 'suspended' && suspended.daemonExecRef,
        execHandles[0]
    )
})

// WHY: blast radius. A run that genuinely failed still has to fail — suspending
// it would park the turn waiting for a hello that reports nothing.
test('a non-transport failure keeps the retryable exec error unchanged', async () => {
    const events = await run(new Error('daemon process crashed'))

    assert.ok(
        !events.some((ev) => ev.type === 'suspended'),
        'only connection-lifecycle failures may suspend'
    )
    const err = events.find((ev) => ev.type === 'error')
    assert.ok(err)
    assert.equal(
        err.type === 'error' && err.error.code,
        'openclaw_daemon_exec_failed'
    )
    assert.equal(err.type === 'error' && err.error.retryable, true)
    assert.equal(
        err.type === 'error' && err.error.message,
        'daemon process crashed'
    )
})

// WHY: the 2026-08-03 lesson. A dispatch that never reached the daemon has no
// stream for any hello to report, so suspending parks it until the unmatched
// sweep ages it out; failing retryably lets the caller re-send at once, and it
// is safe precisely because nothing ran.
test('a never-dispatched exec fails retryably instead of suspending', async () => {
    const events = await run(new Error(`daemon ${DAEMON_ID} is not connected`))

    assert.ok(!events.some((ev) => ev.type === 'suspended'))
    const err = events.find((ev) => ev.type === 'error')
    assert.ok(err)
    assert.equal(
        err.type === 'error' && err.error.code,
        'openclaw_daemon_exec_failed'
    )
    assert.equal(err.type === 'error' && err.error.retryable, true)
})
