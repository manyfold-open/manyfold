import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The openclaw half of turn.start over ACP (ADR-0027, O6). Driven against a
// FAKE `openclaw` on PATH that plays both roles the runner invokes: the ACP
// bridge (`openclaw acp`) and the in-box gateway RPC (`openclaw gateway call`).
// What matters: session/new carries the deterministic _meta.sessionKey and
// there is NO session/resume; the ask mode pre-patches execAsk before the
// bridge and relays the card; the usage is read back from the gateway
// transcript and lands on the final; every frame is durable.
//
// daemonPaths resolves from homedir() at import time, so HOME is redirected
// before the dynamic import.
const home = mkdtempSync(join(tmpdir(), 'mf-oc-acp-'))
process.env.HOME = home
process.env.MF_PROFILE = 'openclawacptest'

// A fake `openclaw` binary. `acp` is the bridge; `gateway call` answers the
// patch (recording its params) and sessions.get (a transcript whose last user
// message contains the prompt, plus one assistant usage row). Records the ACP
// frames it received to $OC_RECORD so the test can assert sessionKey / no
// resume / prefixCwd.
const FAKE_OPENCLAW = `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const rec = (obj) => { if (process.env.OC_RECORD) fs.appendFileSync(process.env.OC_RECORD, JSON.stringify(obj) + '\\n') }
const argv = process.argv.slice(2)
if (argv[0] === 'gateway' && argv[1] === 'call') {
    const method = argv[2]
    const pi = argv.indexOf('--params')
    const params = pi >= 0 ? JSON.parse(argv[pi + 1]) : {}
    rec({ gatewayCall: method, params })
    if (method === 'sessions.patch') { process.stdout.write(JSON.stringify({ ok: true, entry: { execAsk: params.execAsk, modelOverride: params.model } })); process.exit(0) }
    if (method === 'sessions.get') {
        process.stdout.write(JSON.stringify({ messages: [
            { role: 'user', content: [{ type: 'text', text: 'Sender (untrusted metadata):\\n' + (process.env.OC_PROMPT || '') }], timestamp: 1 },
            { role: 'assistant', model: 'stub-model', provider: 'primary', usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 }, timestamp: 2 }
        ] }))
        process.exit(0)
    }
    process.stdout.write('{}'); process.exit(0)
}
if (argv[0] !== 'acp') { process.exit(2) }
const mode = process.env.OC_MODE || 'happy'
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
const notify = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { update } })
let promptId = null
rl.on('line', (line) => {
    let frame; try { frame = JSON.parse(line) } catch { return }
    rec({ recv: frame })
    if (frame.method === 'initialize') return send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
    if (frame.method === 'session/resume') { rec({ sawResume: true }); return send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'sess_oc_1' } }) }
    if (frame.method === 'session/new') return send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'sess_oc_1' } })
    if (frame.method === 'session/prompt') {
        promptId = frame.id
        if (mode === 'crash') { process.stderr.write('Aborting: provider auth failed\\n'); process.exit(3) }
        if (mode === 'hang') return
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } })
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
        if (mode === 'interactive')
            return send({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: { toolCall: { toolCallId: 'exec:1', title: 'Command approval requested', rawInput: { command: 'echo hi' } }, options: [
                { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
            ] } })
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })
    }
    if (frame.id === 999 && frame.result) {
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'perm=' + (frame.result.outcome.optionId || frame.result.outcome.outcome) } })
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })
    }
})
process.stdin.on('end', () => process.exit(0))
`
const binDir = join(home, 'bin')
const { mkdirSync } = await import('node:fs')
mkdirSync(binDir, { recursive: true })
const openclawBin = join(binDir, 'openclaw')
writeFileSync(openclawBin, FAKE_OPENCLAW)
chmodSync(openclawBin, 0o755)
process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

const { runOpenclawAcpTurn } = await import('../src/daemon/openclaw-acp-turn')
const { permissionResponders } = await import('../src/daemon/acp-turn')
const { readEventsFrom, readFinal } = await import('../src/daemon/exec-buffer')

interface SentEvent {
    kind: string
    data: string
    seq?: number
}
const makeCtx = (
    refId: string
): {
    ctx: {
        refId: string
        sendEvent: (kind: string, data: string, seq?: number) => void
        onCancel: (h: () => void) => void
    }
    events: SentEvent[]
    cancel: () => void
} => {
    const events: SentEvent[] = []
    let cancelHandler: (() => void) | null = null
    return {
        ctx: {
            refId,
            sendEvent: (kind, data, seq) => events.push({ kind, data, seq }),
            onCancel: (h) => {
                cancelHandler = h
            }
        },
        events,
        cancel: () => cancelHandler?.()
    }
}

const recordPath = (name: string): string => join(home, `${name}.jsonl`)
const readRecord = (name: string): Array<Record<string, unknown>> =>
    existsSync(recordPath(name))
        ? readFileSync(recordPath(name), 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
        : []

const payloadFor = (
    extra: Record<string, unknown> = {}
): never =>
    ({
        framework: 'openclaw',
        transport: 'acp',
        prompt: 'say hello',
        sessionKey: 'agent:main:mf-cts_1',
        handshakeTimeoutMs: 10_000,
        idleTimeoutMs: 15_000,
        maxDurationMs: 15_000,
        ...extra
    }) as never

test('a daemon ACP turn pins the gateway key, never resumes, and reads usage back', async () => {
    const rec = recordPath('happy')
    process.env.OC_RECORD = rec
    process.env.OC_PROMPT = 'say hello'
    process.env.OC_MODE = 'happy'
    const h = makeCtx('oc-happy-1')
    const ack = await runOpenclawAcpTurn({
        payload: payloadFor(),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    delete process.env.OC_RECORD
    assert.equal(ack.ok, true, ack.error)
    const final = ack.payload as {
        stopReason: string
        sessionId: string
        usage?: { inputTokens: number; outputTokens: number; model: string | null }
        usageStatus?: string
    }
    assert.equal(final.stopReason, 'end_turn')
    assert.equal(final.sessionId, 'sess_oc_1')
    // The usage read back from the gateway transcript rides the final.
    assert.equal(final.usageStatus, 'ok')
    assert.equal(final.usage?.inputTokens, 11)
    assert.equal(final.usage?.outputTokens, 7)

    const records = readRecord('happy')
    // session/new carried the deterministic key; there was no session/resume.
    const created = records.find(
        (r) => (r.recv as { method?: string } | undefined)?.method === 'session/new'
    )?.recv as { params?: { _meta?: { sessionKey?: string } } }
    assert.equal(created?.params?._meta?.sessionKey, 'agent:main:mf-cts_1')
    assert.ok(!records.some((r) => 'sawResume' in r))
    // The prompt suppressed the bridge's cwd prefix.
    const prompt = records.find(
        (r) => (r.recv as { method?: string } | undefined)?.method === 'session/prompt'
    )?.recv as { params?: { _meta?: { prefixCwd?: boolean } } }
    assert.equal(prompt?.params?._meta?.prefixCwd, false)

    // Every ACP frame is durable, one event per line, and the tokens streamed.
    const stdout = h.events.filter((e) => e.kind === 'stdout')
    const text = stdout
        .map((e) => JSON.parse(e.data) as Record<string, unknown>)
        .filter(
            (f) =>
                (f as { method?: string }).method === 'session/update' &&
                ((f as { params?: { update?: { sessionUpdate?: string } } })
                    .params?.update?.sessionUpdate === 'agent_message_chunk')
        )
    assert.ok(text.length >= 2)
    const buffered = readEventsFrom('oc-happy-1', 0)
    assert.ok(buffered.length > 0)
})

test('dontAsk sends no gateway patch; default pre-patches execAsk before the bridge', async () => {
    // dontAsk (default): no sessions.patch at all.
    const recQuiet = recordPath('dontask')
    process.env.OC_RECORD = recQuiet
    process.env.OC_PROMPT = 'say hello'
    process.env.OC_MODE = 'happy'
    const ackQuiet = await runOpenclawAcpTurn({
        payload: payloadFor(),
        cwd: home,
        ctx: makeCtx('oc-dontask-1').ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    delete process.env.OC_RECORD
    assert.equal(ackQuiet.ok, true)
    assert.ok(
        !readRecord('dontask').some((r) => r.gatewayCall === 'sessions.patch')
    )

    // default: sessions.patch {execAsk, model} runs, and it precedes the bridge.
    const recPatch = recordPath('patch')
    process.env.OC_RECORD = recPatch
    process.env.OC_MODE = 'happy'
    const ack = await runOpenclawAcpTurn({
        payload: payloadFor({
            permissionMode: 'default',
            patch: { execAsk: 'on-miss', model: 'primary/stub-b' }
        }),
        cwd: home,
        ctx: makeCtx('oc-patch-1').ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    delete process.env.OC_RECORD
    assert.equal(ack.ok, true)
    const records = readRecord('patch')
    const patch = records.find((r) => r.gatewayCall === 'sessions.patch')
    assert.ok(patch, 'expected a sessions.patch')
    assert.equal(
        (patch!.params as { execAsk?: string }).execAsk,
        'on-miss'
    )
    assert.equal(
        (patch!.params as { model?: string }).model,
        'primary/stub-b'
    )
    // The patch happened before the first ACP frame reached the bridge.
    const patchIdx = records.findIndex((r) => r.gatewayCall === 'sessions.patch')
    const firstAcpIdx = records.findIndex((r) => 'recv' in r)
    assert.ok(patchIdx !== -1 && patchIdx < firstAcpIdx)
})

test('an ask-mode turn takes the user answer via the responder', async () => {
    process.env.OC_MODE = 'interactive'
    process.env.OC_PROMPT = 'say hello'
    const h = makeCtx('oc-perm-1')
    const done = runOpenclawAcpTurn({
        payload: payloadFor({ permissionMode: 'default' }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    // Wait for the card to be relayed, then answer through the shared responder.
    for (let i = 0; i < 100; i++) {
        const responder = permissionResponders.get('oc-perm-1')
        const card = h.events.find((e) => {
            try {
                const f = JSON.parse(e.data) as { method?: string }
                return f.method === 'session/request_permission'
            } catch {
                return false
            }
        })
        if (responder && card) {
            const frame = JSON.parse(card.data) as { id: number | string }
            assert.equal(
                responder(String(frame.id), 'allow-once'),
                'delivered'
            )
            break
        }
        await new Promise((r) => setTimeout(r, 20))
    }
    const ack = await done
    assert.equal(ack.ok, true, ack.error)
    // The runner cleaned up its responder.
    assert.equal(permissionResponders.get('oc-perm-1'), undefined)
    // The approved text streamed after the resolution.
    const text = h.events
        .filter((e) => e.kind === 'stdout')
        .map((e) => {
            try {
                return JSON.parse(e.data) as {
                    params?: { update?: { content?: { text?: string } } }
                }
            } catch {
                return null
            }
        })
        .map((f) => f?.params?.update?.content?.text ?? '')
        .join('')
    assert.ok(text.includes('perm=allow-once'))
})

test('a child that dies mid-prompt fails the turn with its stderr cause', async () => {
    process.env.OC_MODE = 'crash'
    process.env.OC_PROMPT = 'say hello'
    const ack = await runOpenclawAcpTurn({
        payload: payloadFor(),
        cwd: home,
        ctx: makeCtx('oc-crash-1').ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, false)
    assert.match(String(ack.error ?? ''), /provider auth failed|exited/)
    const final = readFinal('oc-crash-1')
    assert.equal(final?.ok, false)
})
