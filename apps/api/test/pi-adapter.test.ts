import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PiAdapter } from '../src/modules/chat/adapters/pi.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// The stdout fixtures are real `pi --mode json` output (pi 0.85.1, macOS dev
// [2026-09-10]) against a local anthropic-messages stub: one turn that streams
// text, calls `bash`, and answers; the same session resumed with
// `--session-id`; and a provider 401. The stub is what makes them safe to
// commit — no real key ever reached pi.
const fixture = (name: string): string =>
    readFileSync(join(__dirname, 'fixtures', 'pi', name), 'utf8')

const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

interface CapturedStream {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    dir?: string
}

const handleFor = (
    stdout: string,
    result: { exitCode: number; stderr: string } = {
        exitCode: 0,
        stderr: ''
    },
    stderr = ''
) => ({
    stdout: (async function* () {
        yield stdout
    })(),
    stderr: (async function* () {
        if (stderr) yield stderr
    })(),
    result: Promise.resolve({ ...result, stdout: '' }),
    abort: () => {},
    lastDeliveredSeq: () => 7
})

// The fixtures were captured under this id; a mint test replays them by
// minting the same one, so the header pi wrote matches what "we" minted.
const FIXTURE_SESSION_ID = '11111111-2222-4333-8444-555555555555'

class FixedIdPiAdapter extends PiAdapter {
    protected override mintSessionId(): string {
        return FIXTURE_SESSION_ID
    }
}

const tokensOf = (events: EmittedChatEvent[]): string =>
    events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('')

const buildSeam = (opts: {
    stdout: string
    runtime?: 'sprites' | 'daemon' | 'k8s'
    creds?: Record<string, unknown> | null
    exitCode?: number
    stderr?: string
    workspacePath?: string | null
}) => {
    const streams: CapturedStream[] = []
    const runnerStreams: CapturedStream[] = []
    const refs: Array<string | null> = []
    const runtime = opts.runtime ?? 'sprites'
    const stream = (req: CapturedStream) => {
        streams.push(req)
        return handleFor(
            opts.stdout,
            { exitCode: opts.exitCode ?? 0, stderr: '' },
            opts.stderr ?? ''
        )
    }
    const drivers = {
        forAgent: async () => ({
            driver: { stream },
            creds:
                opts.creds === undefined
                    ? { apiKey: 'sk-marker', provider: 'anthropic' }
                    : opts.creds,
            runtime,
            agent: {
                id: 'agt_1',
                daemonId: runtime === 'daemon' ? 'dh_1' : null,
                workspacePath:
                    opts.workspacePath === undefined
                        ? '/home/sprite/.manyfold/workspaces/agt_1'
                        : opts.workspacePath,
                extras: {}
            },
            baseEnv: undefined,
            authContext: null
        }),
        daemonDriverFor: () => ({
            stream: (req: CapturedStream) => {
                runnerStreams.push(req)
                return handleFor(opts.stdout)
            },
            resumeStream: () => handleFor(opts.stdout)
        })
    }
    const chatRepo = {
        updateFrameworkSessionRef: async (
            _sessionId: string,
            ref: string | null
        ) => {
            refs.push(ref)
        }
    }
    const pricing = {
        computeCost: () => ({ costUsd: 0.5, costSource: 'catalog' })
    }
    const adminSettings = {
        getCachedChatExecTimeoutMs: async () => ({
            timeoutMs: 1000,
            keepAliveMs: 1000,
            livenessTimeoutMs: 1000
        })
    }
    const adapter = new FixedIdPiAdapter(
        drivers as never,
        chatRepo as never,
        pricing as never,
        adminSettings as never
    )
    return { adapter, streams, runnerStreams, refs }
}

const ctx = (
    overrides: Partial<ApiChatAdapterContext> = {}
): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'pi',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        hermesPermissionMode: null,
        openclawPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        ...overrides
    }) as unknown as ApiChatAdapterContext

const userMessage = (text: string) =>
    ({
        id: 'cmsg_user',
        role: 'user',
        contentBlocks: [{ type: 'text', text }]
    }) as never

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

const errorOf = (events: EmittedChatEvent[]) =>
    events.find((e) => e.type === 'error')?.error ?? null

test('a sprite turn passes the prompt on stdin, mints and persists the session id before exec, and injects the vendor key', async () => {
    const { adapter, streams, refs } = buildSeam({
        stdout: fixture('turn-tool-call.stdout.jsonl')
    })
    await drain(adapter.sendMessage(ctx(), userMessage('list the files')))

    assert.equal(streams.length, 1)
    const [stream] = streams
    assert.equal(stream.cmd[0], 'pi')
    assert.deepEqual(stream.cmd.slice(1, 4), [
        '--mode',
        'json',
        '--no-extensions'
    ])
    const sid = stream.cmd[stream.cmd.indexOf('--session-id') + 1]
    assert.equal(sid, FIXTURE_SESSION_ID)
    // Persisted before the exec was even dispatched, as the very same id; the
    // header pi echoed matched it, so nothing was written a second time.
    assert.deepEqual(refs, [sid])
    assert.equal(
        stream.cmd[stream.cmd.indexOf('--model') + 1],
        'anthropic/claude-sonnet-4-6',
        'a bare default model is qualified with the credential provider'
    )
    assert.ok(stream.cmd.includes('--approve'), 'managed workspace is trusted')
    assert.equal(stream.stdin, 'list the files')
    assert.ok(!stream.cmd.includes('--'), 'no positional prompt on sprites')
    assert.equal(stream.env?.ANTHROPIC_API_KEY, 'sk-marker')
    assert.equal(stream.env?.PI_OFFLINE, '1')
    assert.equal(stream.dir, '/home/sprite/.manyfold/workspaces/agt_1')
})

test('the real tool-call turn streams text, one tool call/result pair, summed usage and done', async () => {
    const { adapter } = buildSeam({
        stdout: fixture('turn-tool-call.stdout.jsonl')
    })
    const events = await drain(
        adapter.sendMessage(ctx(), userMessage('list the files'))
    )

    assert.equal(
        tokensOf(events),
        'Let me list the files.Done: there are two files here.',
        'deltas are streamed once and message_end adds nothing already sent'
    )
    const calls = events.filter((e) => e.type === 'tool_call')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
        type: 'tool_call',
        toolCallId: 'toolu_stub_01',
        toolName: 'bash',
        args: { command: 'ls' }
    })
    const results = events.filter((e) => e.type === 'tool_result')
    assert.equal(results.length, 1)
    assert.equal(
        (results[0] as { toolCallId: string }).toolCallId,
        'toolu_stub_01'
    )
    const usage = events.find((e) => e.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    // Two assistant messages (120+150 in, 17+9 out) summed, priced once.
    assert.equal(usage.usage.inputTokens, 270)
    assert.equal(usage.usage.outputTokens, 26)
    assert.equal(usage.usage.cacheReadTokens, 6)
    assert.equal(usage.usage.cacheCreationTokens, 4)
    assert.equal(usage.usage.model, 'claude-sonnet-4-6')
    assert.equal(usage.usage.costUsd, 0.5)
    assert.equal(events.at(-1)?.type, 'done')
    const raw = events.filter((e) => e.type === 'raw_source')
    assert.equal(raw.length, 30, 'every stdout line is kept as a raw source')
    assert.equal(
        (raw[0] as { source: { sourceRef: string } }).source.sourceRef,
        '11111111-2222-4333-8444-555555555555'
    )
    assert.ok(
        raw.every(
            (e) =>
                (e as { source: { parserName: string } }).source.parserName ===
                'pi-mode-json'
        )
    )
    assert.equal((raw.at(-1) as { runnerSeq?: number }).runnerSeq, 7)
})

test('an existing ref is resumed with the same argv shape and not re-persisted', async () => {
    const { adapter, streams, refs } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl')
    })
    const events = await drain(
        adapter.sendMessage(
            ctx({
                frameworkSessionRef: '11111111-2222-4333-8444-555555555555',
                history: [userMessage('older') as never]
            }),
            userMessage('do you remember?')
        )
    )
    const [stream] = streams
    assert.equal(
        stream.cmd[stream.cmd.indexOf('--session-id') + 1],
        '11111111-2222-4333-8444-555555555555'
    )
    assert.equal(stream.stdin, 'do you remember?', 'no transcript replay')
    assert.deepEqual(refs, [], 'header id matched the ref, nothing rewritten')
    assert.equal(tokensOf(events), 'Resumed reply: yes, I remember.')
})

test('a forked session (no ref) carries the prior transcript in the prompt', async () => {
    const { adapter, streams } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl')
    })
    await drain(
        adapter.sendMessage(
            ctx({
                history: [
                    {
                        id: 'cmsg_a',
                        role: 'user',
                        contentBlocks: [{ type: 'text', text: 'first ask' }]
                    } as never,
                    {
                        id: 'cmsg_b',
                        role: 'assistant',
                        contentBlocks: [{ type: 'text', text: 'first answer' }]
                    } as never
                ]
            }),
            userMessage('edited follow-up')
        )
    )
    const stdin = streams[0].stdin ?? ''
    assert.match(stdin, /fresh Pi runtime session/)
    assert.match(stdin, /<previous_transcript>[\s\S]*first answer/)
    assert.match(stdin, /<latest_user_message>\nedited follow-up/)
})

test('a daemon turn gets the prompt as a positional after `--` and empty stdin', async () => {
    const { adapter, streams } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl'),
        runtime: 'daemon',
        workspacePath: '/Users/me/code/repo'
    })
    await drain(
        adapter.sendMessage(
            ctx({ runtimeKind: 'daemon', frameworkSessionRef: 'ref-1' }),
            userMessage('-n dash first')
        )
    )
    const [stream] = streams
    assert.deepEqual(stream.cmd.slice(-2), ['--', '-n dash first'])
    assert.equal(stream.stdin, '')
    assert.ok(
        !stream.cmd.includes('--approve'),
        'a custom workspace is the user’s own repo, never auto-trusted'
    )
})

test('a daemon agent without a credential row runs on pi’s own login', async () => {
    const { adapter, streams } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl'),
        runtime: 'daemon',
        creds: null
    })
    const events = await drain(
        adapter.sendMessage(
            ctx({
                runtimeKind: 'daemon',
                frameworkSessionRef: 'ref-1',
                model: 'sonnet'
            }),
            userMessage('hi')
        )
    )
    assert.equal(errorOf(events), null)
    const [stream] = streams
    assert.deepEqual(stream.env, { PI_OFFLINE: '1' }, 'no key to inject')
    assert.equal(
        stream.cmd[stream.cmd.indexOf('--model') + 1],
        'sonnet',
        'no provider to qualify with: the model passes through'
    )
})

test('a sandbox agent without a credential row is refused before any exec', async () => {
    const { adapter, streams } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl'),
        creds: null
    })
    const events = await drain(adapter.sendMessage(ctx(), userMessage('hi')))
    assert.equal(streams.length, 0)
    assert.equal(errorOf(events)?.code, 'pi_credentials_missing')
    assert.equal(errorOf(events)?.retryable, false)
})

test('a model naming another vendor than the key is refused before any exec', async () => {
    const { adapter, streams } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl')
    })
    const events = await drain(
        adapter.sendMessage(
            ctx({ modelOverride: 'openai/gpt-5.5' }),
            userMessage('hi')
        )
    )
    assert.equal(streams.length, 0)
    assert.equal(errorOf(events)?.code, 'pi_model_provider_mismatch')
    assert.match(errorOf(events)?.message ?? '', /openai.*anthropic/)
})

test('a daemon turn with a gateway base URL is refused before any exec', async () => {
    const { adapter, streams } = buildSeam({
        stdout: fixture('turn-resumed.stdout.jsonl'),
        runtime: 'daemon',
        creds: {
            apiKey: 'sk-marker',
            provider: 'anthropic',
            baseUrl: 'https://gateway.example/v1'
        }
    })
    const events = await drain(
        adapter.sendMessage(ctx({ runtimeKind: 'daemon' }), userMessage('hi'))
    )
    assert.equal(streams.length, 0)
    assert.equal(errorOf(events)?.code, 'pi_base_url_unsupported')
})

test('a provider 401 (exit 0, stopReason error) is a pi_result_error, not a silent empty reply', async () => {
    const { adapter, refs } = buildSeam({
        stdout: fixture('turn-provider-401.stdout.jsonl')
    })
    const events = await drain(adapter.sendMessage(ctx(), userMessage('hello')))
    const error = errorOf(events)
    assert.equal(error?.code, 'pi_result_error')
    assert.match(error?.message ?? '', /^401 /)
    assert.equal(error?.retryable, false)
    assert.ok(!events.some((e) => e.type === 'done'))
    assert.ok(
        !events.some((e) => e.type === 'usage'),
        'zero usage is not reported'
    )
    assert.equal(
        refs.length,
        1,
        'the minted ref stays: a 401 is not a session defect'
    )
})

test('a non-zero exit surfaces stderr and clears the ref only when pi says the session cwd is gone', async () => {
    const gone = buildSeam({
        stdout: '',
        exitCode: 1,
        stderr: 'Stored session working directory does not exist: /home/sprite/old\nSession file: /home/sprite/.pi/agent/sessions/x/y.jsonl\n'
    })
    const goneEvents = await drain(
        gone.adapter.sendMessage(
            ctx({ frameworkSessionRef: 'ref-1' }),
            userMessage('hi')
        )
    )
    assert.equal(errorOf(goneEvents)?.code, 'pi_exec_failed')
    assert.match(
        errorOf(goneEvents)?.message ?? '',
        /pi exited 1: Stored session/
    )
    assert.deepEqual(
        gone.refs,
        [null],
        'ref cleared for a fresh session next turn'
    )

    const other = buildSeam({
        stdout: LINE({ type: 'session', version: 3, id: 'ref-1' }),
        exitCode: 1,
        stderr: 'No API key found for anthropic.\n'
    })
    const otherEvents = await drain(
        other.adapter.sendMessage(
            ctx({ frameworkSessionRef: 'ref-1' }),
            userMessage('hi')
        )
    )
    assert.match(errorOf(otherEvents)?.message ?? '', /No API key found/)
    assert.deepEqual(other.refs, [], 'any other failure keeps the ref')
})

test('message_end tops up text a provider never streamed as deltas', async () => {
    const stdout =
        LINE({ type: 'session', version: 3, id: 'ref-1', cwd: '/w' }) +
        LINE({
            type: 'message_start',
            message: { role: 'assistant', content: [] }
        }) +
        LINE({
            type: 'message_end',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'whole answer at once' }],
                model: 'claude-opus-4-7',
                stopReason: 'stop',
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
            }
        })
    const { adapter } = buildSeam({ stdout })
    const events = await drain(
        adapter.sendMessage(
            ctx({ frameworkSessionRef: 'ref-1' }),
            userMessage('hi')
        )
    )
    assert.deepEqual(
        events.filter((e) => e.type === 'token'),
        [{ type: 'token', text: 'whole answer at once' }]
    )
    assert.equal(
        (events.find((e) => e.type === 'usage') as { usage: { model: string } })
            .usage.model,
        'claude-opus-4-7'
    )
})

test('thinking deltas are forwarded as thinking', async () => {
    const stdout =
        LINE({ type: 'session', version: 3, id: 'ref-1', cwd: '/w' }) +
        LINE({
            type: 'message_update',
            usage: {},
            assistantMessageEvent: {
                type: 'thinking_delta',
                contentIndex: 0,
                delta: 'pondering'
            }
        }) +
        LINE({
            type: 'message_update',
            usage: {},
            assistantMessageEvent: {
                type: 'text_delta',
                contentIndex: 1,
                delta: 'ok'
            }
        })
    const { adapter } = buildSeam({ stdout })
    const events = await drain(
        adapter.sendMessage(
            ctx({ frameworkSessionRef: 'ref-1' }),
            userMessage('hi')
        )
    )
    assert.deepEqual(
        events.find((e) => e.type === 'thinking'),
        {
            type: 'thinking',
            text: 'pondering'
        }
    )
    assert.deepEqual(
        events.find((e) => e.type === 'token'),
        {
            type: 'token',
            text: 'ok'
        }
    )
})

test('a pi resume replays through the same parser, from the cursor, on the reporting daemon', async () => {
    const resumes: Array<{ daemonId: string; refId: string; fromSeq: number }> =
        []
    const drivers = {
        daemonDriverFor: (daemonId: string) => ({
            stream: () => handleFor(''),
            resumeStream: (r: { refId: string; fromSeq: number }) => {
                resumes.push({ daemonId, ...r })
                return handleFor(fixture('turn-resumed.stdout.jsonl'))
            }
        })
    }
    const adapter = new PiAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        {
            getCachedChatExecTimeoutMs: async () => ({
                timeoutMs: 1000,
                keepAliveMs: 1000,
                livenessTimeoutMs: 1000
            })
        } as never
    )
    const events = await drain(
        adapter.resumeMessage(
            ctx({
                frameworkSessionRef: '11111111-2222-4333-8444-555555555555',
                daemonId: 'dh_runner',
                daemonExecRef: 'msg_1',
                fromSeq: 12
            } as never) as never
        )
    )
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].daemonId, 'dh_runner')
    assert.equal(resumes[0].refId, 'msg_1')
    assert.equal(resumes[0].fromSeq, 12)
    assert.equal(tokensOf(events), 'Resumed reply: yes, I remember.')
    assert.equal(events.at(-1)?.type, 'done')
})
