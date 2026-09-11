import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
    PiSessionReader,
    parsePiJsonl,
    piRefFromPath
} from '../src/modules/chat/recovery/readers/pi-reader'

// session.jsonl is the file pi 0.85.1 wrote for the two fixture turns in
// pi-adapter.test.ts: header, model_change, thinking_level_change, then a
// user → assistant(text + toolCall) → toolResult → assistant → user →
// assistant chain, one entry per line, each naming its parent.
const sessionFixture = readFileSync(
    join(__dirname, 'fixtures', 'pi', 'session.jsonl'),
    'utf8'
)
const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

const FILE =
    '/home/sprite/.pi/agent/sessions/--home-sprite-work--/2026-09-10T22-48-27-032Z_11111111-2222-4333-8444-555555555555.jsonl'

test('piRefFromPath reads the session id out of the filename', () => {
    assert.equal(piRefFromPath(FILE), '11111111-2222-4333-8444-555555555555')
    assert.equal(
        piRefFromPath(
            '/x/sessions/--a--/2026-01-01T00-00-00-000Z_my.custom_id-1.jsonl'
        ),
        'my.custom_id-1'
    )
    assert.equal(piRefFromPath('/x/sessions/--a--/notes.txt'), null)
})

test('parsePiJsonl reads the real session file as three turns with the tool result folded into its assistant', () => {
    const { messages, warnings, lineCount } = parsePiJsonl(
        sessionFixture,
        FILE,
        '11111111-2222-4333-8444-555555555555'
    )
    assert.deepEqual(warnings, [])
    assert.equal(lineCount, 9)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant', 'assistant', 'user', 'assistant']
    )
    const [ask, callTurn, answer, ask2, answer2] = messages
    assert.deepEqual(ask.contentBlocks, [
        { type: 'text', text: 'list the files in this directory' }
    ])
    assert.equal(ask.timestamp, '2026-09-10T22:48:27.145Z', 'ms → ISO')
    assert.equal(callTurn.parentExternalId, ask.externalId)
    assert.deepEqual(
        callTurn.contentBlocks.map((b) => b.type),
        ['text', 'tool_call', 'tool_result']
    )
    const call = callTurn.contentBlocks[1]
    assert.ok(call.type === 'tool_call')
    assert.equal(call.toolCallId, 'toolu_stub_01')
    assert.equal(call.toolName, 'bash')
    assert.deepEqual(call.args, { command: 'ls' })
    const result = callTurn.contentBlocks[2]
    assert.ok(result.type === 'tool_result')
    assert.equal(result.toolCallId, 'toolu_stub_01')
    assert.equal(callTurn.model, 'anthropic/claude-sonnet-4-6')
    assert.equal(
        callTurn.sources.length,
        2,
        'the assistant line and its toolResult line both back the message'
    )
    assert.ok(
        callTurn.sources.every(
            (s) =>
                s.parserName === 'pi-session-jsonl' &&
                s.externalId === callTurn.externalId &&
                s.sourceFile === FILE
        )
    )
    assert.deepEqual(answer.contentBlocks, [
        { type: 'text', text: 'Done: there are two files here.' }
    ])
    assert.equal(ask2.contentBlocks[0].type, 'text')
    assert.equal(answer2.parentExternalId, ask2.externalId)
    // sourceSeq is the 1-based line number, the unit the runtime-sync cursor
    // would be kept in.
    assert.equal(ask.sources[0].sourceSeq, 4)
    assert.equal(answer2.sources[0].sourceSeq, 9)
})

test('parsePiJsonl follows the leaf path and leaves an abandoned branch out', () => {
    const text =
        LINE({
            type: 'session',
            version: 3,
            id: 's1',
            timestamp: 't',
            cwd: '/w'
        }) +
        LINE({
            type: 'message',
            id: 'u1',
            parentId: null,
            timestamp: '2026-09-10T00:00:01.000Z',
            message: { role: 'user', content: 'first', timestamp: 1 }
        }) +
        LINE({
            type: 'message',
            id: 'a1',
            parentId: 'u1',
            timestamp: '2026-09-10T00:00:02.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'abandoned answer' }],
                model: 'm',
                provider: 'anthropic',
                timestamp: 2
            }
        }) +
        LINE({
            type: 'label',
            id: 'l1',
            parentId: 'a1',
            timestamp: 't',
            targetId: 'a1',
            label: 'x'
        }) +
        // A branch off u1: the user edited and pi appended the new path.
        LINE({
            type: 'message',
            id: 'a2',
            parentId: 'u1',
            timestamp: '2026-09-10T00:00:03.000Z',
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'hmm', redacted: false },
                    { type: 'text', text: 'kept answer' }
                ],
                model: 'm2',
                provider: 'openai',
                timestamp: 3
            }
        })
    const { messages, warnings } = parsePiJsonl(text, '/f', 's1')
    assert.deepEqual(warnings, [])
    assert.deepEqual(
        messages.map((m) => m.contentBlocks.map((b) => b.type)),
        [['text'], ['thinking', 'text']]
    )
    assert.equal(messages[1].externalId, 'a2')
    assert.equal(messages[1].model, 'openai/m2')
    assert.ok(
        !JSON.stringify(messages).includes('abandoned answer'),
        'the entry the leaf path does not reach is not a message'
    )
})

test('parsePiJsonl reports a header mismatch and a bad line without giving up', () => {
    const text =
        LINE({ type: 'session', version: 3, id: 'other', cwd: '/w' }) +
        'not json\n' +
        LINE({
            type: 'message',
            id: 'u1',
            parentId: null,
            timestamp: '2026-09-10T00:00:01.000Z',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
        })
    const { messages, warnings } = parsePiJsonl(text, '/f', 's1')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].timestamp, '2026-09-10T00:00:01.000Z')
    assert.match(warnings.join('\n'), /line 2: parse error/)
    assert.match(warnings.join('\n'), /header id other differs from ref s1/)
})

const scanRecord = (record: {
    path: string
    mtimeSec: number
    size: number
    lineCount: number
    headText: string
}): string =>
    `-----MF-RECOVERY-CANDIDATE-----\t${record.path}\t${record.mtimeSec}\t${record.size}\t${record.lineCount}\n${record.headText}\n`

test('listCandidates walks every cwd dir, summarizes from the header and names the id from the filename', async () => {
    const scripts: string[] = []
    const fs = {
        locate: async () => null,
        listFiles: async () => [],
        readFile: async () => null,
        readBinary: async () => null,
        exec: async (script: string) => {
            scripts.push(script)
            if (script.includes('xargs -0 stat'))
                return `1789080507 ${sessionFixture.length} ${FILE}\n`
            return scanRecord({
                path: FILE,
                mtimeSec: 1789080507,
                size: sessionFixture.length,
                lineCount: 9,
                headText: sessionFixture
            })
        }
    }
    const reader = new PiSessionReader()
    const listing = await reader.listCandidates({ fs, agentId: 'agt_1' })
    assert.match(
        scripts[0],
        /find "\$\{PI_CODING_AGENT_DIR:-\$HOME\/\.pi\/agent\}"\/sessions -type f -name '\*\.jsonl'/
    )
    assert.equal(listing.total, 1)
    assert.equal(listing.candidates.length, 1)
    const [row] = listing.candidates
    assert.equal(row.sessionRef, '11111111-2222-4333-8444-555555555555')
    assert.equal(row.sourceFile, FILE)
    assert.equal(row.firstUserMessage, 'list the files in this directory')
    assert.equal(row.lastAssistantMessage, 'Resumed reply: yes, I remember.')
    assert.equal(row.timestamp, '2026-09-10T22:48:27.032Z')
    // The message's own clock (Unix ms), not the entry's write time.
    assert.equal(row.lastActiveAt, '2026-09-10T22:48:27.437Z')
    assert.equal(row.messageCount, 5)
    assert.equal(row.model, 'anthropic/claude-sonnet-4-6')
    assert.ok(listing.filesByRef.has('11111111-2222-4333-8444-555555555555'))
})

test('readMessages locates the file by the id in its name and reports a missing one', async () => {
    const located: string[] = []
    const fs = {
        locate: async (script: string) => {
            located.push(script)
            return script.includes('*_s-present.jsonl')
                ? '/f/x_s-present.jsonl'
                : null
        },
        listFiles: async () => [],
        exec: async () => null,
        readFile: async () => sessionFixture,
        readBinary: async () => null
    }
    const reader = new PiSessionReader()
    const found = await reader.readMessages({
        fs,
        agentId: 'agt_1',
        frameworkSessionRef: 's-present'
    })
    assert.equal(found.sourceFile, '/f/x_s-present.jsonl')
    assert.equal(found.messages.length, 5)
    assert.match(
        located[0],
        /-name '\*_s-present\.jsonl' 2>\/dev\/null \| head -1/
    )
    const missing = await reader.readMessages({
        fs,
        agentId: 'agt_1',
        frameworkSessionRef: 's-absent'
    })
    assert.equal(missing.sourceFile, null)
    assert.match(missing.warnings[0], /session=s-absent not found/)
})
