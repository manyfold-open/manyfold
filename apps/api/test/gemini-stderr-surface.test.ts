import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// A model call the gateway rejects (404/503) is reported ONLY on gemini's
// stderr: the CLI retries it for minutes, then exits 0 with a result line whose
// message is the generic "[API Error: An unknown error occurred.]". A live turn
// on 2026-07-27 therefore showed ~4 minutes of "Connecting…" and then a error
// nobody could act on, while the real cause ("no available Gemini accounts")
// sat in stderr and was dropped. These pin that the cause reaches the user.

const PROMPT = 'hello?'
const GENERIC = '[API Error: An unknown error occurred.]'
const CAUSE =
    '{"error":{"code":503,"message":"No available Gemini accounts: no available accounts"}}'

const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

const RESULT_ERROR_STDOUT =
    LINE({ type: 'init', session_id: 'sess-1' }) +
    LINE({ type: 'result', status: 'error', message: GENERIC })

// Worst-case ordering on purpose: stderr lands only AFTER stdout is done. A
// live gemini stays silent through the whole retry window and then writes the
// cause and the result line at the same moment, so the adapter must not depend
// on stderr arriving first — reading it inline at the result line loses that
// race. Making stderr strictly last here is what pins the fix as deterministic.
const handleFor = (opts: {
    stdout: string
    stderr: string
    exitCode?: number
    resultStderr?: string
}) => {
    let stdoutDone = false
    return {
        stdout: (async function* () {
            yield opts.stdout
            stdoutDone = true
        })(),
        stderr: (async function* () {
            await new Promise((r) => setImmediate(r))
            assert.ok(stdoutDone, 'stderr is delivered after stdout ends')
            yield opts.stderr
        })(),
        result: Promise.resolve({
            exitCode: opts.exitCode ?? 0,
            stdout: '',
            stderr: opts.resultStderr ?? ''
        }),
        abort: () => {}
    }
}

const buildDrivers = (handle: ReturnType<typeof handleFor>) => {
    const driver = { stream: () => handle }
    return {
        forAgent: async () => ({
            driver,
            creds: { googleApiKey: 'key' },
            runtime: 'sprites',
            agent: {
                id: 'agt_1',
                daemonId: null,
                spriteName: 'sprite-1',
                workspacePath: '/home/sprite/work'
            }
        }),
        daemonDriverFor: () => driver,
        recoveryFsForAgent: async () => ({
            runtime: 'sprites',
            fs: {
                locate: async () => null,
                readFile: async () => null,
                listFiles: async () => []
            }
        })
    }
}

const adapterOf = (
    drivers: unknown,
    chatRepo: unknown = { updateFrameworkSessionRef: async () => {} }
): GeminiCliAdapter =>
    new GeminiCliAdapter(
        drivers as never,
        chatRepo as never,
        { priceFor: () => null } as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                timeoutMs: 1000,
                keepAliveMs: 1000,
                livenessTimeoutMs: 1000
            })
        } as never
    )

const ctx = (
    frameworkSessionRef: string | null = null
): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        model: null,
        modelOverride: null,
        modelConfig: null,
        frameworkSessionRef,
        history: []
    }) as unknown as ApiChatAdapterContext

const userMessage = (): ChatMessage =>
    ({
        id: 'msg_0',
        role: 'user',
        contentBlocks: [{ type: 'text', text: PROMPT }]
    }) as unknown as ChatMessage

const errorFrom = async (
    handle: ReturnType<typeof handleFor>
): Promise<Extract<EmittedChatEvent, { type: 'error' }>> => {
    const events: EmittedChatEvent[] = []
    for await (const ev of adapterOf(buildDrivers(handle)).sendMessage(
        ctx(),
        userMessage()
    ))
        events.push(ev)
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error', 'the turn reported an error')
    return error
}

test('a gemini result error carries the stderr cause, not just the generic text', async () => {
    const error = await errorFrom(
        handleFor({
            stdout: RESULT_ERROR_STDOUT,
            stderr: `ModelNotFoundError: gemini-3.5-flash\n${CAUSE}\n`
        })
    )
    const message = error.error.message
    // The whole point: exit code is 0, so without the stderr tail this message
    // is only GENERIC and the operator has nothing to act on.
    assert.match(message, /No available Gemini accounts/)
    assert.match(message, /ModelNotFoundError/)
    assert.ok(message.includes(GENERIC), 'keeps the CLI-reported message too')
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
})

test('stderr attached to an error never leaks the API key', async () => {
    const message = (
        await errorFrom(
            handleFor({
                stdout: RESULT_ERROR_STDOUT,
                stderr: `env GEMINI_API_KEY=sk-d0bSECRETVALUE123456 rejected\n${CAUSE}\n`
            })
        )
    ).error.message
    assert.ok(!message.includes('sk-d0bSECRETVALUE123456'), 'key redacted')
    assert.match(message, /No available Gemini accounts/)
})

test('a non-zero exit falls back to drained stderr when result.stderr is empty', async () => {
    // The daemon transport (runner-carried turns) always reports result.stderr
    // as '', so the drained tail is the only source there.
    const error = await errorFrom(
        handleFor({
            stdout: LINE({ type: 'init', session_id: 'sess-1' }),
            stderr: `${CAUSE}\n`,
            exitCode: 1,
            resultStderr: ''
        })
    )
    const message = error.error.message
    assert.match(message, /gemini exited 1/)
    assert.match(message, /No available Gemini accounts/)
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
})

test('a clean turn attaches no stderr noise', async () => {
    const events: EmittedChatEvent[] = []
    for await (const ev of adapterOf(
        buildDrivers(
            handleFor({
                stdout:
                    LINE({ type: 'init', session_id: 'sess-1' }) +
                    LINE({
                        type: 'message',
                        role: 'assistant',
                        content: 'hi'
                    }) +
                    LINE({ type: 'result', status: 'success' }),
                stderr: 'npm notice: a harmless warning\n'
            })
        )
    ).sendMessage(ctx(), userMessage()))
        events.push(ev)
    assert.ok(!events.some((e) => e.type === 'error'), 'no error emitted')
    assert.equal(events.at(-1)?.type, 'done')
})

// #594: gemini-cli 0.53.0-0.54.0 write completed tool calls into their own
// session file with no thought signature, and the provider rejects that history
// on every REPLAY. The staging session (three good tool turns, then nothing but
// 400s) could never recover by retrying, because retrying resumed the same
// poisoned session. All the user saw was "gemini exited 144" — the cause was
// buried in the head of a stderr the adapter kept only the tail of.

const UNSIGNED_400 =
    'ApiError: got status: 400 Bad Request. {"error":{"code":400,"status":"INVALID_ARGUMENT",' +
    '"message":"Unable to submit request because Function call is missing a thought_signature in ' +
    'functionCall parts. Please ensure the thought_signature from the model response is passed back. ' +
    'Offending part: default_api:run_shell_command at position 36"}}'

// A real 0.53.1 crash prints ~60 frames of bundled-CLI stack between the cause
// and the last line — comfortably more than the head+tail budget.
const STACK = Array.from(
    { length: 60 },
    (_, i) =>
        `    at frame${i} (/home/sprite/.local/share/npm/lib/node_modules/@google/gemini-cli/dist/index.js:${1000 + i}:17)`
).join('\n')

const CRASH_STDERR = `${UNSIGNED_400}\n${STACK}\nnode:internal/process/promises:391 triggerUncaughtException`

const runTurn = async (opts: {
    handle: ReturnType<typeof handleFor>
    sessionRef?: string | null
}): Promise<{ events: EmittedChatEvent[]; refs: (string | null)[] }> => {
    const refs: (string | null)[] = []
    const adapter = adapterOf(buildDrivers(opts.handle), {
        updateFrameworkSessionRef: async (
            _sessionId: string,
            ref: string | null
        ) => {
            refs.push(ref)
        }
    })
    const events: EmittedChatEvent[] = []
    for await (const ev of adapter.sendMessage(
        ctx(opts.sessionRef ?? null),
        userMessage()
    ))
        events.push(ev)
    return { events, refs }
}

const poisonedTurn = () =>
    runTurn({
        sessionRef: 'sess-poisoned',
        handle: handleFor({
            stdout: LINE({ type: 'init', session_id: 'sess-poisoned' }),
            stderr: CRASH_STDERR,
            exitCode: 144,
            resultStderr: ''
        })
    })

// The fix that makes the failure survivable: drop the resume ref so the next
// turn opens a fresh gemini session. Keeping it means the retry replays the same
// unsigned history and 400s again, forever.
test('a 400 on unsigned tool-call history forks the poisoned session', async () => {
    const { events, refs } = await poisonedTurn()

    assert.deepEqual(refs, [null], 'the framework session ref was cleared')
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.error.code, 'gemini_exec_failed')
    // a fresh session is a genuinely different input, so retrying is no longer
    // the same doomed request
    assert.equal(error.error.retryable, true)
    assert.match(error.error.message, /fresh gemini session/)
})

// The reported symptom: the operator got "gemini exited 144" and a stack, with
// the provider's sentence already cut off. Both ends have to survive.
test('a long crash keeps the provider cause AND the failing tail', async () => {
    const { events } = await poisonedTurn()
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')
    const message = error.error.message

    assert.match(message, /gemini exited 144/)
    assert.match(message, /missing a thought_signature/)
    assert.match(message, /triggerUncaughtException/)
    assert.match(message, /\n\.\.\.\n/, 'the dropped middle is marked')
    // still bounded — the point is a readable message, not the whole crash
    assert.ok(message.length < 2_000, `message length ${message.length}`)
})

// Slicing after redaction is what makes this safe: a credential in the head is
// gone before either end is cut, so no half-token can ride along.
test('the surviving head of a long stderr is still redacted', async () => {
    const { events } = await runTurn({
        sessionRef: 'sess-poisoned',
        handle: handleFor({
            stdout: LINE({ type: 'init', session_id: 'sess-poisoned' }),
            stderr: `GEMINI_API_KEY=sk-d0bSECRETVALUE123456 ${CRASH_STDERR}`,
            exitCode: 144,
            resultStderr: ''
        })
    })
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')

    assert.ok(!error.error.message.includes('sk-d0bSECRETVALUE123456'))
    assert.match(error.error.message, /missing a thought_signature/)
})

// Forking costs the turn's conversational context, so it must happen only for
// the one failure it fixes — not for every gemini error.
test('an ordinary failure leaves the session ref alone', async () => {
    const { events, refs } = await runTurn({
        sessionRef: 'sess-healthy',
        handle: handleFor({
            stdout: LINE({ type: 'init', session_id: 'sess-healthy' }),
            stderr: `${CAUSE}\n`,
            exitCode: 1,
            resultStderr: ''
        })
    })

    assert.deepEqual(refs, [], 'no session ref write at all')
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.error.retryable, false)
    assert.doesNotMatch(error.error.message, /fresh gemini session/)
})

// The CLI can also report the 400 on stdout and exit 0. Same poisoned session,
// same fix — keying on the exit code alone would miss it.
test('the same 400 reported as a result error also forks the session', async () => {
    const { events, refs } = await runTurn({
        sessionRef: 'sess-poisoned',
        handle: handleFor({
            stdout:
                LINE({ type: 'init', session_id: 'sess-poisoned' }) +
                LINE({
                    type: 'result',
                    status: 'error',
                    message: UNSIGNED_400
                }),
            stderr: ''
        })
    })

    assert.deepEqual(refs, [null])
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.error.code, 'gemini_result_error')
    assert.equal(error.error.retryable, true)
})
