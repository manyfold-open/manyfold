import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    recoverTurnFromGeminiSession,
    geminiSessionLocateScript,
    type GeminiTurnVerdict
} from '../src/modules/chat/recovery/turn-gemini-session-recovery'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'

// gemini-cli 0.45.2 writes an append-only JSONL: a metadata line, `{$set:{...}}`
// patches (incl. a bulk `$set.messages` for the session_context), and full
// message snapshots `{id,type,content,...}` where the SAME id is re-appended as
// it gains tokens/toolCalls (last record wins). These tests pin the last-wins
// reconstruction, the prompt anchor, the usage-tokens terminal signal, and the
// doppelganger guards. Shapes are modeled on a real captured .jsonl (2026-07-24).

const REF = 'dc52d624-311a-4664-93a9-9520e2b1ff31'
const PROMPT = 'In two short paragraphs, explain what makes the color blue calming. No lists.'
const FILE = '/home/sprite/.gemini/tmp/agt-x/chats/session-2026-07-24T12-27-dc52d624.jsonl'

const meta = (): string =>
    JSON.stringify({
        sessionId: REF,
        projectHash: 'hash',
        startTime: '2026-07-24T12:27:58.022Z',
        lastUpdated: '2026-07-24T12:27:58.022Z',
        kind: 'main'
    })

// The CLI's bulk session_context synthetic user message.
const setContext = (): string =>
    JSON.stringify({
        $set: {
            messages: [
                {
                    id: 'ctx1',
                    timestamp: '2026-07-24T12:27:58.023Z',
                    type: 'user',
                    content: [{ text: '<session_context>...</session_context>' }]
                }
            ],
            lastUpdated: '2026-07-24T12:27:58.023Z'
        }
    })

const userMsg = (
    id: string,
    text: string,
    ts = '2026-07-24T12:27:58.045Z'
): string =>
    JSON.stringify({
        id,
        timestamp: ts,
        type: 'user',
        content: [{ text }]
    })

const setUpdated = (): string =>
    JSON.stringify({ $set: { lastUpdated: '2026-07-24T12:27:59.000Z' } })

// A gemini message snapshot: content-only (in flight) then re-appended with
// tokens (complete) — the same id.
const geminiMsg = (
    id: string,
    content: string,
    opts?: {
        tokens?: { input: number; output: number; cached: number }
        thoughts?: string[]
        model?: string
        toolCalls?: unknown[]
    }
): string =>
    JSON.stringify({
        id,
        timestamp: '2026-07-24T12:28:01.000Z',
        type: 'gemini',
        content: [{ text: content }],
        thoughts: (opts?.thoughts ?? []).map((d) => ({
            subject: '',
            description: d,
            timestamp: '2026-07-24T12:28:00.000Z'
        })),
        ...(opts?.tokens
            ? {
                  tokens: {
                      input: opts.tokens.input,
                      output: opts.tokens.output,
                      cached: opts.tokens.cached,
                      thoughts: 0,
                      tool: 0,
                      total:
                          opts.tokens.input +
                          opts.tokens.output +
                          opts.tokens.cached
                  }
              }
            : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.toolCalls ? { toolCalls: opts.toolCalls } : {})
    })

const fsOf = (text: string | null): RecoveryFs =>
    ({
        locate: async () => (text === null ? null : FILE),
        readFile: async () => text,
        listFiles: async () => []
    }) as never

const recover = (
    lines: string[],
    opts?: { promptText?: string; messageCreatedAt?: Date }
): Promise<GeminiTurnVerdict> =>
    recoverTurnFromGeminiSession({
        fs: fsOf(lines.join('\n') + '\n'),
        frameworkSessionRef: REF,
        promptText: opts?.promptText ?? PROMPT,
        model: 'fallback-model',
        messageCreatedAt: opts?.messageCreatedAt
    })

test('recovers a completed gemini turn: anchor, thinking+token, usage, model', async () => {
    const v = await recover([
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        setUpdated(),
        geminiMsg('g1', 'Blue is calming because it evokes the sky.', {
            thoughts: ['Considering the calm of blue'],
            tokens: { input: 260, output: 40, cached: 0 },
            model: 'gemini-2.5-flash'
        })
    ])
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const semantic = v.events.filter((e) => e.type !== 'raw_source')
    assert.deepEqual(
        semantic.map((e) => e.type),
        ['thinking', 'token']
    )
    assert.deepEqual(semantic[1], {
        type: 'token',
        text: 'Blue is calming because it evokes the sky.'
    })
    assert.equal(v.usage.inputTokens, 260)
    assert.equal(v.usage.outputTokens, 40)
    assert.equal(v.usage.model, 'gemini-2.5-flash')
    assert.equal(v.usage.costSource, 'unknown')
    assert.equal(v.recoveredMessages, 1)
})

test('a gemini message without tokens is result_lost but streams its content', async () => {
    const v = await recover([
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Blue is calming', {})
    ])
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.equal(v.hasContent, true)
    assert.match(v.detail, /no usage/)
    const semantic = v.events.filter((e) => e.type !== 'raw_source')
    assert.deepEqual(semantic, [{ type: 'token', text: 'Blue is calming' }])
})

test('same message id re-appended: last record wins (final content + usage)', async () => {
    const v = await recover([
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        // content-only snapshot first...
        geminiMsg('g1', 'Blue is calming', {}),
        // ...then re-appended WITH tokens (the completing record).
        geminiMsg('g1', 'Blue is calming because it evokes the open sky.', {
            tokens: { input: 260, output: 55, cached: 5 }
        })
    ])
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const tokens = v.events.filter((e) => e.type === 'token')
    assert.equal(tokens.length, 1, 'the id emits once, not once per append')
    assert.deepEqual(tokens[0], {
        type: 'token',
        text: 'Blue is calming because it evokes the open sky.'
    })
    assert.equal(v.usage.outputTokens, 55)
    assert.equal(v.usage.cacheReadTokens, 5)
})

test('the session_context bulk message never anchors or leaks', async () => {
    const v = await recover([
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'answer', { tokens: { input: 1, output: 1, cached: 0 } })
    ])
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    assert.ok(
        !v.events.some(
            (e) => e.type === 'token' && e.text.includes('session_context')
        )
    )
})

test('tool calls and results reconstruct with args and output', async () => {
    const v = await recover([
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'Ran it.', {
            tokens: { input: 10, output: 5, cached: 0 },
            toolCalls: [
                {
                    id: 'tool-1',
                    name: 'run_shell',
                    args: { cmd: 'echo hi' },
                    result: [
                        {
                            functionResponse: {
                                response: { output: 'hi\n' }
                            }
                        }
                    ]
                }
            ]
        })
    ])
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const call = v.events.find((e) => e.type === 'tool_call') as {
        toolCallId: string
        toolName: string
        args: unknown
    }
    assert.equal(call.toolCallId, 'tool-1')
    assert.equal(call.toolName, 'run_shell')
    assert.deepEqual(call.args, { cmd: 'echo hi' })
    const result = v.events.find((e) => e.type === 'tool_result') as {
        result: unknown
    }
    assert.equal(result.result, 'hi\n')
})

test('a prompt mismatch never emits another turn content', async () => {
    const v = await recover(
        [
            meta(),
            setContext(),
            userMsg('u1', PROMPT),
            geminiMsg('g1', 'answer', {
                tokens: { input: 1, output: 1, cached: 0 }
            })
        ],
        { promptText: 'a DIFFERENT prompt' }
    )
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.equal(v.events.length, 0)
    assert.match(v.detail, /prompt not found/)
})

test('a repeated prompt anchors on the LATEST occurrence, not the prior turn', async () => {
    const v = await recover([
        meta(),
        setContext(),
        // prior turn with the SAME prompt
        userMsg('u1', PROMPT, '2026-07-24T12:20:00.000Z'),
        geminiMsg('g1', 'earlier answer', {
            tokens: { input: 1, output: 1, cached: 0 }
        }),
        // this turn
        userMsg('u2', PROMPT, '2026-07-24T12:28:00.000Z'),
        geminiMsg('g2', 'the fresh answer', {
            tokens: { input: 2, output: 3, cached: 0 }
        })
    ])
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const tokens = v.events.filter((e) => e.type === 'token') as Array<{
        text: string
    }>
    assert.deepEqual(
        tokens.map((t) => t.text),
        ['the fresh answer']
    )
    assert.ok(!tokens.some((t) => t.text.includes('earlier')))
    assert.equal(v.usage.outputTokens, 3)
})

test('an anchor far older than the message is rejected (stale doppelganger)', async () => {
    const v = await recover(
        [
            meta(),
            setContext(),
            userMsg('u1', PROMPT, '2026-07-24T12:00:00.000Z'),
            geminiMsg('g1', 'stale answer', {
                tokens: { input: 1, output: 1, cached: 0 }
            })
        ],
        { messageCreatedAt: new Date('2026-07-24T12:28:00.000Z') }
    )
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /predates/)
    assert.equal(v.events.length, 0)
})

test('plain-string content is handled as well as {text} parts', async () => {
    const lines = [
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        JSON.stringify({
            id: 'g1',
            timestamp: '2026-07-24T12:28:01.000Z',
            type: 'gemini',
            content: 'a plain string answer',
            tokens: { input: 1, output: 1, cached: 0, thoughts: 0, tool: 0, total: 2 }
        })
    ]
    const v = await recover(lines)
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const token = v.events.find((e) => e.type === 'token') as { text: string }
    assert.equal(token.text, 'a plain string answer')
})

test('raw_source rows carry the message id and the raw record', async () => {
    const v = await recover([
        meta(),
        setContext(),
        userMsg('u1', PROMPT),
        geminiMsg('g1', 'answer', { tokens: { input: 1, output: 1, cached: 0 } })
    ])
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    const sources = v.events.filter((e) => e.type === 'raw_source') as Array<{
        source: { externalId: string; rawText: string }
    }>
    const g = sources.find((s) => s.source.externalId === 'g1')
    assert.ok(g, 'the gemini message has a raw_source row keyed by its id')
    assert.ok(g.source.rawText.includes('"type":"gemini"'))
})

test('missing session file fails loudly', async () => {
    const v = await recoverTurnFromGeminiSession({
        fs: fsOf(null),
        frameworkSessionRef: REF,
        promptText: PROMPT,
        model: null
    })
    assert.equal(v.outcome, 'failed')
})

// Executed against a real fixture tree via `bash -lc` — the same invocation
// RecoveryFs.locate uses on the sprite. A string-level assertion cannot catch
// quoting bugs in the generated script (one shipped: a double shellEscape made
// the grep pattern literally include single quotes, so it never matched).
test('locate script finds the file by full sessionId when run in bash', () => {
    const home = mkdtempSync(join(tmpdir(), 'gemini-locate-'))
    const chats = join(home, '.gemini', 'tmp', 'hash', 'chats')
    mkdirSync(chats, { recursive: true })
    // Decoy shares the 8-char filename prefix but has a different full id.
    const decoyRef = 'dc52d624-ffff-ffff-ffff-ffffffffffff'
    writeFileSync(
        join(chats, 'session-2026-07-24T12-00-dc52d624.jsonl'),
        JSON.stringify({ sessionId: decoyRef, kind: 'main' }) + '\n'
    )
    const target = join(chats, 'session-2026-07-24T12-27-dc52d624.jsonl')
    writeFileSync(target, [meta(), userMsg('u1', PROMPT)].join('\n') + '\n')

    const run = (ref: string): { stdout: string; status: number | null } => {
        const res = spawnSync('bash', ['-lc', geminiSessionLocateScript(ref)], {
            env: { ...process.env, HOME: home },
            encoding: 'utf8'
        })
        return { stdout: res.stdout.trim(), status: res.status }
    }

    const found = run(REF)
    assert.equal(found.stdout, target)
    const missing = run('00000000-0000-0000-0000-000000000000')
    assert.equal(missing.stdout, '')
})
