import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    AntigravityCliSessionReader,
    antigravityRefFromPath,
    antigravityTranscriptLineCountScript,
    antigravityTranscriptLocateScript,
    antigravityUserRequest,
    parseAntigravityTranscript,
    parseAntigravityTranscriptLineCount
} from '../src/modules/chat/recovery/readers/antigravity-cli-reader'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'

// The logs agy 1.2.11 wrote for the runs captured beside them (see the
// README): real files, from a stub model.
const DIR = join(
    __dirname,
    'fixtures',
    'antigravity-cli',
    '1.2.11',
    'transcripts'
)
const fixture = (name: string): string => readFileSync(join(DIR, name), 'utf8')

const MULTITOOL = '4a0dbd6a-267c-442d-a678-f6f33270fa3c'
const RESUMED = '6bce3054-1614-4b63-b9b5-9590cdfc8458'
const logsOf = (home: string, id: string): string =>
    join(
        home,
        '.gemini',
        'antigravity-cli',
        'brain',
        id,
        '.system_generated',
        'logs'
    )

// A RecoveryFs over a throwaway HOME: every script runs in real bash.
const bashFs = (home: string): RecoveryFs => {
    const run = (script: string) =>
        spawnSync('bash', ['-c', script], {
            env: { HOME: home, PATH: '/usr/bin:/bin' },
            encoding: 'utf8'
        })
    return {
        locate: async (script) => {
            const r = run(script)
            return r.status === 0 ? r.stdout.split('\n')[0] || null : null
        },
        listFiles: async () => [],
        exec: async (script) => {
            const r = run(script)
            return r.status === 0 ? r.stdout : null
        },
        readFile: async (path) => readFileSync(path, 'utf8'),
        readBinary: async () => null
    }
}

test('a tool turn reads as one message per planner step, each result folded in under the id the stream gave it', () => {
    const file = `/h/.gemini/antigravity-cli/brain/${MULTITOOL}/.system_generated/logs/transcript_full.jsonl`
    const { messages, warnings, lineCount, openTurnStartSeq } =
        parseAntigravityTranscript(
            fixture('multitool.transcript_full.jsonl'),
            file,
            MULTITOOL
        )
    assert.deepEqual(warnings, [])
    assert.equal(lineCount, 8)
    assert.equal(openTurnStartSeq, null)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant', 'assistant', 'assistant', 'assistant']
    )
    const [ask, first, second, third, answer] = messages
    // The envelope agy files a prompt in stays out.
    assert.deepEqual(ask.contentBlocks, [{ type: 'text', text: 'Say hello.' }])
    assert.equal(ask.timestamp, '2026-09-26T16:41:13Z')
    assert.equal(first.parentExternalId, ask.externalId)
    assert.deepEqual(
        first.contentBlocks.map((b) => b.type),
        ['thinking', 'tool_call', 'tool_result']
    )
    const call = first.contentBlocks[1]
    assert.ok(call.type === 'tool_call')
    // The live stream named this step's tool call agy-2 too.
    assert.equal(call.toolCallId, 'agy-2')
    assert.equal(call.toolName, 'run_command')
    assert.equal(
        (call.args as Record<string, unknown>).CommandLine,
        'echo first'
    )
    assert.equal((call.args as Record<string, unknown>).WaitMsBeforeAsync, 5000)
    const result = first.contentBlocks[2]
    assert.ok(result.type === 'tool_result')
    assert.equal(result.toolCallId, 'agy-2')
    assert.match(
        String((result.result as { content: unknown }).content),
        /exited with code 0\.\nOutput:\nfirst/
    )
    assert.deepEqual(
        first.sources.map((s) => s.sourceSeq),
        [2, 3],
        'the planner line and its result line both back the message'
    )
    assert.ok(
        first.sources.every(
            (s) => s.parserName === 'antigravity-cli-transcript-jsonl'
        )
    )
    for (const [message, id] of [
        [second, 'agy-4'],
        [third, 'agy-6']
    ] as const) {
        const block = message.contentBlocks.find((b) => b.type === 'tool_call')
        assert.ok(block?.type === 'tool_call')
        assert.equal(block.toolCallId, id)
    }
    assert.deepEqual(answer.contentBlocks, [
        { type: 'thinking', text: 'Thinking about the reply.' },
        { type: 'text', text: 'All 3 tool calls finished.' }
    ])
})

test('the compact log reads the same, its JSON-encoded arguments decoded', () => {
    const full = parseAntigravityTranscript(
        fixture('multitool.transcript_full.jsonl'),
        '/x/transcript_full.jsonl',
        MULTITOOL
    )
    const compact = parseAntigravityTranscript(
        fixture('multitool.transcript.jsonl'),
        '/x/transcript.jsonl',
        MULTITOOL
    )
    assert.deepEqual(
        compact.messages.map((m) => m.contentBlocks),
        full.messages.map((m) => m.contentBlocks)
    )
})

test('a resumed conversation keeps every turn and drops agy’s restart notices', () => {
    const { messages, lineCount } = parseAntigravityTranscript(
        fixture('resumed.transcript_full.jsonl'),
        null,
        RESUMED
    )
    assert.equal(lineCount, 11)
    assert.deepEqual(
        messages.map((m) =>
            m.contentBlocks
                .filter((b) => b.type === 'text')
                .map((b) => (b as { text: string }).text)
                .join('')
        ),
        [
            'First turn.',
            'Hello from the stub (turn 1).',
            'Second turn.',
            'Hello from the stub (turn 2).',
            'Third turn.',
            'Hello from the stub (turn 3).',
            'Other cwd.',
            'Hello from the stub (turn 4).'
        ]
    )
})

test('a killed turn’s prompt stays, and the next turn settles it', () => {
    const text = fixture('killed-then-resumed.transcript_full.jsonl')
    const settled = parseAntigravityTranscript(text)
    assert.deepEqual(
        settled.messages.map((m) => m.role),
        ['user', 'user', 'assistant']
    )
    assert.equal(settled.openTurnStartSeq, null)
    // Only the prompt of a turn still running: nothing of it is settled.
    const firstLine = `${text.split('\n')[0]}\n`
    assert.equal(parseAntigravityTranscript(firstLine).openTurnStartSeq, 1)
})

test('a turn cut off between a tool call and its answer is still open', () => {
    const lines = fixture('multitool.transcript_full.jsonl').split('\n')
    const cut = parseAntigravityTranscript(`${lines.slice(0, 3).join('\n')}\n`)
    assert.equal(cut.lineCount, 3)
    assert.equal(cut.openTurnStartSeq, 1)
    // A call that never got its result keeps an id of its own.
    const unanswered = parseAntigravityTranscript(
        `${lines.slice(0, 2).join('\n')}\n`
    )
    const call = unanswered.messages[1].contentBlocks.find(
        (b) => b.type === 'tool_call'
    )
    assert.ok(call?.type === 'tool_call')
    assert.equal(call.toolCallId, 'agy-1-0')
})

test('a prompt without the request envelope is taken whole', () => {
    assert.equal(
        antigravityUserRequest('<USER_REQUEST>\nhi\n</USER_REQUEST>\n<X/>'),
        'hi'
    )
    assert.equal(antigravityUserRequest('plain'), 'plain')
    assert.equal(antigravityUserRequest(42), null)
})

test('the log is found by conversation id, the full one first, and counted in lines', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mf-agy-reader-'))
    try {
        const logs = logsOf(home, MULTITOOL)
        mkdirSync(logs, { recursive: true })
        writeFileSync(
            join(logs, 'transcript.jsonl'),
            fixture('multitool.transcript.jsonl')
        )
        const fs = bashFs(home)
        assert.equal(
            await fs.locate(antigravityTranscriptLocateScript(MULTITOOL)),
            join(logs, 'transcript.jsonl')
        )
        writeFileSync(
            join(logs, 'transcript_full.jsonl'),
            fixture('multitool.transcript_full.jsonl')
        )
        assert.equal(
            await fs.locate(antigravityTranscriptLocateScript(MULTITOOL)),
            join(logs, 'transcript_full.jsonl')
        )
        assert.equal(
            parseAntigravityTranscriptLineCount(
                await fs.exec(antigravityTranscriptLineCountScript(MULTITOOL))
            ),
            8
        )
        assert.equal(
            await fs.exec(antigravityTranscriptLineCountScript(RESUMED)),
            null
        )
        // Anything but an id agy minted never reaches a path.
        assert.equal(antigravityTranscriptLocateScript('../../etc'), 'exit 2')

        const reader = new AntigravityCliSessionReader()
        const read = await reader.readMessages({
            fs,
            agentId: 'agt_1',
            frameworkSessionRef: MULTITOOL
        })
        assert.equal(read.transcript, 'read')
        assert.equal(read.messages.length, 5)
        assert.equal(read.lineCount, 8)
        const missing = await reader.readMessages({
            fs,
            agentId: 'agt_1',
            frameworkSessionRef: RESUMED
        })
        assert.equal(missing.transcript, 'missing')
        assert.match(
            missing.warnings[0],
            new RegExp(`conversation=${RESUMED} not found`)
        )
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
})

test('the candidate list walks every conversation, newest first, named by its directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mf-agy-reader-'))
    try {
        for (const [id, name, mtime] of [
            [MULTITOOL, 'multitool.transcript_full.jsonl', 1_790_000_000],
            [RESUMED, 'resumed.transcript_full.jsonl', 1_790_000_100]
        ] as const) {
            const logs = logsOf(home, id)
            mkdirSync(logs, { recursive: true })
            const file = join(logs, 'transcript_full.jsonl')
            writeFileSync(file, fixture(name))
            writeFileSync(join(logs, 'transcript.jsonl'), fixture(name))
            utimesSync(file, mtime, mtime)
        }
        const listing = await new AntigravityCliSessionReader().listCandidates({
            fs: bashFs(home),
            agentId: 'agt_1'
        })
        // One row per conversation, though each keeps two logs.
        assert.equal(listing.total, 2)
        assert.deepEqual(
            listing.candidates.map((c) => c.sessionRef),
            [RESUMED, MULTITOOL]
        )
        const [resumed, multitool] = listing.candidates
        assert.equal(resumed.firstUserMessage, 'First turn.')
        assert.equal(
            resumed.lastAssistantMessage,
            'Hello from the stub (turn 4).'
        )
        assert.equal(resumed.timestamp, '2026-09-26T16:47:16Z')
        assert.equal(resumed.lastActiveAt, '2026-09-26T16:47:17Z')
        assert.equal(resumed.messageCount, 8)
        assert.equal(
            multitool.lastAssistantMessage,
            'All 3 tool calls finished.'
        )
        assert.ok(listing.filesByRef.has(MULTITOOL))
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
})

test('only a conversation log names a candidate', () => {
    assert.equal(
        antigravityRefFromPath(
            `/h/.gemini/antigravity-cli/brain/${MULTITOOL}/.system_generated/logs/transcript_full.jsonl`
        ),
        MULTITOOL
    )
    assert.equal(
        antigravityRefFromPath(`/h/brain/${MULTITOOL}/scratch/notes.jsonl`),
        null
    )
})
