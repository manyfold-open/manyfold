import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The daemon as ACP client (turn.start). What matters here is the division of
// labour this RPC exists for: the CHILD's whole conversation must land in the
// durable buffer (so an API that restarts can replay it), completion must be
// provable from the final alone (stopReason), and a child that dies or is
// cancelled must leave a final that can never be mistaken for a finished turn.
//
// daemonPaths is resolved from homedir() at import time, so HOME is redirected
// before the dynamic import to keep this off the developer's real daemon.
const home = mkdtempSync(join(tmpdir(), 'mf-acp-turn-'))
process.env.HOME = home
process.env.MF_PROFILE = 'acpturntest'

const { runAcpTurn } = await import('../src/daemon/acp-turn')
const { readEventsFrom, readFinal, readMeta } = await import(
    '../src/daemon/exec-buffer'
)

// A minimal ACP agent: initialize / session-new / session-resume / prompt.
// On prompt it streams two chunks, then asks for PERMISSION and refuses to
// finish until the client approves — so a happy-path pass proves the daemon's
// auto-approval, not just its plumbing. `crash` dies mid-prompt the way hermes
// does on a provider denial; `hang` never answers, for the cancel path.
const FAKE_AGENT = `
const readline = require('node:readline')
const mode = process.argv[2] || 'happy'
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
const notify = (update) =>
    send({ jsonrpc: '2.0', method: 'session/update', params: { update } })
let promptId = null
let switchedTo = null
rl.on('line', (line) => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.method === 'initialize')
        return send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } })
    if (frame.method === 'session/new') {
        if (mode === 'model')
            return send({ jsonrpc: '2.0', id: frame.id, result: {
                sessionId: 'sess_fake_1',
                models: { currentModelId: 'prov:old-model', availableModels: [
                    { modelId: 'prov:old-model', name: 'old' },
                    { modelId: 'prov:new-model', name: 'new' }
                ] },
                modes: { currentModeId: 'default', availableModes: [
                    { id: 'default', name: 'Default' },
                    { id: 'accept_edits', name: 'Accept Edits' },
                    { id: 'dont_ask', name: "Don't Ask" }
                ] }
            } })
        return send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'sess_fake_1' } })
    }
    if (frame.method === 'session/set_model') {
        if (mode === 'model-unsupported')
            return send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } })
        switchedTo = frame.params.modelId
        return send({ jsonrpc: '2.0', id: frame.id, result: {} })
    }
    if (frame.method === 'session/resume')
        return send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId } })
    if (frame.method === 'session/prompt') {
        if (mode === 'crash') {
            process.stderr.write('Aborting: provider auth failed\\n')
            process.exit(3)
        }
        if (mode === 'hang') return
        // 'trickle' streams for ~1s then finishes; 'endless' never finishes.
        // Both exist to prove the idle budget rearms on session/update.
        if (mode === 'trickle' || mode === 'endless') {
            const id = frame.id
            let n = 0
            const timer = setInterval(() => {
                n += 1
                notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 't' + n } })
                if (mode === 'trickle' && n >= 10) {
                    clearInterval(timer)
                    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
                }
            }, 100)
            return
        }
        promptId = frame.id
        if (mode === 'model')
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'model=' + (switchedTo || 'none') + ' ' } })
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } })
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
        // 'options' asks with the upstream-shaped option list and echoes the
        // client's choice back into the stream, so a test can prove WHICH
        // grant the auto-approve burned.
        if (mode === 'options')
            return send({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: { options: [
                { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
                { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
                { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
            ] } })
        return send({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: {} })
    }
    if (frame.id === 999 && frame.result) {
        if (mode === 'options')
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' perm=' + frame.result.outcome.optionId } })
        notify({ sessionUpdate: 'turn_end', usage: { inputTokens: 3, outputTokens: 5 } })
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 5 } } })
    }
})
process.stdin.on('end', () => process.exit(0))
`
const agentPath = join(home, 'fake-acp-agent.cjs')
writeFileSync(agentPath, FAKE_AGENT)

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
            sendEvent: (kind, data, seq) => {
                events.push({ kind, data, seq })
            },
            onCancel: (h) => {
                cancelHandler = h
            }
        },
        events,
        cancel: () => cancelHandler?.()
    }
}

const payloadFor = (
    mode: string,
    extra: Record<string, unknown> = {}
): never =>
    ({
        framework: 'hermes',
        prompt: 'say hello',
        cmd: [process.execPath, agentPath, mode],
        timeoutMs: 15_000,
        handshakeTimeoutMs: 10_000,
        ...extra
    }) as never

test('a turn is driven to completion and every frame is durable', async () => {
    const h = makeCtx('turn-happy-1')
    const ack = await runAcpTurn({
        payload: payloadFor('happy', { env: { FAKE_SECRET: 'shh' } }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, true, ack.error)
    const final = ack.payload as { stopReason: string; sessionId: string }
    // stopReason is the API's licence to emit `done`; without it a recovered
    // turn can only suspend.
    assert.equal(final.stopReason, 'end_turn')
    assert.equal(final.sessionId, 'sess_fake_1')

    // One event per JSON-RPC frame, each a complete line: that is what makes
    // the replayed stream immune to chunk boundaries.
    const stdout = h.events.filter((e) => e.kind === 'stdout')
    const frames = stdout.map((e) => JSON.parse(e.data) as Record<string, unknown>)
    const chunks = frames.filter(
        (f) =>
            f.method === 'session/update' &&
            (f.params as { update: { sessionUpdate?: string } }).update
                .sessionUpdate === 'agent_message_chunk'
    )
    assert.equal(
        chunks
            .map(
                (f) =>
                    (f.params as { update: { content: { text: string } } })
                        .update.content.text
            )
            .join(''),
        'hello'
    )
    // The permission ask was auto-approved — the fake refuses to reach
    // turn_end without it.
    assert.ok(stdout.some((e) => e.data.includes('turn_end')))

    // The buffer replays exactly what was streamed, and the final proves
    // completion on its own (this is what exec.resume hands a restarted API).
    const replay = readEventsFrom('turn-happy-1', 0).filter(
        (e) => e.kind === 'stdout'
    )
    assert.deepEqual(
        replay.map((e) => e.data),
        stdout.map((e) => e.data)
    )
    const storedFinal = readFinal('turn-happy-1')
    assert.equal(storedFinal?.ok, true)
    assert.equal(
        (storedFinal?.payload as { stopReason?: string })?.stopReason,
        'end_turn'
    )
    const meta = readMeta('turn-happy-1')
    assert.equal(meta?.status, 'completed')
    // env can carry credentials and nothing reads it back from the buffer.
    assert.ok(!('env' in ((meta?.payload as object) ?? {})))
})

test('a prior sessionId is resumed and the resolved id reported', async () => {
    const h = makeCtx('turn-resume-1')
    const ack = await runAcpTurn({
        payload: payloadFor('happy', { sessionId: 'sess_prior' }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, true, ack.error)
    assert.equal(
        (ack.payload as { sessionId: string }).sessionId,
        'sess_prior'
    )
})

test('a child that dies mid-prompt fails the turn with its stderr cause', async () => {
    const h = makeCtx('turn-crash-1')
    const ack = await runAcpTurn({
        payload: payloadFor('crash'),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, false)
    // Named cause, not a bare exit code or a timeout.
    assert.match(ack.error ?? '', /Aborting/)
    const final = readFinal('turn-crash-1')
    assert.equal(final?.ok, false)
    // A dead child must never look like a finished turn to a later resume.
    assert.equal(
        (final?.payload as { stopReason: string | null }).stopReason,
        null
    )
    assert.equal(readMeta('turn-crash-1')?.status, 'completed')
})

test('cancel kills the child and records an aborted, unfinished stream', async () => {
    const h = makeCtx('turn-cancel-1')
    const ackPromise = runAcpTurn({
        payload: payloadFor('hang'),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    // Cancel is valid at any stage; the delay just lets the handshake start so
    // the child actually exists when the SIGTERM lands.
    await new Promise((r) => setTimeout(r, 300))
    h.cancel()
    const ack = await ackPromise
    assert.equal(ack.ok, false)
    assert.match(ack.error ?? '', /cancelled/)
    assert.equal(readMeta('turn-cancel-1')?.status, 'aborted')
    assert.equal(
        (readFinal('turn-cancel-1')?.payload as { stopReason: string | null })
            .stopReason,
        null
    )
})

// #556, runner-carried half. session/prompt streams the whole answer as
// session/update notifications and only resolves at the end, so the daemon's
// single response deadline over it was a wall-clock cap on the turn, not a hang
// detector. Fixing only the API would have left this one truncating.
const runTurn = (
    refId: string,
    mode: string,
    extra: Record<string, unknown>
): Promise<{
    ok: boolean
    error?: string
    payload?: Record<string, unknown>
}> =>
    runAcpTurn({
        payload: payloadFor(mode, extra),
        cwd: home,
        ctx: makeCtx(refId).ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })

test('a prompt that keeps streaming past the idle budget is not truncated', async () => {
    const startedAt = Date.now()
    // Exactly the shape the API sends, scaled down: the legacy field still
    // carries the OLD single budget, so a daemon that ignored the split fields
    // would truncate this turn at 400ms — which is what makes this a
    // regression test rather than a restatement of the new behaviour.
    const ack = await runTurn('turn-trickle-1', 'trickle', {
        timeoutMs: 400,
        idleTimeoutMs: 400,
        maxDurationMs: 30_000
    })
    const elapsed = Date.now() - startedAt
    assert.ok(
        elapsed > 400,
        `the turn must outlive the 400ms idle budget for this test to mean anything (ran ${elapsed}ms)`
    )
    assert.equal(ack.ok, true, ack.error)
    assert.equal(
        (ack.payload as { stopReason: string }).stopReason,
        'end_turn',
        'an actively streaming turn still reaches its response — the idle watchdog rearms on every frame'
    )
    // Every streamed frame stayed durable for a replay.
    const chunks = readEventsFrom('turn-trickle-1', 0).filter(
        (e) => e.kind === 'stdout' && e.data.includes('agent_message_chunk')
    )
    assert.equal(chunks.length, 10)
})

test('each budget names itself in the final', async () => {
    const idle = await runTurn('turn-idle-1', 'hang', {
        idleTimeoutMs: 300,
        maxDurationMs: 30_000
    })
    assert.equal(idle.ok, false)
    assert.match(idle.error ?? '', /produced no output for 300ms/)
    assert.equal(
        (readFinal('turn-idle-1')?.payload as { stopReason: string | null })
            .stopReason,
        null,
        'a stalled turn is still unfinished — never a fake completion'
    )

    const capped = await runTurn('turn-max-1', 'endless', {
        idleTimeoutMs: 30_000,
        maxDurationMs: 600
    })
    assert.equal(capped.ok, false)
    assert.match(
        capped.error ?? '',
        /600ms maximum duration/,
        'a still-streaming turn stopped by the ceiling must not be reported as silence'
    )
    assert.ok(
        readEventsFrom('turn-max-1', 0).some((e) => e.kind === 'stdout'),
        'the frames produced before the ceiling stay durable for a replay'
    )
})

// WHY: an API that predates the split sends only timeoutMs. It then backs both
// budgets, and because the max clock starts first the payload degenerates to
// exactly the single absolute cap it used to mean — bounded, not unbounded.
test('a payload with only the legacy timeoutMs degenerates to the old single cap', async () => {
    const startedAt = Date.now()
    const ack = await runTurn('turn-legacy-1', 'endless', { timeoutMs: 700 })
    assert.equal(ack.ok, false)
    assert.match(ack.error ?? '', /700ms maximum duration/)
    assert.ok(
        Date.now() - startedAt < 5_000,
        'an actively streaming turn under a legacy payload is still bounded'
    )
})

// Seen on hermes-agent 0.20.6 [2026-08-29]: the old hardcoded
// 'approve_for_session' matches no advertised option id and an unknown id
// maps to DENY — the headless auto-approve was rejecting every file edit.
// When the ask carries options, the answer must be one of them, preferring
// the session-scoped allow_always-kind grant.
test('auto-approve answers with the session-scoped option from the ask', async () => {
    const h = makeCtx('turn-options-1')
    const ack = await runAcpTurn({
        payload: payloadFor('options'),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, true, ack.error)
    const stdout = h.events.filter((e) => e.kind === 'stdout')
    assert.ok(
        stdout.some((e) => e.data.includes('perm=allow_session')),
        'the fake agent must see allow_session as the chosen option'
    )
})

// PR: hermes model switching. The daemon diffs the payload's model against
// the session state hermes reported: a matching session costs no RPC, a
// mismatch is switched via session/set_model, and a build that reports no
// state only attempts the switch when the API marked it REQUIRED — failing
// loudly beats answering with a model the user did not pick.
test('a differing modelOverride is applied via set_model and reported on the final', async () => {
    const h = makeCtx('turn-model-1')
    const ack = await runAcpTurn({
        payload: payloadFor('model', { modelOverride: 'new-model' }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, true, ack.error)
    const stdout = h.events.filter((e) => e.kind === 'stdout')
    assert.ok(
        stdout.some((e) => e.data.includes('model=new-model')),
        'the fake agent must run with the switched model'
    )
    const final = ack.payload as {
        models?: { currentModelId: string | null; modelIds: string[] }
        modes?: { currentModeId: string | null; modeIds: string[] }
    }
    assert.equal(final.models?.currentModelId, 'new-model')
    assert.deepEqual(final.models?.modelIds, [
        'prov:old-model',
        'prov:new-model'
    ])
    assert.equal(final.modes?.currentModeId, 'default')
    assert.deepEqual(final.modes?.modeIds, [
        'default',
        'accept_edits',
        'dont_ask'
    ])
})

test('a modelOverride matching the session (provider-prefixed) skips set_model', async () => {
    const h = makeCtx('turn-model-2')
    const ack = await runAcpTurn({
        payload: payloadFor('model', { modelOverride: 'old-model' }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, true, ack.error)
    const stdout = h.events.filter((e) => e.kind === 'stdout')
    assert.ok(
        stdout.some((e) => e.data.includes('model=none')),
        'no switch may happen when the session already runs the target'
    )
    const final = ack.payload as {
        models?: { currentModelId: string | null }
    }
    assert.equal(final.models?.currentModelId, 'prov:old-model')
})

test('a REQUIRED override on a stateless build fails the turn on set_model', async () => {
    const h = makeCtx('turn-model-3')
    const ack = await runAcpTurn({
        payload: payloadFor('model-unsupported', {
            modelOverride: 'new-model',
            modelOverrideRequired: true
        }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, false)
    assert.match(ack.error ?? '', /session\/set_model/)
})

test('a reconcile-only override on a stateless build is skipped', async () => {
    const h = makeCtx('turn-model-4')
    const ack = await runAcpTurn({
        payload: payloadFor('model-unsupported', {
            modelOverride: 'new-model',
            modelOverrideRequired: false
        }),
        cwd: home,
        ctx: h.ctx as never,
        registerChild: () => {},
        releaseChild: () => {}
    })
    assert.equal(ack.ok, true, ack.error)
    const final = ack.payload as { models?: unknown }
    assert.equal(final.models, undefined)
})
