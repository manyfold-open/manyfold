import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { classifyChatFailureCause } from '../src/modules/chat/chat-failure-cause'
import { chatFailureCauses } from '../src/common/telemetry/chat-failure-taxonomy'
import { buildTelemetryCaptureOptions } from '../src/sentry-grouping'
import {
    GEMINI_MIXED_THROTTLE_THEN_POOL_EMPTY,
    GEMINI_NODE_INSPECT_POOL_EMPTY,
    MANAGED_POOL_EMPTY_LOOKALIKES
} from './managed-pool-empty-sample'

// #803. Seen on staging [2026-08-13]: a managed Gemini turn met an upstream
// HTTP 429 / RESOURCE_EXHAUSTED, gemini-cli spent ~240 seconds on its own retry
// ladder, and the terminal Manyfold persisted was a generic gemini_exec_failed
// with retryable=false and no cause at all — so the UI could not offer the one
// action that works (send it again), and the incident stayed in the mixed
// Sentry group #786 exists to drain.
//
// These run the real adapter over a fake exec driver, because the two things
// under test are decided there: what the terminal says about retrying, and
// which structured signal the terminal carries.
//
// #660 (reopened 2026-08-13) is asserted here too, and deliberately in the same
// file: it is the same precedence question — a 429 ladder that ENDS in an empty
// pool — asked of the other wire shape the CLI can print the answer in. Keeping
// both beside each other is what stops one shape from being fixed while the
// other silently regresses.

const PROMPT = 'hello?'

const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

// The status line gemini-cli raises and the RPC envelope it quotes. The
// sentence inside it is vendor prose and is deliberately NOT what any of this
// keys on — the status and the RPC status name are.
const THROTTLE_ENVELOPE =
    'ApiError: got status: 429 Too Many Requests. {"error":{"code":429,' +
    '"message":"Resource has been exhausted (e.g. check quota).",' +
    '"status":"RESOURCE_EXHAUSTED"}}'

// What four minutes of the CLI's own ladder leaves behind. Included because it
// is most of a throttled turn's stderr, and because a message this long is what
// the head+tail bound then cuts.
const LADDER = Array.from(
    { length: 5 },
    (_, i) =>
        `Attempt ${i + 1} failed with status 429. Retrying in ${2 ** (i + 1)}s...`
).join('\n')

const THROTTLED_STDERR = `${LADDER}\n${THROTTLE_ENVELOPE}`

// #660's marker, structured exactly as the gateway sends it.
const POOL_EMPTY =
    '{"error":{"code":503,"message":"No available Gemini accounts: no available accounts"}}'

// ...and #660's marker as the CLI actually PRINTS it, which is the shape that
// reopened the issue. Same three branches below, same precedence question, the
// other wire form. See managed-pool-empty-sample for why the two differ.
const NODE_INSPECT_TRACE = GEMINI_MIXED_THROTTLE_THEN_POOL_EMPTY

const BALANCE_EMPTY = 'Insufficient account balance'

const handleFor = (opts: {
    stdout: string
    stderr: string
    exitCode?: number
    resultStderr?: string
}) => ({
    stdout: (async function* () {
        yield opts.stdout
    })(),
    stderr: (async function* () {
        await new Promise((r) => setImmediate(r))
        yield opts.stderr
    })(),
    result: Promise.resolve({
        exitCode: opts.exitCode ?? 0,
        stdout: '',
        stderr: opts.resultStderr ?? ''
    }),
    abort: () => {}
})

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

interface TurnResult {
    error: Extract<EmittedChatEvent, { type: 'error' }>
    dispatches: number
    refs: (string | null)[]
}

const runTurn = async (opts: {
    stdout: string
    stderr: string
    exitCode?: number
    resultStderr?: string
    sessionRef?: string | null
}): Promise<TurnResult> => {
    let dispatches = 0
    const refs: (string | null)[] = []
    const driver = {
        stream: () => {
            dispatches += 1
            return handleFor(opts)
        }
    }
    const drivers = {
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
    const adapter = new GeminiCliAdapter(
        drivers as never,
        {
            updateFrameworkSessionRef: async (
                _sessionId: string,
                ref: string | null
            ) => {
                refs.push(ref)
            },
            clearFrameworkSessionRefIfMatches: async () => true
        } as never,
        { priceFor: () => null } as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                timeoutMs: 1000,
                keepAliveMs: 1000,
                livenessTimeoutMs: 1000
            })
        } as never
    )
    const events: EmittedChatEvent[] = []
    for await (const ev of adapter.sendMessage(
        ctx(opts.sessionRef ?? null),
        userMessage()
    ))
        events.push(ev)
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error', 'the turn reported an error')
    return { error, dispatches, refs }
}

const causeOf = (error: TurnResult['error']): string | null =>
    classifyChatFailureCause({
        errorCode: error.error.code,
        message: error.error.message
    })

// The reported failure, exactly: a fresh dispatch that exits non-zero with the
// 429 in stderr. `retryable: true` is the whole user-visible fix.
test('a throttled fresh dispatch ends retryable, and as a throttle', async () => {
    const { error } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: THROTTLED_STDERR,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.error.code, 'gemini_exec_failed')
    assert.equal(error.error.retryable, true)
    assert.equal(causeOf(error), 'rate_limited')
    // Not the pool's incident: nothing here says the gateway ran out of
    // accounts, so the shared breaker must be offered no signal at all.
    assert.equal(error.managedChannelFailure, undefined)
})

// Same refusal reported the other way gemini reports it: exit 0 with the error
// in its own result line. Keying on the exit code alone would miss it, and the
// same upstream failure would be retryable or not depending on which branch
// happened to run.
test('a throttle reported as a result error ends retryable too', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'result',
                status: 'error',
                message: THROTTLE_ENVELOPE
            }),
        stderr: ''
    })

    assert.equal(error.error.code, 'gemini_result_error')
    assert.equal(error.error.retryable, true)
    assert.equal(causeOf(error), 'rate_limited')
    assert.equal(error.managedChannelFailure, undefined)
})

// The third terminal the CLI can write one through: a stream-level error line.
// It reads the same rule so the three cannot disagree.
test('a throttle on the stdout error line ends retryable too', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({ type: 'error', message: THROTTLE_ENVELOPE }),
        stderr: ''
    })

    assert.equal(error.error.code, 'gemini_error')
    assert.equal(error.error.retryable, true)
    assert.equal(causeOf(error), 'rate_limited')
})

test('a balance after 429s stays non-retryable on every terminal branch', async () => {
    const cases = [
        {
            name: 'stdout error',
            stdout:
                LINE({ type: 'init', session_id: 'sess-1' }) +
                LINE({
                    type: 'error',
                    message: `${THROTTLE_ENVELOPE}\n${BALANCE_EMPTY}`
                }),
            stderr: ''
        },
        {
            name: 'non-zero exit',
            stdout: LINE({ type: 'init', session_id: 'sess-1' }),
            stderr: `${THROTTLED_STDERR}\n${BALANCE_EMPTY}`,
            exitCode: 1,
            resultStderr: ''
        },
        {
            name: 'result error',
            stdout:
                LINE({ type: 'init', session_id: 'sess-1' }) +
                LINE({
                    type: 'result',
                    status: 'error',
                    message: '[API Error: An unknown error occurred.]'
                }),
            stderr: `${THROTTLED_STDERR}\n${BALANCE_EMPTY}`
        }
    ]

    for (const fixture of cases) {
        const { name, ...turn } = fixture
        const { error } = await runTurn(turn)
        assert.equal(causeOf(error), 'balance_exhausted', name)
        assert.equal(error.error.retryable, false, name)
    }
})

// The precedence the issue is explicit about. A ladder full of 429s that ENDS
// in the structured empty-pool envelope is #660's incident: refilling the pool
// is the fix, the terminal is deliberately not retryable, and the breaker signal
// must survive every throttle that preceded it.
test('a ladder of 429s ending in an empty pool is still the pool', async () => {
    const { error } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: `${THROTTLED_STDERR}\n${POOL_EMPTY}`,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

// And the same trace through the result-error branch, because that is the one
// the reported #660 turns actually came through (exit 0, generic result line).
test('the pool still wins after 429s on the result-error branch', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'result',
                status: 'error',
                message: '[API Error: An unknown error occurred.]'
            }),
        stderr: `${THROTTLED_STDERR}\n${POOL_EMPTY}`
    })

    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

test('the pool still wins after 429s on the stdout error branch', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'error',
                message: `${THROTTLE_ENVELOPE}\n${POOL_EMPTY}`
            }),
        stderr: ''
    })

    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

// #660 reopened. The three tests above prove the precedence against the JSON
// envelope the gateway sends. Staging showed gemini-cli does not always print
// that envelope for the FINAL cause: it lets the `_ApiError` reach Node's top
// level, so the pair arrives Node-inspected — bare keys, single quotes, wrapped
// across lines. The JSON reader found nothing in it, the capacity marker came
// away null, and `managed_channel_breakers` stayed empty through three
// terminals. Same three branches, because a shape recognised on one road and
// not another is the bug this file exists to prevent.
//
// Reopened a SECOND time on the same three branches (Seen on staging
// [2026-08-13]): the cause the gateway sends is a google.rpc.Status, so it
// prints `details: []` beside the pair, and the first Node-shape reader rejected
// any `[` in the cause body. The fixture these three now run is the capture
// with that field in it, so each of them fails on a reader that cannot look past
// a benign sibling.
test('the real CLI-printed pool cause marks capacity on a non-zero exit', async () => {
    const { error } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: NODE_INSPECT_TRACE,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.error.code, 'gemini_exec_failed')
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

// The branch the reported #660 turns actually came through: exit 0, a generic
// result line, and the real cause only on stderr.
test('the real CLI-printed pool cause marks capacity on the result-error branch', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'result',
                status: 'error',
                message: '[API Error: An unknown error occurred.]'
            }),
        stderr: NODE_INSPECT_TRACE
    })

    assert.equal(error.error.code, 'gemini_result_error')
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

test('the real CLI-printed pool cause marks capacity on the stdout error branch', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'error',
                severity: 'error',
                message: NODE_INSPECT_TRACE
            }),
        stderr: ''
    })

    assert.equal(error.error.code, 'gemini_error')
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

// The precedence stated as a difference rather than as two separate facts: one
// trace, with and without its last ten lines. #803's verdict has to survive
// unchanged on the left, and #660's has to win on the right — including the
// retryability, which is the half the user acts on.
test('the final cause decides the trace: the same 429 ladder is a throttle without it', async () => {
    const withoutPoolEmpty = NODE_INSPECT_TRACE.slice(
        0,
        NODE_INSPECT_TRACE.indexOf('_ApiError: got status: 503')
    ).trimEnd()
    assert.ok(withoutPoolEmpty.includes('RESOURCE_EXHAUSTED'))

    const throttled = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: withoutPoolEmpty,
        exitCode: 1,
        resultStderr: ''
    })
    assert.equal(throttled.error.managedChannelFailure, undefined)
    assert.equal(throttled.error.error.retryable, true)
    assert.equal(causeOf(throttled.error), 'rate_limited')

    const exhausted = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: NODE_INSPECT_TRACE,
        exitCode: 1,
        resultStderr: ''
    })
    assert.equal(exhausted.error.managedChannelFailure, 'account_pool_empty')
    assert.equal(exhausted.error.error.retryable, false)
    assert.equal(causeOf(exhausted.error), 'account_pool_empty')
})

// The real trace is long enough that the bounded stderr attach drops its
// middle, and the cause is in the part that survives only because the tail is
// kept as well as the head (#594). Asserted rather than assumed: a marker that
// depended on an untruncated stderr would work on every fixture and on no real
// turn.
test('the marker survives the bounded stderr attach that drops the middle', async () => {
    const { error } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: `${LADDER}\n${LADDER}\n${NODE_INSPECT_TRACE}`,
        exitCode: 1,
        resultStderr: ''
    })

    assert.match(error.error.message, /\n\.\.\.\n/)
    assert.ok(!error.error.message.includes('Attempt 9 failed'))
    assert.equal(error.managedChannelFailure, 'account_pool_empty')
    assert.equal(error.error.retryable, false)
})

// The other half of the grammar: what must NOT reach the breaker. Every one of
// these ends a real turn as a real failure — they simply prove nothing about
// how many accounts the pool has, and a managed agent runs `--approval-mode
// yolo`, so the last few are text a model or a user can author.
//
// Only the marker is asserted. The diagnostic cause is a Sentry grouping key
// with a deliberately looser budget (prose anchors, so an incident still groups
// when a vendor rewords it); the marker is the one that takes a channel away
// from every user, so it is the one held to an exact literal.
test('nothing that merely resembles the real cause can mark capacity', async () => {
    for (const [name, stderr] of MANAGED_POOL_EMPTY_LOOKALIKES) {
        const { error } = await runTurn({
            stdout: LINE({ type: 'init', session_id: 'sess-1' }),
            stderr,
            exitCode: 1,
            resultStderr: ''
        })
        assert.equal(error.managedChannelFailure, undefined, name)

        const streamed = await runTurn({
            stdout:
                LINE({ type: 'init', session_id: 'sess-1' }) +
                LINE({ type: 'error', message: stderr }),
            stderr: ''
        })
        assert.equal(streamed.error.managedChannelFailure, undefined, name)
    }
})

test('the exact block reflected from tool output cannot mark capacity', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'tool_result',
                tool_id: 'tool-1',
                status: 'error',
                output: GEMINI_NODE_INSPECT_POOL_EMPTY
            }),
        stderr: GEMINI_NODE_INSPECT_POOL_EMPTY,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.managedChannelFailure, undefined)
    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), 'account_pool_empty')
})

test('the exact block in model or user message content cannot mark capacity', async () => {
    for (const role of ['assistant', 'user']) {
        const { error } = await runTurn({
            stdout:
                LINE({ type: 'init', session_id: 'sess-1' }) +
                LINE({
                    type: 'message',
                    role,
                    content: GEMINI_NODE_INSPECT_POOL_EMPTY
                }) +
                LINE({
                    type: 'result',
                    status: 'error',
                    message: '[API Error: An unknown error occurred.]'
                }),
            stderr: ''
        })

        assert.equal(error.managedChannelFailure, undefined, role)
    }
})

test('a real terminal after an exact tool echo still marks capacity', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'tool_result',
                tool_id: 'tool-1',
                status: 'error',
                output: GEMINI_NODE_INSPECT_POOL_EMPTY
            }),
        stderr: `${GEMINI_NODE_INSPECT_POOL_EMPTY}\n${GEMINI_NODE_INSPECT_POOL_EMPTY}`,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.managedChannelFailure, 'account_pool_empty')
})

test('a successful tool echo cannot hide a later real terminal', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'tool_result',
                tool_id: 'tool-1',
                status: 'success',
                output: GEMINI_NODE_INSPECT_POOL_EMPTY
            }),
        stderr: GEMINI_NODE_INSPECT_POOL_EMPTY,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.managedChannelFailure, 'account_pool_empty')
})

test('an exact tool error message reflected to stderr cannot mark capacity', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'tool_result',
                tool_id: 'tool-1',
                status: 'error',
                error: {
                    type: 'TOOL_EXECUTION_ERROR',
                    message: GEMINI_NODE_INSPECT_POOL_EMPTY
                }
            }),
        stderr: GEMINI_NODE_INSPECT_POOL_EMPTY,
        exitCode: 1,
        resultStderr: ''
    })

    assert.equal(error.managedChannelFailure, undefined)
})

test('an exact policy warning cannot mark capacity', async () => {
    const { error } = await runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-1' }) +
            LINE({
                type: 'error',
                severity: 'warning',
                message: GEMINI_NODE_INSPECT_POOL_EMPTY
            }),
        stderr: ''
    })

    assert.equal(error.managedChannelFailure, undefined)
})

// A throttle is not a poisoned session and not a stale ref: the history is
// fine, so forking it would cost the user their conversation for nothing. And
// the adapter runs the model call exactly once — `retryable` is a statement to
// the user, never a replay. A throttled turn may already have had side effects
// upstream, which is precisely why nothing here re-sends it.
test('a throttle costs neither the session nor a second model call', async () => {
    const { error, dispatches, refs } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-healthy' }),
        stderr: THROTTLED_STDERR,
        exitCode: 1,
        resultStderr: '',
        sessionRef: 'sess-healthy'
    })

    assert.equal(dispatches, 1, 'the model call was made exactly once')
    assert.deepEqual(refs, [], 'no session ref write at all')
    assert.equal(error.error.retryable, true)
    assert.doesNotMatch(error.error.message, /fresh gemini session/)
})

// The bound around what is retryable at all: an ordinary non-zero exit still
// gets the old contract. A signature that matched this would tell every user
// with a broken agent to keep trying.
test('an exit with no structured throttle is unchanged', async () => {
    const { error } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr: 'panic: runtime error: index out of range [4] with length 2',
        exitCode: 2,
        resultStderr: ''
    })

    assert.equal(error.error.retryable, false)
    assert.equal(causeOf(error), null)
})

// #661's budget, on the new cause. The message the user reads is bounded and
// redacted by the existing stderr surface; what this pins is that the throttle
// adds nothing to what gets INDEXED — the cause is a closed-taxonomy member and
// the fingerprint is that member and the version, nothing else.
test('a throttle indexes one closed word and no upstream detail', async () => {
    const { error } = await runTurn({
        stdout: LINE({ type: 'init', session_id: 'sess-1' }),
        stderr:
            `GEMINI_API_KEY=sk-d0bSECRETVALUE123456\n${THROTTLED_STDERR}\n` +
            'url: https://gw.netmind.xyz/v1beta/models/gemini-3-pro:streamGenerateContent, ' +
            'request_id: req_01HZX9QQ44, quota_id: GenerateRequestsPerMinutePerProjectPerModel',
        exitCode: 1,
        resultStderr: ''
    })

    const cause = causeOf(error)
    assert.equal(cause, 'rate_limited')
    assert.ok((chatFailureCauses as readonly string[]).includes(cause ?? ''))

    const options = buildTelemetryCaptureOptions('chat.stream.error', {
        cause,
        phase: 'stream',
        framework: 'gemini-cli',
        runtimeKind: 'sprites',
        errorCode: error.error.code,
        retryable: error.error.retryable
    })
    assert.deepEqual(options.fingerprint, [
        'chat.stream.error.v1',
        'rate_limited'
    ])
    const indexed = JSON.stringify([options.tags, options.fingerprint])
    for (const raw of [
        'sk-d0bSECRETVALUE123456',
        'netmind.xyz',
        'req_01HZX9QQ44',
        'GenerateRequestsPerMinutePerProjectPerModel',
        'Resource has been exhausted',
        'sess-1',
        'msg_1',
        'agt_1',
        'user-1'
    ])
        assert.ok(
            !indexed.includes(raw),
            `${raw} must not reach a tag or the fingerprint`
        )

    // The credential is gone from the user-facing message too — the throttle
    // path did not open a second, unredacted road to it.
    assert.ok(!error.error.message.includes('sk-d0bSECRETVALUE123456'))
})
