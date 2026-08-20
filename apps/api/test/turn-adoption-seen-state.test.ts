import test from 'node:test'
import assert from 'node:assert/strict'
import {
    buildSeenStateFromPersisted,
    type PersistedSourceRow,
    type PersistedStreamEvent
} from '../src/modules/chat/recovery/adoption-seen-state'
import { recoverTurnFromClaudeJsonl } from '../src/modules/chat/recovery/turn-jsonl-recovery'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'

// Reconstructing "what the dead stream already delivered" from the durable log
// is the novel, correctness-critical bit of cross-process turn adoption: the
// reconstructed TurnSeenState feeds the (already-tested) recoverTurnFromClaudeJsonl,
// whose emitStreamedText re-emits only the unseen tail. A wrong reconstruction
// must at worst bail to result_lost (a retryable error) — never duplicate or
// drop text — so these tests pin the reconstruction that keeps it aligned.

const assistantLine = (
    uuid: string,
    messageId: string,
    blocks: Array<{ kind: 'text' | 'thinking'; text: string }>
): string =>
    JSON.stringify({
        uuid,
        sessionId: 'sess',
        message: {
            role: 'assistant',
            id: messageId,
            content: blocks.map((b) =>
                b.kind === 'text'
                    ? { type: 'text', text: b.text }
                    : { type: 'thinking', thinking: b.text }
            )
        }
    })

const sourceRow = (
    rawText: string,
    externalId: string,
    sourceSeq: number
): PersistedSourceRow => ({ rawText, externalId, sourceSeq })

const tokenEv = (text: string): PersistedStreamEvent => ({
    eventType: 'token',
    payloadJson: { type: 'token', text }
})
const thinkingEv = (text: string): PersistedStreamEvent => ({
    eventType: 'thinking',
    payloadJson: { type: 'thinking', text }
})

test('reconstructs uuids, apiMessageIds and firstSourceSeq from source rows', () => {
    const sourceRows = [
        sourceRow(assistantLine('u1', 'm1', [{ kind: 'text', text: 'Hello' }]), 'u1', 3),
        sourceRow(assistantLine('u2', 'm2', [{ kind: 'text', text: 'World' }]), 'u2', 7)
    ]
    const { seen, firstSourceSeq } = buildSeenStateFromPersisted({
        streamEvents: [tokenEv('Hello'), tokenEv('World')],
        sourceRows
    })
    assert.deepEqual([...seen.uuids].sort(), ['u1', 'u2'])
    assert.deepEqual([...seen.apiMessageIds].sort(), ['m1', 'm2'])
    assert.equal(firstSourceSeq, 7)
    assert.equal(seen.deltaRuns.length, 0)
})

test('deltaRuns = streamed text beyond the complete lines (the in-flight block)', () => {
    // Two blocks fully committed to disk (covered="HelloWorld"); the stream also
    // delivered "!!" of a third block whose JSONL line was lost to the crash.
    const sourceRows = [
        sourceRow(assistantLine('u1', 'm1', [{ kind: 'text', text: 'Hello' }]), 'u1', 1),
        sourceRow(assistantLine('u2', 'm1', [{ kind: 'text', text: 'World' }]), 'u2', 2)
    ]
    const { seen } = buildSeenStateFromPersisted({
        streamEvents: [
            tokenEv('Hel'),
            tokenEv('lo'),
            tokenEv('Wor'),
            tokenEv('ld'),
            tokenEv('!!')
        ],
        sourceRows
    })
    assert.deepEqual(seen.deltaRuns, [{ kind: 'token', text: '!!' }])
})

test('nothing persisted yet → all delivered text is deltaRuns', () => {
    const { seen } = buildSeenStateFromPersisted({
        streamEvents: [tokenEv('par'), tokenEv('tial')],
        sourceRows: []
    })
    assert.deepEqual(seen.deltaRuns, [{ kind: 'token', text: 'partial' }])
    assert.equal(seen.uuids.size, 0)
})

test('thinking and token cursors are independent and order-preserving', () => {
    // Covered: thinking "TH" + token "AB". Streamed further: thinking "X", token "C".
    const sourceRows = [
        sourceRow(
            assistantLine('u1', 'm1', [
                { kind: 'thinking', text: 'TH' },
                { kind: 'text', text: 'AB' }
            ]),
            'u1',
            1
        )
    ]
    const { seen } = buildSeenStateFromPersisted({
        streamEvents: [
            thinkingEv('T'),
            thinkingEv('H'),
            thinkingEv('X'),
            tokenEv('AB'),
            tokenEv('C')
        ],
        sourceRows
    })
    assert.deepEqual(seen.deltaRuns, [
        { kind: 'thinking', text: 'X' },
        { kind: 'token', text: 'C' }
    ])
})

test('collects tool_call ids from stream events', () => {
    const { seen } = buildSeenStateFromPersisted({
        streamEvents: [
            { eventType: 'tool_call', payloadJson: { toolCallId: 'tc_0' } },
            { eventType: 'tool_call', payloadJson: { toolCallId: 'tc_1' } }
        ],
        sourceRows: []
    })
    assert.deepEqual([...seen.toolCallIds].sort(), ['tc_0', 'tc_1'])
})

test('unparseable source rows never throw and simply drop their anchors', () => {
    const { seen } = buildSeenStateFromPersisted({
        streamEvents: [tokenEv('hi')],
        sourceRows: [sourceRow('{not json', 'u1', 1)]
    })
    // externalId still contributes a uuid; the missing message.id just can't.
    assert.deepEqual([...seen.uuids], ['u1'])
    assert.equal(seen.apiMessageIds.size, 0)
})

// What a raw_text clear (plan retention today, age-based retention now) costs
// this reader. listMessageSourceRows maps a cleared row to rawText '', so the
// uuid and seq anchors survive on their own columns while everything that has
// to be parsed OUT of the payload is gone. The consequence is not a degraded
// recovery but a lost one, which is why the age-based sweep refuses any row
// whose message still has an open turn_executions record.
const RECOVERY_SOURCE_FILE = '/home/sprite/.claude/projects/p/sess-1.jsonl'

const clearedTurnFs = (): RecoveryFs => ({
    locate: async () => RECOVERY_SOURCE_FILE,
    listFiles: async () => [],
    exec: async () => null,
    readBinary: async () => null,
    readFile: async () =>
        [
            JSON.stringify({
                uuid: 'up',
                parentUuid: null,
                sessionId: 'sess-1',
                type: 'user',
                message: { role: 'user', content: 'prompt' }
            }),
            assistantTurnLine('u1', 'Hello', null),
            assistantTurnLine('u2', 'World', null),
            assistantTurnLine('u3', '!!done', 'end_turn')
        ].join('\n')
})

function assistantTurnLine(
    uuid: string,
    text: string,
    stop: string | null
): string {
    return JSON.stringify({
        uuid,
        parentUuid: null,
        sessionId: 'sess-1',
        type: 'assistant',
        message: {
            role: 'assistant',
            id: 'm1',
            model: 'claude-x',
            stop_reason: stop,
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'text', text }]
        }
    })
}

// The stream delivered "Hello" + "World" (both committed to disk) and "!!" of
// a third block whose line never landed before the crash.
const CRASHED_TURN_EVENTS = [tokenEv('Hello'), tokenEv('World'), tokenEv('!!')]

const recoverWith = async (sourceRows: PersistedSourceRow[]) => {
    const { seen, firstSourceSeq } = buildSeenStateFromPersisted({
        streamEvents: CRASHED_TURN_EVENTS,
        sourceRows
    })
    const verdict = await recoverTurnFromClaudeJsonl({
        fs: clearedTurnFs(),
        frameworkSessionRef: 'sess-1',
        promptText: 'prompt',
        seen,
        firstSourceSeq,
        model: 'claude-x',
        tStart: 0,
        tFirstToken: null,
        now: () => 1000
    })
    return { seen, verdict }
}

const intactRows = (): PersistedSourceRow[] => [
    sourceRow(assistantLine('u1', 'm1', [{ kind: 'text', text: 'Hello' }]), 'u1', 1),
    sourceRow(assistantLine('u2', 'm1', [{ kind: 'text', text: 'World' }]), 'u2', 2)
]

// A cleared row keeps its id columns and loses only the payload — exactly
// what clearSourceBatch and the age-based sweep write.
const clearedRows = (): PersistedSourceRow[] => [
    sourceRow('', 'u1', 1),
    sourceRow('', 'u2', 2)
]

test('intact source rows let an orphaned turn be adopted and finished', async () => {
    const { seen, verdict } = await recoverWith(intactRows())

    assert.deepEqual(seen.deltaRuns, [{ kind: 'token', text: '!!' }])
    assert.equal(verdict.outcome, 'recovered')
    assert.deepEqual(
        verdict.outcome === 'recovered'
            ? verdict.events.filter((e) => e.type === 'token')
            : [],
        [{ type: 'token', text: 'done' }],
        'only the tail beyond the delivered partial is re-emitted'
    )
})

test('a cleared raw payload strands the same turn at result_lost', async () => {
    const { seen, verdict } = await recoverWith(clearedRows())

    // Survives a clear: the per-line dedup key and the seq watermark.
    assert.deepEqual([...seen.uuids].sort(), ['u1', 'u2'])
    // Lost with the payload: the message.id fallback anchor, and the record
    // of which delivered text the transcript already covers.
    assert.equal(seen.apiMessageIds.size, 0)
    assert.deepEqual(seen.deltaRuns, [{ kind: 'token', text: 'HelloWorld!!' }])

    assert.equal(verdict.outcome, 'result_lost')
    assert.match(
        verdict.outcome === 'result_lost' ? verdict.detail : '',
        /not a prefix of the recovered block/
    )
})

// Property: for arbitrary chunkings of the streamed text, the reconstructed
// deltaRuns concatenated back onto the covered text must equal the full
// delivered text per kind — i.e. reconstruction never loses or invents text.
const prng = (seed: number): (() => number) => {
    let a = seed >>> 0
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const chunk = (text: string, rnd: () => number): string[] => {
    const units = Array.from(text)
    const out: string[] = []
    let i = 0
    while (i < units.length) {
        const take = 1 + Math.floor(rnd() * (units.length - i))
        out.push(units.slice(i, i + take).join(''))
        i += take
    }
    return out
}

test('property: covered + deltaRuns == full delivered text (5000 trials)', () => {
    for (let seed = 1; seed <= 5000; seed++) {
        const rnd = prng(seed)
        const coveredToken = 'ABC中🙂'.repeat(1 + Math.floor(rnd() * 3))
        const tailToken = rnd() < 0.5 ? 'tail🚀text' : ''
        const fullToken = coveredToken + tailToken
        const sourceRows = [
            sourceRow(
                assistantLine('u1', 'm1', [{ kind: 'text', text: coveredToken }]),
                'u1',
                1
            )
        ]
        const streamEvents = chunk(fullToken, rnd).map(tokenEv)
        const { seen } = buildSeenStateFromPersisted({ streamEvents, sourceRows })
        const reconstructed =
            coveredToken +
            seen.deltaRuns
                .filter((r) => r.kind === 'token')
                .map((r) => r.text)
                .join('')
        assert.equal(
            reconstructed,
            fullToken,
            `seed=${seed}: reconstructed token text != delivered`
        )
    }
})
