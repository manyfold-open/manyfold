import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { AntigravityCliAdapter } from '../src/modules/chat/adapters/antigravity-cli.adapter'
import { AGY_PLATFORM_VIEW_SCRIPT } from '../src/modules/agents/credentials/antigravity-app-dir'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// Real agy 1.2.11 captures against a local Gemini API stub (see the README
// beside them): no real key or account ever reached agy.
const DIR = join(__dirname, 'fixtures', 'antigravity-cli', '1.2.11')
const stdoutOf = (name: string): string =>
    readFileSync(join(DIR, `${name}.stdout.jsonl`), 'utf8')
const stderrOf = (name: string): string => {
    try {
        return readFileSync(join(DIR, `${name}.stderr.txt`), 'utf8')
    } catch {
        return ''
    }
}

const RESUMED = '6bce3054-1614-4b63-b9b5-9590cdfc8458'
const UNKNOWN = '11111111-2222-4333-8444-555555555555'
const WORKSPACE = '/home/sprite/.manyfold/workspaces/agt_1'

interface CapturedStream {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    dir?: string
    execHandle?: string
}

const buildSeam = (opts: {
    fixture: string
    exitCode?: number
    runtime?: 'sprites' | 'daemon' | 'k8s'
    creds?: Record<string, unknown> | null
    workspacePath?: string | null
    source?: 'platform' | 'runtime-local'
}) => {
    const streams: CapturedStream[] = []
    const refs: Array<string | null> = []
    const cleared: string[] = []
    const cursors: number[] = []
    const countScripts: string[] = []
    let aborted = 0
    const runtime = opts.runtime ?? 'sprites'
    const drivers = {
        forAgent: async () => ({
            driver: {
                stream: (req: CapturedStream) => {
                    streams.push(req)
                    return {
                        stdout: (async function* () {
                            yield stdoutOf(opts.fixture)
                        })(),
                        stderr: (async function* () {
                            const err = stderrOf(opts.fixture)
                            if (err) yield err
                        })(),
                        result: Promise.resolve({
                            exitCode: opts.exitCode ?? 0,
                            stdout: '',
                            stderr: ''
                        }),
                        abort: () => {
                            aborted += 1
                        },
                        lastDeliveredSeq: () => 7
                    }
                }
            },
            daemonId: runtime === 'daemon' ? 'dh_1' : 'dh_runner',
            creds: opts.creds === undefined ? null : opts.creds,
            runtime,
            agent: {
                id: 'agt_1',
                framework: 'antigravity-cli',
                runtime,
                runtimeId: 'art_1',
                workspacePath:
                    opts.workspacePath === undefined
                        ? WORKSPACE
                        : opts.workspacePath,
                extras: {
                    modelConfig: { source: opts.source ?? 'runtime-local' }
                }
            },
            resolvePriceScope: async () => ({
                modelProviderId: 'ump_served',
                modelProviderBuiltInId: null,
                modelProviderManagedBrand: 'antigravity'
            }),
            authContext: null
        }),
        recoveryFsForAgent: async () => ({
            agent: { workspacePath: WORKSPACE },
            fs: {
                exec: async (script: string) => {
                    countScripts.push(script)
                    return '8\n'
                }
            }
        })
    }
    const chatRepo = {
        updateFrameworkSessionRef: async (
            _sessionId: string,
            ref: string | null
        ) => {
            refs.push(ref)
        },
        clearFrameworkSessionRefIfMatches: async (
            _sessionId: string,
            ref: string
        ) => {
            cleared.push(ref)
            return true
        },
        setRuntimeSyncCursor: async (_sessionId: string, cursor: number) => {
            cursors.push(cursor)
        }
    }
    const priced: unknown[] = []
    const pricing = {
        computeCost: (input: unknown) => {
            priced.push(input)
            return { costUsd: 0.01, costSource: 'table' as const }
        }
    }
    const adapter = new AntigravityCliAdapter(
        drivers as never,
        chatRepo as never,
        pricing as never
    )
    return {
        adapter,
        streams,
        refs,
        cleared,
        priced,
        cursors,
        countScripts,
        aborted: () => aborted
    }
}

const ctx = (
    over: Partial<ApiChatAdapterContext> = {}
): ApiChatAdapterContext =>
    ({
        userId: 'usr_1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework: 'antigravity-cli',
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
        ...over
    }) as ApiChatAdapterContext

const drain = async (
    iterable: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of iterable) out.push(ev)
    return out
}

const message = {
    id: 'msg_1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

const tokensOf = (events: EmittedChatEvent[]): string =>
    events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('')

const usageOf = (events: EmittedChatEvent[]) => {
    const found = events.find(
        (e): e is Extract<EmittedChatEvent, { type: 'usage' }> =>
            e.type === 'usage'
    )
    assert.ok(found, 'a usage event')
    return found
}

const errorOf = (events: EmittedChatEvent[]) =>
    (events.find((e) => e.type === 'error') as
        | {
              error: { code: string; message: string; retryable: boolean }
              managedChannelFailure?: string
          }
        | undefined) ?? null

test('a first turn streams text, records the conversation agy minted and bills per call', async () => {
    const seam = buildSeam({ fixture: 'resume-turn-1' })
    const events = await drain(seam.adapter.sendMessage(ctx(), message))

    assert.equal(tokensOf(events), 'Hello from the stub (turn 1).\n')
    assert.deepEqual(seam.refs, [RESUMED])
    assert.equal(events.at(-1)?.type, 'done')
    const usage = usageOf(events)
    // input_tokens 800 excludes the 500 cached; stored counting them, as
    // Gemini CLI's usage is.
    assert.equal(usage.usage.inputTokens, 1300)
    assert.equal(usage.usage.cacheReadTokens, 500)
    assert.equal(usage.usage.outputTokens, 41)
    assert.equal(usage.usage.model, 'gemini-3.1-pro-preview')

    const [stream] = seam.streams
    assert.deepEqual(stream.cmd, [
        'agy',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--disable-slash-commands'
    ])
    assert.equal(stream.dir, WORKSPACE)
    assert.equal(stream.execHandle, 'msg_1')
    assert.equal(stream.env?.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
    assert.equal(stream.env?.MF_TERMINAL_ID, '')
    const line = JSON.parse(stream.stdin!.trim())
    assert.equal(line.event, 'user')
    assert.match(line.message.content, /hi/)
})

test('a resumed turn names the conversation and bills only its own calls', async () => {
    const seam = buildSeam({ fixture: 'resume-turn-2' })
    const events = await drain(
        seam.adapter.sendMessage(ctx({ frameworkSessionRef: RESUMED }), message)
    )
    assert.equal(tokensOf(events), 'Hello from the stub (turn 2).\n')
    const [stream] = seam.streams
    assert.deepEqual(stream.cmd.slice(-2), ['--conversation', RESUMED])
    assert.equal(JSON.parse(stream.stdin!.trim()).message.content, 'hi')
    // Its result line reports the whole conversation (input 1700); the call
    // this process made was 900 + 500 cached.
    const usage = usageOf(events)
    assert.equal(usage.usage.inputTokens, 1400)
    assert.equal(usage.usage.outputTokens, 41)
    assert.deepEqual(seam.refs, [], 'an unchanged ref is not rewritten')
})

test('tool steps become one call and one result per step', async () => {
    const seam = buildSeam({ fixture: 'turn-multitool' })
    const events = await drain(seam.adapter.sendMessage(ctx(), message))
    const calls = events.filter((e) => e.type === 'tool_call') as Array<{
        toolCallId: string
        toolName: string
        args: unknown
    }>
    const results = events.filter((e) => e.type === 'tool_result') as Array<{
        toolCallId: string
        result: { content: unknown; isError: boolean }
    }>
    assert.deepEqual(
        calls.map((c) => [c.toolCallId, c.toolName]),
        [
            ['agy-2', 'run_command'],
            ['agy-4', 'write_to_file'],
            ['agy-6', 'run_command']
        ]
    )
    assert.deepEqual(calls[0].args, { CommandLine: 'echo first' })
    assert.deepEqual(
        results.map((r) => r.toolCallId),
        ['agy-2', 'agy-4', 'agy-6']
    )
    assert.equal(results[0].result.content, 'first\r\n')
    assert.equal(results[0].result.isError, false)
    assert.equal(tokensOf(events), 'All 3 tool calls finished.\n')
    const usage = usageOf(events)
    assert.equal(usage.usage.inputTokens, 3000 + 1800)
    assert.equal(usage.usage.outputTokens, 115)
})

test('a provider refusal ends the turn with agy’s own verdict', async () => {
    const seam = buildSeam({ fixture: 'turn-provider-401', exitCode: 3 })
    const events = await drain(seam.adapter.sendMessage(ctx(), message))
    const err = errorOf(events)!
    assert.equal(err.error.code, 'antigravity_result_error')
    assert.match(err.error.message, /Error 401, Message: API key not valid/)
    assert.equal(err.error.retryable, false)
    assert.equal(err.managedChannelFailure, undefined)
    assert.ok(!events.some((e) => e.type === 'usage' || e.type === 'done'))
})

test('the gateway’s empty-pool 503 marks the managed channel and stays retryable', async () => {
    const seam = buildSeam({ fixture: 'turn-pool-empty-503', exitCode: 3 })
    const events = await drain(seam.adapter.sendMessage(ctx(), message))
    const err = errorOf(events)!
    assert.equal(err.error.code, 'antigravity_result_error')
    assert.equal(err.error.retryable, true)
    assert.equal(err.managedChannelFailure, 'account_pool_empty')
})

test('a conversation agy no longer has stops the turn before the model runs and clears the ref', async () => {
    const seam = buildSeam({ fixture: 'resume-unknown-conversation' })
    const events = await drain(
        seam.adapter.sendMessage(ctx({ frameworkSessionRef: UNKNOWN }), message)
    )
    assert.equal(seam.aborted(), 1)
    assert.equal(tokensOf(events), '')
    assert.deepEqual(seam.cleared, [UNKNOWN])
    assert.deepEqual(seam.refs, [], 'the fresh conversation is never recorded')
    const err = errorOf(events)!
    assert.equal(err.error.code, 'antigravity_resume_lost')
    assert.equal(err.error.retryable, true)
})

test('no sign-in on the host names its own fix', async () => {
    const seam = buildSeam({ fixture: 'turn-signed-out', exitCode: 1 })
    const err = errorOf(await drain(seam.adapter.sendMessage(ctx(), message)))!
    assert.equal(err.error.code, 'antigravity_sign_in_required')
    assert.equal(err.error.retryable, false)
})

test('an unknown model is agy’s refusal, not a crash', async () => {
    const seam = buildSeam({ fixture: 'turn-unknown-model', exitCode: 1 })
    const err = errorOf(
        await drain(
            seam.adapter.sendMessage(ctx({ model: 'not-a-model' }), message)
        )
    )!
    assert.equal(err.error.code, 'antigravity_result_error')
    assert.match(err.error.message, /invalid model selection/)
    assert.deepEqual(seam.streams[0].cmd.slice(-2), ['--model', 'not-a-model'])
})

test('a run that died without a verdict is a retryable exec failure', async () => {
    // The daemon reports a signal death as exit 0; the missing result line is
    // what says the turn did not finish.
    const seam = buildSeam({ fixture: 'turn-sigkill', exitCode: 0 })
    const err = errorOf(await drain(seam.adapter.sendMessage(ctx(), message)))!
    assert.equal(err.error.code, 'antigravity_exec_failed')
    assert.equal(err.error.retryable, true)
})

test('a platform turn runs on the platform view with the bound key and bills the served id', async () => {
    const seam = buildSeam({
        fixture: 'resume-turn-1',
        source: 'platform',
        creds: {
            googleApiKey: 'gk-marker',
            googleGeminiBaseUrl: 'https://gw.example/antigravity',
            model: null
        }
    })
    const events = await drain(
        seam.adapter.sendMessage(
            ctx({
                modelConfig: {
                    framework: 'antigravity-cli',
                    model: 'gemini-3.8-flash-high'
                }
            }),
            message
        )
    )
    const [stream] = seam.streams
    assert.deepEqual(stream.cmd.slice(0, 4), [
        'bash',
        '-c',
        AGY_PLATFORM_VIEW_SCRIPT,
        'agy'
    ])
    assert.deepEqual(stream.cmd.slice(-2), ['--model', 'gemini-3.8-flash-high'])
    assert.equal(stream.env?.GEMINI_API_KEY, 'gk-marker')
    assert.equal(
        stream.env?.GOOGLE_GEMINI_BASE_URL,
        'https://gw.example/antigravity'
    )
    assert.equal(stream.env?.MF_AGY_VIEW, 'art_1')
    assert.equal(stream.env?.GOOGLE_API_KEY, '')
    assert.equal(stream.env?.AGY_GATEWAY_URL, '')
    assert.equal(stream.env?.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
    const usage = usageOf(events)
    assert.equal(usage.usage.model, 'gemini-3.8-flash')
    assert.deepEqual(
        (seam.priced[0] as Record<string, unknown>).modelProviderManagedBrand,
        'antigravity'
    )
})

test('a platform agent with no provider bound is refused before any exec', async () => {
    const seam = buildSeam({
        fixture: 'resume-turn-1',
        source: 'platform',
        creds: null
    })
    const err = errorOf(await drain(seam.adapter.sendMessage(ctx(), message)))!
    assert.equal(err.error.code, 'antigravity_credentials_missing')
    assert.equal(seam.streams.length, 0)
})

test('an agent without a workspace is refused before any exec', async () => {
    const seam = buildSeam({ fixture: 'resume-turn-1', workspacePath: null })
    const err = errorOf(await drain(seam.adapter.sendMessage(ctx(), message)))!
    assert.equal(err.error.code, 'antigravity_workspace_missing')
    assert.equal(seam.streams.length, 0)
})

test('the user’s own machine keeps its own update policy', async () => {
    const seam = buildSeam({ fixture: 'resume-turn-1', runtime: 'daemon' })
    await drain(
        seam.adapter.sendMessage(ctx({ runtimeKind: 'daemon' }), message)
    )
    assert.equal(seam.streams[0].env?.AGY_CLI_DISABLE_AUTO_UPDATE, undefined)
    assert.equal(seam.streams[0].env?.MF_TERMINAL_ID, '')
})

test('a finished turn leaves the sync cursor at the end of the log agy wrote', async () => {
    const seam = buildSeam({ fixture: 'turn-multitool' })
    await drain(seam.adapter.sendMessage(ctx(), message))
    assert.deepEqual(seam.cursors, [8])
    assert.equal(seam.countScripts.length, 1)
    assert.match(
        seam.countScripts[0],
        /brain\/'4a0dbd6a-267c-442d-a678-f6f33270fa3c'\/\.system_generated\/logs\/transcript_full\.jsonl/
    )
})

test('a failed turn counts its log too, but a lost conversation or stream does not', async () => {
    const refused = buildSeam({ fixture: 'turn-provider-401', exitCode: 3 })
    await drain(refused.adapter.sendMessage(ctx(), message))
    assert.deepEqual(refused.cursors, [8])

    const lost = buildSeam({ fixture: 'resume-unknown-conversation' })
    await drain(
        lost.adapter.sendMessage(ctx({ frameworkSessionRef: UNKNOWN }), message)
    )
    assert.deepEqual(lost.cursors, [])
})

// Measured through a real daemon [2026-09-26]: a command that could not start
// ends its tool step ERROR, with no DONE after it.
test('a tool step that ends in error still gets its result, marked as the error', async () => {
    const seam = buildSeam({ fixture: 'turn-tool-error' })
    const events = await drain(seam.adapter.sendMessage(ctx(), message))
    const [result] = events.filter((e) => e.type === 'tool_result') as Array<{
        toolCallId: string
        result: { isError: boolean; details: unknown }
    }>
    assert.ok(result, 'a tool result')
    assert.equal(result.toolCallId, 'agy-8')
    assert.equal(result.result.isError, true)
    assert.deepEqual(result.result.details, {
        type: 'TOOL_ERROR',
        message: '/tmp/ws: no such directory'
    })
    assert.equal(tokensOf(events), 'All 1 tool calls finished.\n')
    const usage = usageOf(events)
    assert.equal(usage.usage.inputTokens, 2500)
    assert.equal(usage.usage.cacheReadTokens, 1000)
    assert.equal(usage.usage.outputTokens, 61)
})
