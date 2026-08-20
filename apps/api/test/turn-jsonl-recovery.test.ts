import assert from 'node:assert/strict'
import test from 'node:test'
import {
    recoverTurnFromClaudeJsonl,
    type TurnSeenState
} from '../src/modules/chat/recovery/turn-jsonl-recovery'
import {
    parseClaudeJsonlEntries,
    parseClaudeJsonl
} from '../src/modules/chat/recovery/readers/claude-code-reader'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'

const SOURCE_FILE = '/home/sprite/.claude/projects/p/sess-1.jsonl'

const line = (o: unknown): string => JSON.stringify(o)

const fakeFs = (
    fileText: string | null,
    opts: { locateNull?: boolean; readThrows?: boolean } = {}
): RecoveryFs => ({
    locate: async () => (opts.locateNull ? null : SOURCE_FILE),
    exec: async () => '',
    listFiles: async () => [],
    readFile: async () => {
        if (opts.readThrows) throw new Error('read boom')
        return fileText
    },
    readBinary: async () => null
})

const emptySeen = (): TurnSeenState => ({
    uuids: new Set<string>(),
    apiMessageIds: new Set<string>(),
    toolCallIds: new Set<string>(),
    deltaRuns: []
})

interface EntryOpts {
    uuid: string
    parent?: string | null
    session?: string
    sidechain?: boolean
    id?: string
    model?: string
    stop?: string | null
    usage?: Record<string, number>
    content: unknown
}

const userEntry = (uuid: string, text: string, session = 'sess-1'): string =>
    line({
        uuid,
        parentUuid: null,
        sessionId: session,
        type: 'user',
        timestamp: '2026-07-10T00:00:00.000Z',
        message: { role: 'user', content: text }
    })

const assistantEntry = (o: EntryOpts): string =>
    line({
        uuid: o.uuid,
        parentUuid: o.parent ?? null,
        sessionId: o.session ?? 'sess-1',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:01.000Z',
        ...(o.sidechain ? { isSidechain: true } : {}),
        message: {
            role: 'assistant',
            id: o.id ?? 'msg_1',
            model: o.model ?? 'claude-x',
            stop_reason: o.stop ?? 'end_turn',
            usage: o.usage ?? {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 3
            },
            content: o.content
        }
    })

const toolResultEntry = (
    uuid: string,
    toolUseId: string,
    out: string
): string =>
    line({
        uuid,
        parentUuid: null,
        sessionId: 'sess-1',
        type: 'user',
        timestamp: '2026-07-10T00:00:02.000Z',
        message: {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: toolUseId, content: out }
            ]
        }
    })

const baseArgs = (fs: RecoveryFs, over: Record<string, unknown> = {}) => ({
    fs,
    frameworkSessionRef: 'sess-1',
    promptText: 'hello',
    seen: emptySeen(),
    firstSourceSeq: 5,
    model: 'fallback-model',
    tStart: 1000,
    tFirstToken: null as number | null,
    now: () => 2000,
    ...over
})

const tokens = (events: EmittedChatEvent[]): string =>
    events
        .filter((e): e is { type: 'token'; text: string } => e.type === 'token')
        .map((e) => e.text)
        .join('')

const rawSources = (events: EmittedChatEvent[]) =>
    events.filter((e) => e.type === 'raw_source')

test('parseClaudeJsonlEntries surfaces usage/model/stop_reason/isSidechain and leaves grouping unchanged', () => {
    const text = [
        userEntry('u1', 'hi'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            id: 'msg_x',
            model: 'claude-opus',
            stop: 'end_turn',
            usage: { input_tokens: 7, output_tokens: 9 },
            content: [{ type: 'text', text: 'yo' }]
        }),
        line({ type: 'file-history-snapshot', messageId: 'm', snapshot: {} })
    ].join('\n')

    const { entries } = parseClaudeJsonlEntries(text)
    const asst = entries.find((e) => e.parsed.type === 'assistant')!
    assert.equal(asst.parsed.message?.id, 'msg_x')
    assert.equal(asst.parsed.message?.model, 'claude-opus')
    assert.equal(asst.parsed.message?.stop_reason, 'end_turn')
    assert.equal(asst.parsed.message?.usage?.output_tokens, 9)

    // Existing message-grouping parser still keeps only user/assistant/system.
    const { messages } = parseClaudeJsonl(text, 'sess-1', SOURCE_FILE)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[1].role, 'assistant')
})

test('boundary: repeated prompt anchors on the LAST occurrence', async () => {
    const text = [
        userEntry('u1', 'hello'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            id: 'm1',
            content: [{ type: 'text', text: 'first answer' }]
        }),
        userEntry('u2', 'hello'),
        assistantEntry({
            uuid: 'a2',
            parent: 'u2',
            id: 'm2',
            content: [{ type: 'text', text: 'second answer' }]
        })
    ].join('\n')

    const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(text)))
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    assert.equal(tokens(v.events), 'second answer')
})

test('boundary fallback: uses a seen uuid when the prompt text does not match', async () => {
    const text = [
        userEntry('u1', 'the real prompt'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            id: 'm1',
            stop: 'tool_use',
            content: [{ type: 'text', text: 'part one' }]
        }),
        assistantEntry({
            uuid: 'a2',
            parent: 'u1',
            id: 'm2',
            stop: 'end_turn',
            content: [{ type: 'text', text: 'part two' }]
        })
    ].join('\n')
    const seen = emptySeen()
    seen.uuids.add('a1')

    const v = await recoverTurnFromClaudeJsonl(
        baseArgs(fakeFs(text), { promptText: 'does not match', seen })
    )
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    // a1 is the seen anchor + prefix cut, so only a2 is re-emitted.
    assert.equal(tokens(v.events), 'part two')
})

test('boundary not found: neither prompt nor seen match yields result_lost', async () => {
    const text = [
        userEntry('u1', 'unrelated'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            content: [{ type: 'text', text: 'x' }]
        })
    ].join('\n')

    const v = await recoverTurnFromClaudeJsonl(
        baseArgs(fakeFs(text), { promptText: 'nope' })
    )
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /boundary not found/)
    assert.equal(v.events.length, 0)
})

test('terminal: end_turn and stop_sequence recover; tool_use is result_lost', async () => {
    for (const stop of ['end_turn', 'stop_sequence']) {
        const text = [
            userEntry('u1', 'hello'),
            assistantEntry({
                uuid: 'a1',
                parent: 'u1',
                stop,
                content: [{ type: 'text', text: 'done' }]
            })
        ].join('\n')
        const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(text)))
        assert.equal(v.outcome, 'recovered', `stop=${stop}`)
    }

    const dangling = [
        userEntry('u1', 'hello'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            stop: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }]
        })
    ].join('\n')
    const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(dangling)))
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /no terminal stop_reason/)
    // partial content preserved (the dangling tool_call)
    assert.ok(v.events.some((e) => e.type === 'tool_call'))
})

test('terminal: a sidechain end_turn cannot rescue a main-chain tool_use', async () => {
    const text = [
        userEntry('u1', 'hello'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            stop: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'task', input: {} }]
        }),
        assistantEntry({
            uuid: 's1',
            parent: 'a1',
            sidechain: true,
            stop: 'end_turn',
            content: [{ type: 'text', text: 'subagent done' }]
        })
    ].join('\n')
    const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(text)))
    assert.equal(v.outcome, 'result_lost')
})

test('usage: multi-line message counted once; distinct message ids summed; model from last', async () => {
    const usage1 = {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3
    }
    const usage2 = {
        input_tokens: 100,
        output_tokens: 30,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
    }
    const text = [
        userEntry('u1', 'hello'),
        // one API message, three JSONL lines, repeated usage + id
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            id: 'm1',
            model: 'model-a',
            stop: 'tool_use',
            usage: usage1,
            content: [{ type: 'thinking', thinking: 'hmm' }]
        }),
        assistantEntry({
            uuid: 'a2',
            parent: 'u1',
            id: 'm1',
            model: 'model-a',
            stop: 'tool_use',
            usage: usage1,
            content: [{ type: 'text', text: 'calling' }]
        }),
        assistantEntry({
            uuid: 'a3',
            parent: 'u1',
            id: 'm1',
            model: 'model-a',
            stop: 'tool_use',
            usage: usage1,
            content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }]
        }),
        toolResultEntry('u2', 'tu_1', 'ok'),
        // second API message ends the turn
        assistantEntry({
            uuid: 'a4',
            parent: 'u2',
            id: 'm2',
            model: 'model-b',
            stop: 'end_turn',
            usage: usage2,
            content: [{ type: 'text', text: 'final' }]
        })
    ].join('\n')

    const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(text)))
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    assert.equal(v.usage.inputTokens, 10 + 100)
    assert.equal(v.usage.outputTokens, 20 + 30)
    assert.equal(v.usage.cacheReadTokens, 5)
    assert.equal(v.usage.cacheCreationTokens, 3)
    assert.equal(v.usage.model, 'model-b')
    assert.equal(v.usage.costUsd, null)
    assert.equal(v.usage.costSource, 'unknown')
    assert.equal(v.usage.totalMs, 1000)
})

test('dedup: seen uuids cut the streamed prefix; the unseen tail emits each block once', async () => {
    const text = [
        userEntry('u1', 'hello'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            id: 'm1',
            stop: 'tool_use',
            content: [{ type: 'text', text: 'seen text' }]
        }),
        assistantEntry({
            uuid: 'a2',
            parent: 'u1',
            id: 'm2',
            stop: 'end_turn',
            content: [
                { type: 'thinking', thinking: 'ponder' },
                { type: 'text', text: 'fresh text' },
                { type: 'tool_use', id: 'tu_9', name: 'noop', input: {} }
            ]
        })
    ].join('\n')
    const seen = emptySeen()
    seen.uuids.add('a1')

    const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(text), { seen }))
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    // a1 already streamed → not re-emitted; only a2's blocks appear, once each.
    assert.equal(tokens(v.events), 'fresh text')
    assert.equal(v.events.filter((e) => e.type === 'thinking').length, 1)
    assert.equal(v.events.filter((e) => e.type === 'tool_call').length, 1)
    // one raw_source for the single unseen line, seq continues past firstSourceSeq
    assert.equal(rawSources(v.events).length, 1)
    const rs = rawSources(v.events)[0]
    assert.equal(rs.type === 'raw_source' && rs.source.sourceSeq, 6)
    assert.equal(
        rs.type === 'raw_source' && rs.source.parserName,
        'claude-code-session-jsonl'
    )
})

test('deltaRuns: exact-match prefix is skipped, strict prefix emits only the remainder', async () => {
    const text = [
        userEntry('u1', 'hello'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            stop: 'end_turn',
            content: [{ type: 'text', text: 'Hello world!' }]
        })
    ].join('\n')

    // exact match → nothing emitted
    const exact = emptySeen()
    exact.deltaRuns.push({ kind: 'token', text: 'Hello world!' })
    const v1 = await recoverTurnFromClaudeJsonl(
        baseArgs(fakeFs(text), { seen: exact })
    )
    assert.equal(v1.outcome, 'recovered')
    if (v1.outcome !== 'recovered') return
    assert.equal(tokens(v1.events), '')

    // strict prefix → only the remainder
    const prefix = emptySeen()
    prefix.deltaRuns.push({ kind: 'token', text: 'Hello ' })
    const v2 = await recoverTurnFromClaudeJsonl(
        baseArgs(fakeFs(text), { seen: prefix })
    )
    assert.equal(v2.outcome, 'recovered')
    if (v2.outcome !== 'recovered') return
    assert.equal(tokens(v2.events), 'world!')
})

test('deltaRuns: a non-prefix mismatch bails to result_lost with no events', async () => {
    const text = [
        userEntry('u1', 'hello'),
        assistantEntry({
            uuid: 'a1',
            parent: 'u1',
            stop: 'end_turn',
            content: [{ type: 'text', text: 'Hello' }]
        })
    ].join('\n')
    const seen = emptySeen()
    seen.deltaRuns.push({ kind: 'token', text: 'totally different' })

    const v = await recoverTurnFromClaudeJsonl(baseArgs(fakeFs(text), { seen }))
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /mismatch/)
    assert.equal(v.events.length, 0)
})

test('infra failures resolve to failed (never throw)', async () => {
    const notFound = await recoverTurnFromClaudeJsonl(
        baseArgs(fakeFs(null, { locateNull: true }))
    )
    assert.equal(notFound.outcome, 'failed')

    const readErr = await recoverTurnFromClaudeJsonl(
        baseArgs(fakeFs(null, { readThrows: true }))
    )
    assert.equal(readErr.outcome, 'failed')
    if (readErr.outcome !== 'failed') return
    assert.match(readErr.detail, /boom/)
})
