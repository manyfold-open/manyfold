import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// Seen on production [2026-08-10] (#729): a Gemini chat completed turns
// normally until 12:20:56Z, then failed at 12:28:52Z, 13:20:51Z and 15:27:23Z
// with identical output — "gemini exited 42 / Error resuming session: Invalid
// session identifier". The CLI resolves `--resume <uuid>` against the CURRENT
// project's resumable-session list and throws out of SessionSelector before
// emitting `init` when the target cannot be resolved. So the turn dies with
// FATAL_INPUT_ERROR (42), no new session_id ever lands to overwrite
// chat_sessions.framework_session_ref, and — because the gemini hot path
// deliberately loads no durable history into the model — the next send resumes
// the same unusable target forever. Retrying could not help: the input was
// identical.

const PROMPT = 'hello?'
const STALE_REF = '8f3d5f0e-2c7a-4c1f-9a58-1b2c3d4e5f60'
const CHATS_DIR = '/home/sprite/.gemini/tmp/9c1f0a/chats'

const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

// Verbatim shapes from gemini-cli's SessionError (packages/cli/src/utils/
// sessionUtils.ts): the identifier reason quotes the opaque uuid AND names the
// runtime-local directory it searched, which is exactly what must not reach a
// user-visible message.
const INVALID_IDENTIFIER_STDERR =
    `Error resuming session: Invalid session identifier "${STALE_REF}".\n` +
    `  Searched for sessions in ${CHATS_DIR}.\n` +
    '  Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.\n'

const NO_SESSIONS_STDERR =
    'Error resuming session: No previous sessions found for this project.\n'

// Other real FATAL_INPUT_ERROR exits from the same CLI. Nothing about them says
// the stored ref is unusable, so clearing on the exit code alone would fork a
// healthy session on a flag typo.
const NO_INPUT_STDERR =
    'No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.\n'
const PIPED_INTERACTIVE_STDERR =
    'Error: The --prompt-interactive flag cannot be used when input is piped from stdin.\n'

// Per-file corrupt, unreadable, or non-resumable entries are filtered out and
// can lead to either coded error above. Unexpected resolver failures still use
// the same prefix but must not clear the ref. Directory EACCES is one realistic
// example: the CLI wraps it as "Failed to find session" instead.
const UNEXPECTED_RESOLVER_STDERR =
    `Error resuming session: Failed to find session "${STALE_REF}": ` +
    `EACCES: permission denied, scandir '${CHATS_DIR}'\n`

const AUTH_STDERR =
    '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"API key not valid. Please pass a valid API key."}}\n'

// Synthetic: the resolver throws before any request is made, so this overlap
// has not been observed. It is pinned anyway because both self-heals write the
// same column, and the poisoned-history fork already resets it unconditionally
// — letting the stale-resume path also fire would compare against a ref the
// fork just nulled and report the wrong reason to the user.
const BOTH_REASONS_STDERR =
    INVALID_IDENTIFIER_STDERR +
    '{"error":{"code":400,"message":"Unable to submit request because Function call is missing a thought_signature in functionCall parts."}}\n'

const handleFor = (opts: {
    stdout: string
    stderr: string
    exitCode?: number
}) => ({
    stdout: (async function* () {
        yield opts.stdout
    })(),
    stderr: (async function* () {
        yield opts.stderr
    })(),
    result: Promise.resolve({
        exitCode: opts.exitCode ?? 0,
        stdout: '',
        // The daemon transport always reports '' here, so the drained tail is
        // the only source a runner-carried turn has.
        stderr: ''
    }),
    abort: () => {}
})

type Turn = {
    stdout: string
    stderr: string
    exitCode?: number
    // Runs when the exec starts, i.e. after this turn has already read the ref
    // it resumes — the window another writer of the same row races through.
    onExec?: () => void
}

// One fake session row plus the exec driver, so a test can run turn 2 against
// whatever turn 1 left behind — the same read chat.service does when it loads
// the session for the next user message.
const buildHarness = (
    initialRef: string | null,
    opts: { clearError?: Error } = {}
) => {
    const commands: string[][] = []
    const timeline: string[] = []
    const telemetryEvents: Array<{
        name: string
        attrs: Record<string, unknown>
    }> = []
    let ref = initialRef
    const queue: Turn[] = []

    const nextHandle = () => {
        const turn = queue.shift()
        assert.ok(turn, 'the test queued a turn for this exec')
        turn.onExec?.()
        return handleFor(turn)
    }
    const driver = {
        stream: (opts: { cmd: string[] }) => {
            commands.push(opts.cmd)
            return nextHandle()
        },
        resumeStream: () => nextHandle()
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
    const chatRepo = {
        updateFrameworkSessionRef: async (
            _sessionId: string,
            next: string | null
        ) => {
            timeline.push(`update:${next ?? 'null'}`)
            ref = next
        },
        clearFrameworkSessionRefIfMatches: async (
            _sessionId: string,
            expected: string
        ) => {
            timeline.push(`cas:${expected}`)
            if (opts.clearError) throw opts.clearError
            if (ref !== expected) return false
            ref = null
            return true
        }
    }
    const adapter = new GeminiCliAdapter(
        drivers as never,
        chatRepo as never,
        { priceFor: () => null } as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                timeoutMs: 1000,
                keepAliveMs: 1000,
                livenessTimeoutMs: 1000
            })
        } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                telemetryEvents.push({ name, attrs })
            }
        } as never
    )

    const context = () =>
        ({
            userId: 'user-1',
            agentId: 'agt_1',
            sessionId: 'cts_1',
            messageId: 'msg_1',
            model: null,
            modelOverride: null,
            modelConfig: null,
            // Read fresh per turn, exactly as chat.service does for both a new
            // send and a daemon resume attachment.
            frameworkSessionRef: ref,
            history: []
        }) as unknown as ApiChatAdapterContext

    const collect = async (
        events: AsyncIterable<EmittedChatEvent>
    ): Promise<EmittedChatEvent[]> => {
        const collected: EmittedChatEvent[] = []
        for await (const ev of events) {
            if (ev.type === 'error') timeline.push('yield:error')
            collected.push(ev)
        }
        return collected
    }

    const runTurn = (turn: Turn): Promise<EmittedChatEvent[]> => {
        queue.push(turn)
        const userMessage = {
            id: 'msg_0',
            role: 'user',
            contentBlocks: [{ type: 'text', text: PROMPT }]
        } as unknown as ChatMessage
        return collect(adapter.sendMessage(context(), userMessage))
    }

    const runResumeTurn = (turn: Turn): Promise<EmittedChatEvent[]> => {
        queue.push(turn)
        const ctx = {
            ...context(),
            daemonExecRef: 'msg_1',
            daemonId: 'dmn_1',
            fromSeq: 0
        } as ApiChatResumeContext
        return collect(adapter.resumeMessage(ctx))
    }

    return {
        runTurn,
        runResumeTurn,
        commands,
        timeline,
        telemetryEvents,
        storedRef: () => ref,
        setStoredRef: (next: string | null) => {
            ref = next
        }
    }
}

const staleTurn = (stderr: string): Turn => ({
    // Nothing on stdout at all: the CLI exits before it can emit `init`, which
    // is why no fresh session_id is ever available to overwrite the stale ref.
    stdout: '',
    stderr,
    exitCode: 42
})

const errorOf = (events: EmittedChatEvent[]) => {
    const error = events.find((e) => e.type === 'error')
    assert.ok(error && error.type === 'error', 'the turn reported an error')
    return error.error
}

test('an unresolvable resume target clears the attempted ref before the terminal error', async () => {
    const h = buildHarness(STALE_REF)

    const events = await h.runTurn(staleTurn(INVALID_IDENTIFIER_STDERR))

    assert.equal(h.storedRef(), null, 'the stale ref is gone')
    // Compare-and-clear, not a blind write: the ref this turn actually resumed
    // is the value the clear is conditioned on.
    assert.deepEqual(h.timeline, [`cas:${STALE_REF}`, 'yield:error'])
    const error = errorOf(events)
    assert.equal(error.code, 'gemini_exec_failed')
    assert.equal(error.retryable, true)
    assert.deepEqual(h.telemetryEvents, [
        {
            name: 'chat.gemini.stale_resume_recovery',
            attrs: { outcome: 'cleared' }
        }
    ])
})

test('"no previous sessions for this project" takes the same recovery path', async () => {
    const h = buildHarness(STALE_REF)

    const events = await h.runTurn(staleTurn(NO_SESSIONS_STDERR))

    assert.equal(h.storedRef(), null)
    assert.deepEqual(h.timeline, [`cas:${STALE_REF}`, 'yield:error'])
    const error = errorOf(events)
    assert.equal(error.retryable, true)
    assert.match(error.message, /fresh gemini session/)
    assert.deepEqual(h.telemetryEvents.at(-1)?.attrs, {
        outcome: 'cleared'
    })
})

// The failing turn stays a failure the user can see and act on — it is not
// swallowed, and it is not auto-replayed (a silent replay would re-run whatever
// tool calls the prompt triggers).
test('the user gets one visible retryable hint that leaks neither the ref nor a local path', async () => {
    const h = buildHarness(STALE_REF)

    const events = await h.runTurn(staleTurn(INVALID_IDENTIFIER_STDERR))

    const errors = events.filter((e) => e.type === 'error')
    assert.equal(errors.length, 1, 'exactly one error event')
    assert.equal(h.commands.length, 1, 'the prompt was not replayed')
    const { message } = errorOf(events)
    assert.match(message, /gemini exited 42/)
    assert.match(message, /a retry starts a fresh gemini session/)
    assert.ok(!message.includes(STALE_REF), 'the opaque ref is not surfaced')
    assert.ok(!message.includes(CHATS_DIR), 'no runtime-local path is surfaced')
    assert.doesNotMatch(message, /Invalid session identifier/)
    assert.doesNotMatch(message, /Searched for sessions/)
})

test('the next turn resumes nothing and persists the fresh session id', async () => {
    const h = buildHarness(STALE_REF)

    await h.runTurn(staleTurn(INVALID_IDENTIFIER_STDERR))
    const events = await h.runTurn({
        stdout:
            LINE({ type: 'init', session_id: 'sess-fresh' }) +
            LINE({ type: 'message', role: 'assistant', content: 'hi' }) +
            LINE({ type: 'result', status: 'success' }),
        stderr: ''
    })

    assert.equal(
        h.commands[0].includes('--resume') && h.commands[0].includes(STALE_REF),
        true,
        'the first turn did resume the stale ref'
    )
    assert.ok(
        !h.commands[1].includes('--resume'),
        'the recovered turn carries no --resume'
    )
    assert.equal(h.storedRef(), 'sess-fresh', 'the new session id is stored')
    assert.ok(!events.some((e) => e.type === 'error'), 'the turn succeeded')
    assert.equal(events.at(-1)?.type, 'done')
})

// Losing the ref costs the whole conversational context on the gemini side, so
// it must happen for this one failure and nothing else.
for (const [name, turn, ref] of [
    ['a turn that carried no ref at all', staleTurn(NO_SESSIONS_STDERR), null],
    ['another exit 42 (no stdin input)', staleTurn(NO_INPUT_STDERR), STALE_REF],
    [
        'another exit 42 (piped --prompt-interactive)',
        staleTurn(PIPED_INTERACTIVE_STDERR),
        STALE_REF
    ],
    [
        'an exit 42 whose resume failed for another reason',
        staleTurn(UNEXPECTED_RESOLVER_STDERR),
        STALE_REF
    ],
    [
        'the same stderr under a different exit code',
        { stdout: '', stderr: INVALID_IDENTIFIER_STDERR, exitCode: 1 },
        STALE_REF
    ],
    [
        'an auth rejection',
        { stdout: '', stderr: AUTH_STDERR, exitCode: 1 },
        STALE_REF
    ],
    [
        'a provider rejection reported on a result line',
        {
            stdout:
                LINE({ type: 'init', session_id: STALE_REF }) +
                LINE({
                    type: 'result',
                    status: 'error',
                    message: '[API Error: An unknown error occurred.]'
                }),
            stderr: AUTH_STDERR
        },
        STALE_REF
    ]
] as [string, Turn, string | null][]) {
    test(`${name} leaves the session ref alone`, async () => {
        const h = buildHarness(ref)

        const events = await h.runTurn(turn)

        assert.equal(h.storedRef(), ref, 'the stored ref is untouched')
        assert.ok(
            !h.timeline.some((entry) => entry.startsWith('cas:')),
            'no compare-and-clear was attempted'
        )
        assert.ok(
            !h.timeline.includes('update:null'),
            'no unconditional reset either'
        )
        const error = errorOf(events)
        assert.doesNotMatch(error.message, /fresh gemini session/)
        assert.deepEqual(h.telemetryEvents, [])
    })
}

test('a stderr that also names the poisoned-history defect keeps that fork', async () => {
    const h = buildHarness(STALE_REF)

    const events = await h.runTurn(staleTurn(BOTH_REASONS_STDERR))

    assert.deepEqual(h.timeline, ['update:null', 'yield:error'])
    assert.equal(h.storedRef(), null, 'the fork reset the ref, not the CAS')
    const error = errorOf(events)
    assert.equal(error.retryable, true)
    assert.match(error.message, /thought signatures/)
    assert.doesNotMatch(error.message, /moved this chat to a newer/)
    assert.doesNotMatch(error.message, /its reference was dropped/)
    assert.deepEqual(h.telemetryEvents, [])
})

// The clear is decided after the exec ends, so it races every other writer of
// this row: a concurrent turn's `init`, an edit fork, an adoption. A stale
// failure that wins that race would throw away a session that still works.
test('a ref another writer has already replaced survives the stale failure', async () => {
    const h = buildHarness(STALE_REF)

    const events = await h.runTurn({
        ...staleTurn(INVALID_IDENTIFIER_STDERR),
        onExec: () => h.setStoredRef('sess-newer')
    })

    assert.equal(h.storedRef(), 'sess-newer', 'the newer ref is still there')
    assert.deepEqual(h.timeline, [`cas:${STALE_REF}`, 'yield:error'])
    const error = errorOf(events)
    // Still worth retrying — the next turn resumes the newer session — but the
    // hint must not claim a reset that did not happen.
    assert.equal(error.retryable, true)
    assert.match(error.message, /stored session state has already changed/)
    assert.doesNotMatch(error.message, /its reference was dropped/)
    assert.ok(!error.message.includes(STALE_REF))
    assert.deepEqual(h.telemetryEvents.at(-1)?.attrs, {
        outcome: 'state_changed'
    })
})

test('a ref another stale turn already cleared uses the same truthful state-changed hint', async () => {
    const h = buildHarness(STALE_REF)

    const events = await h.runTurn({
        ...staleTurn(INVALID_IDENTIFIER_STDERR),
        onExec: () => h.setStoredRef(null)
    })

    assert.equal(h.storedRef(), null)
    assert.deepEqual(h.timeline, [`cas:${STALE_REF}`, 'yield:error'])
    const error = errorOf(events)
    assert.equal(error.retryable, true)
    assert.match(error.message, /stored session state has already changed/)
    assert.doesNotMatch(error.message, /newer gemini session/)
    assert.doesNotMatch(error.message, /its reference was dropped/)
    assert.deepEqual(h.telemetryEvents.at(-1)?.attrs, {
        outcome: 'state_changed'
    })
})

test('a resumed stale failure compares the ref named by the old exec, not the current row', async () => {
    const h = buildHarness('sess-newer')

    const events = await h.runResumeTurn(staleTurn(INVALID_IDENTIFIER_STDERR))

    assert.equal(h.storedRef(), 'sess-newer')
    assert.deepEqual(h.timeline, [`cas:${STALE_REF}`, 'yield:error'])
    const error = errorOf(events)
    assert.equal(error.retryable, true)
    assert.match(error.message, /stored session state has already changed/)
    assert.deepEqual(h.telemetryEvents.at(-1), {
        name: 'chat.gemini.stale_resume_recovery',
        attrs: { outcome: 'state_changed' }
    })
})

test('a resumed no-sessions failure preserves current state when the old ref is unavailable', async () => {
    const h = buildHarness('sess-newer')

    const events = await h.runResumeTurn(staleTurn(NO_SESSIONS_STDERR))

    assert.equal(h.storedRef(), 'sess-newer')
    assert.deepEqual(h.timeline, ['yield:error'])
    const error = errorOf(events)
    assert.equal(error.retryable, true)
    assert.match(error.message, /reference could not be safely dropped/)
    assert.deepEqual(h.telemetryEvents.at(-1)?.attrs, {
        outcome: 'clear_failed'
    })
})

test('the ref is kept when the compare-and-clear itself fails', async () => {
    const h = buildHarness(STALE_REF, {
        clearError: new Error('connection terminated')
    })

    const events = await h.runTurn(staleTurn(NO_SESSIONS_STDERR))

    // The write failed, so the turn must not promise a reset it did not get.
    assert.equal(h.storedRef(), STALE_REF)
    assert.deepEqual(h.timeline, [`cas:${STALE_REF}`, 'yield:error'])
    const error = errorOf(events)
    assert.equal(error.retryable, true)
    assert.match(error.message, /reference could not be safely dropped/)
    assert.doesNotMatch(error.message, /its reference was dropped/)
    assert.doesNotMatch(
        error.message,
        /stored session state has already changed/
    )
    assert.ok(!error.message.includes(STALE_REF))
    assert.deepEqual(h.telemetryEvents.at(-1)?.attrs, {
        outcome: 'clear_failed'
    })
})
