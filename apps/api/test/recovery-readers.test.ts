import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ClaudeCodeSessionReader,
    parseClaudeJsonl
} from '../src/modules/chat/recovery/readers/claude-code-reader'
import {
    CodexSessionReader,
    codexRefFromPath,
    parseCodexJsonl
} from '../src/modules/chat/recovery/readers/codex-reader'
import {
    GeminiCliSessionReader,
    geminiReaderLocateScript,
    parseGeminiJson,
    parseGeminiJsonl
} from '../src/modules/chat/recovery/readers/gemini-reader'
import {
    OpenclawSessionReader,
    parseHistoryResponse,
    parseOpenclawJsonl
} from '../src/modules/chat/recovery/readers/openclaw-reader'
import { parseHermesJson } from '../src/modules/chat/recovery/readers/hermes-reader'
import {
    CANDIDATE_FETCH_LIMIT,
    candidateFetchScript,
    candidateIndexScript,
    candidateTailLines,
    parseCandidateIndex,
    parseCandidateScan,
    scanCandidates,
    type CandidateFileHead
} from '../src/modules/chat/recovery/readers/candidate-scan'
import { CandidateScanCache } from '../src/modules/chat/recovery/readers/candidate-scan-cache'
import {
    claudeRefFromPath,
    claudeSessionLocateScript
} from '../src/modules/chat/recovery/readers/claude-code-reader'

const formatCandidateScanRecord = (record: {
    path: string
    mtimeSec: number
    size: number
    lineCount: number
    headText: string
    tailText?: string
}): string =>
    `-----MF-RECOVERY-CANDIDATE-----\t${record.path}\t${record.mtimeSec}\t${record.size}\t${record.lineCount}\n${record.headText}\n` +
    (record.tailText === undefined
        ? ''
        : `-----MF-RECOVERY-CANDIDATE-TAIL-----\t${record.path}\n${record.tailText}\n`)

test('parseClaudeJsonl skips system/snapshot rows and keeps user/assistant', () => {
    const lines = [
        JSON.stringify({
            type: 'permission-mode',
            permissionMode: 'plan',
            sessionId: 'sess-1'
        }),
        JSON.stringify({
            type: 'file-history-snapshot',
            messageId: 'm0',
            snapshot: {},
            sessionId: 'sess-1'
        }),
        JSON.stringify({
            uuid: 'u1',
            parentUuid: null,
            sessionId: 'sess-1',
            type: 'user',
            timestamp: '2026-04-27T16:20:50.422Z',
            message: { role: 'user', content: 'hi there' }
        }),
        JSON.stringify({
            uuid: 'u2',
            parentUuid: 'u1',
            sessionId: 'sess-1',
            type: 'assistant',
            timestamp: '2026-04-27T16:20:51.000Z',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'hello' },
                    {
                        type: 'tool_use',
                        id: 'tu_1',
                        name: 'bash',
                        input: { cmd: 'ls' }
                    }
                ]
            }
        }),
        JSON.stringify({
            uuid: 'u3',
            parentUuid: 'u2',
            sessionId: 'sess-1',
            type: 'user',
            timestamp: '2026-04-27T16:20:52.000Z',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tu_1',
                        content: 'file1\nfile2'
                    }
                ]
            }
        })
    ].join('\n')

    const { messages, warnings } = parseClaudeJsonl(lines, 'sess-1')
    assert.equal(messages.length, 2)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant']
    )
    assert.equal(messages[0].externalId, 'u1')
    assert.equal(messages[0].sources[0].rawFormat, 'jsonl')
    assert.match(messages[0].sources[0].rawText ?? '', /"uuid":"u1"/)
    assert.equal(messages[0].contentBlocks[0].type, 'text')
    const asst = messages[1]
    assert.equal(asst.contentBlocks.length, 3)
    assert.equal(asst.contentBlocks[0].type, 'text')
    assert.equal(asst.contentBlocks[1].type, 'tool_call')
    assert.equal(asst.contentBlocks[2].type, 'tool_result')
    assert.equal(asst.sources.length, 2)
    assert.equal(warnings.length, 0)
})

test('parseClaudeJsonl filters lines from other sessions', () => {
    const lines = [
        JSON.stringify({
            uuid: 'u1',
            sessionId: 'other',
            type: 'user',
            timestamp: '2026-04-27T16:20:50.422Z',
            message: { role: 'user', content: 'should be skipped' }
        }),
        JSON.stringify({
            uuid: 'u2',
            sessionId: 'mine',
            type: 'user',
            timestamp: '2026-04-27T16:20:51.000Z',
            message: { role: 'user', content: 'kept' }
        })
    ].join('\n')

    const { messages } = parseClaudeJsonl(lines, 'mine')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].externalId, 'u2')
})

test('parseClaudeJsonl reports JSON parse errors as warnings without aborting', () => {
    const lines = [
        '{ not valid json',
        JSON.stringify({
            uuid: 'u1',
            sessionId: 'mine',
            type: 'user',
            timestamp: '2026-04-27T16:20:50.422Z',
            message: { role: 'user', content: 'good' }
        })
    ].join('\n')

    const { messages, warnings } = parseClaudeJsonl(lines, 'mine')
    assert.equal(messages.length, 1)
    assert.equal(warnings.length, 1)
})

test('parseCodexJsonl groups assistant text + tool calls into one message per turn', () => {
    const lines = [
        JSON.stringify({
            timestamp: '2026-04-26T15:52:48.040Z',
            type: 'session_meta',
            payload: { id: 'thread-1' }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:49.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'system noise' }]
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:50.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'find files' }]
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:55.641Z',
            type: 'response_item',
            model: 'gpt-5.4',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'I will search.' }]
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:55.642Z',
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'exec_command',
                arguments: '{"cmd":"ls"}',
                call_id: 'call_1'
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:55.700Z',
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'call_1',
                output: 'a.txt\nb.txt'
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:56.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'good' }]
            }
        })
    ].join('\n')

    const { messages } = parseCodexJsonl(lines)
    assert.equal(messages.length, 3)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant', 'user']
    )
    const asst = messages[1]
    assert.equal(asst.contentBlocks.length, 3)
    assert.equal(asst.model, 'gpt-5.4')
    assert.equal(messages[0].model, undefined)
    assert.equal(asst.contentBlocks[0].type, 'text')
    assert.equal(asst.contentBlocks[1].type, 'tool_call')
    if (asst.contentBlocks[1].type !== 'tool_call')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[1].toolCallId, 'call_1')
    assert.deepEqual(asst.contentBlocks[1].args, { cmd: 'ls' })
    assert.equal(asst.contentBlocks[2].type, 'tool_result')
    if (asst.contentBlocks[2].type !== 'tool_result')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[2].result, 'a.txt\nb.txt')
    assert.equal(asst.sources.length, 3)
    assert.equal(asst.sources[0].parserName, 'codex-session-jsonl')
})

test('parseCodexJsonl flushes pending assistant at EOF when no closing user message', () => {
    const lines = [
        JSON.stringify({
            timestamp: '2026-04-26T15:52:50.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'q' }]
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:55.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'a' }]
            }
        })
    ].join('\n')

    const { messages } = parseCodexJsonl(lines)
    assert.equal(messages.length, 2)
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].contentBlocks[0].type, 'text')
})

test('parseCodexJsonl uses config fallback model for assistant messages only', () => {
    const lines = [
        JSON.stringify({
            timestamp: '2026-04-26T15:52:50.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'q' }]
            }
        }),
        JSON.stringify({
            timestamp: '2026-04-26T15:52:55.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'a' }]
            }
        })
    ].join('\n')

    const { messages } = parseCodexJsonl(lines, null, null, 'gpt-5.4')

    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].model, undefined)
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].model, 'gpt-5.4')
})

test('parseGeminiJson maps user/gemini and skips info entries', () => {
    const blob = JSON.stringify({
        sessionId: 'sess-1',
        startTime: '2026-03-23T22:29:35.000Z',
        messages: [
            {
                id: 'm1',
                type: 'info',
                content: 'bootup',
                timestamp: '2026-03-23T22:29:35.000Z'
            },
            {
                id: 'm2',
                type: 'user',
                content: [{ text: 'hello' }],
                timestamp: '2026-03-23T22:29:36.000Z'
            },
            {
                id: 'm3',
                type: 'gemini',
                content: 'hi back',
                timestamp: '2026-03-23T22:29:40.000Z',
                thoughts: [{ subject: 'plan', description: 'do it' }],
                toolCalls: [
                    {
                        id: 'tc1',
                        name: 'read_file',
                        args: { path: 'foo' },
                        result: [
                            {
                                functionResponse: {
                                    response: { output: 'CONTENT' }
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    })

    const { messages } = parseGeminiJson(blob)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].contentBlocks[0].type, 'text')
    const asst = messages[1]
    assert.equal(asst.role, 'assistant')
    assert.equal(asst.parentExternalId, 'm2')
    const types = asst.contentBlocks.map((b) => b.type)
    assert.deepEqual(types, ['thinking', 'text', 'tool_call', 'tool_result'])
    assert.equal(asst.sources[0].rawFormat, 'json')
    assert.deepEqual(asst.sources[0].rawJson, {
        id: 'm3',
        type: 'gemini',
        content: 'hi back',
        timestamp: '2026-03-23T22:29:40.000Z',
        thoughts: [{ subject: 'plan', description: 'do it' }],
        toolCalls: [
            {
                id: 'tc1',
                name: 'read_file',
                args: { path: 'foo' },
                result: [
                    {
                        functionResponse: {
                            response: { output: 'CONTENT' }
                        }
                    }
                ]
            }
        ]
    })
    if (asst.contentBlocks[3].type !== 'tool_result')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[3].result, 'CONTENT')
})

test('parseGeminiJson reports parse error as warning, not throw', () => {
    const { messages, warnings } = parseGeminiJson('not json')
    assert.equal(messages.length, 0)
    assert.equal(warnings.length, 1)
})

test('parseOpenclawJsonl groups assistant text + toolCalls + toolResults into one message per turn', () => {
    const lines = [
        JSON.stringify({
            type: 'session',
            id: 'sess-1',
            timestamp: '2026-04-27T20:47:18.123Z'
        }),
        JSON.stringify({ type: 'model_change', id: 'mc-1' }),
        JSON.stringify({
            type: 'message',
            id: 'u1',
            timestamp: '2026-04-27T20:47:19.000Z',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'hi how are you' }]
            }
        }),
        JSON.stringify({
            type: 'message',
            id: 'a1',
            parentId: 'u1',
            timestamp: '2026-04-27T20:47:22.860Z',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1',
                        name: 'read',
                        arguments: { path: '/foo' }
                    }
                ]
            }
        }),
        JSON.stringify({
            type: 'message',
            id: 'tr1',
            parentId: 'a1',
            timestamp: '2026-04-27T20:47:22.869Z',
            message: {
                role: 'toolResult',
                toolCallId: 'call_1',
                toolName: 'read',
                content: [{ type: 'text', text: 'file content' }]
            }
        }),
        JSON.stringify({
            type: 'message',
            id: 'a2',
            parentId: 'tr1',
            timestamp: '2026-04-27T20:47:30.000Z',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: "I'm well, here's what I found." }
                ]
            }
        }),
        JSON.stringify({
            type: 'message',
            id: 'u2',
            timestamp: '2026-04-27T20:48:00.000Z',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'thanks' }]
            }
        })
    ].join('\n')

    const { messages } = parseOpenclawJsonl(lines)
    assert.equal(messages.length, 3)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant', 'user']
    )
    const asst = messages[1]
    const types = asst.contentBlocks.map((b) => b.type)
    assert.deepEqual(types, ['tool_call', 'tool_result', 'text'])
    if (asst.contentBlocks[0].type !== 'tool_call')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[0].toolCallId, 'call_1')
    if (asst.contentBlocks[1].type !== 'tool_result')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[1].result, 'file content')
    assert.equal(asst.sources.length, 3)
    assert.equal(asst.sources[0].rawFormat, 'jsonl')
})

test('parseOpenclawJsonl skips meta event types (session/model_change/custom)', () => {
    const lines = [
        JSON.stringify({ type: 'session', id: 'sess-1' }),
        JSON.stringify({ type: 'model_change', id: 'mc' }),
        JSON.stringify({ type: 'thinking_level_change', id: 'tl' }),
        JSON.stringify({ type: 'custom', id: 'c1' }),
        JSON.stringify({
            type: 'message',
            id: 'u1',
            timestamp: '2026-04-27T20:47:19.000Z',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'hello' }]
            }
        })
    ].join('\n')
    const { messages } = parseOpenclawJsonl(lines)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
})

test('parseHermesJson maps user/assistant + tool_calls + tool messages', () => {
    const blob = JSON.stringify({
        session_id: 'api-abc',
        session_start: '2026-04-27T20:45:43.266058',
        messages: [
            { role: 'user', content: 'hi, how are you' },
            { role: 'user', content: 'hi, how are you' }, // duplicate dropped
            {
                role: 'assistant',
                content: 'I will read the file.',
                tool_calls: [
                    {
                        id: 'tc1',
                        type: 'function',
                        function: {
                            name: 'read_file',
                            arguments: '{"path":"foo"}'
                        }
                    }
                ]
            },
            { role: 'tool', tool_call_id: 'tc1', content: 'CONTENT' },
            { role: 'assistant', content: 'Done.', finish_reason: 'stop' }
        ]
    })
    const { messages } = parseHermesJson(blob)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant']
    )
    const asst = messages[1]
    const types = asst.contentBlocks.map((b) => b.type)
    assert.deepEqual(types, ['text', 'tool_call', 'tool_result', 'text'])
    if (asst.contentBlocks[1].type !== 'tool_call')
        throw new Error('unreachable')
    assert.deepEqual(asst.contentBlocks[1].args, { path: 'foo' })
    if (asst.contentBlocks[2].type !== 'tool_result')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[2].result, 'CONTENT')
    assert.equal(asst.sources.length, 3)
    assert.equal(asst.sources[0].rawFormat, 'json')
})

test('parseHermesJson handles plain text-only conversation', () => {
    const blob = JSON.stringify({
        session_id: 'api-abc',
        messages: [
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: 'a',
                finish_reason: 'stop'
            }
        ]
    })
    const { messages } = parseHermesJson(blob)
    assert.equal(messages.length, 2)
    assert.equal(messages[1].contentBlocks[0].type, 'text')
})

test('parseHistoryResponse maps OpenAI-style history with tool_calls', () => {
    const payload = [
        {
            role: 'user',
            content: 'find files',
            timestamp: '2026-04-27T10:00:00Z'
        },
        {
            role: 'assistant',
            content: "I'll search.",
            timestamp: '2026-04-27T10:00:01Z',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: {
                        name: 'search',
                        arguments: '{"q":"foo"}'
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'a.txt\nb.txt',
            timestamp: '2026-04-27T10:00:02Z'
        },
        {
            role: 'assistant',
            content: 'Done.',
            timestamp: '2026-04-27T10:00:03Z'
        }
    ]
    const { messages, warnings } = parseHistoryResponse(payload)
    assert.equal(messages.length, 2)
    assert.deepEqual(
        messages.map((m) => m.role),
        ['user', 'assistant']
    )
    const asst = messages[1]
    const types = asst.contentBlocks.map((b) => b.type)
    assert.deepEqual(types, ['text', 'tool_call', 'tool_result', 'text'])
    if (asst.contentBlocks[1].type !== 'tool_call')
        throw new Error('unreachable')
    assert.deepEqual(asst.contentBlocks[1].args, { q: 'foo' })
    if (asst.contentBlocks[2].type !== 'tool_result')
        throw new Error('unreachable')
    assert.equal(asst.contentBlocks[2].result, 'a.txt\nb.txt')
    assert.equal(asst.sources.length, 3)
    assert.equal(asst.sources[0].rawFormat, 'json')
    assert.equal(warnings.length, 0)
})

test('parseHistoryResponse accepts {messages: [...]} envelope', () => {
    const { messages } = parseHistoryResponse({
        messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' }
        ]
    })
    assert.equal(messages.length, 2)
})

test('readHermesSqliteSession walks parent_session_id chain and surfaces reasoning + tool_calls', async () => {
    const Database = (
        (await import('better-sqlite3')) as unknown as {
            default: new (path: string) => {
                exec: (sql: string) => void
                prepare: (sql: string) => {
                    run: (...args: unknown[]) => unknown
                }
                close: () => void
            }
        }
    ).default
    const { readHermesSqliteSession } =
        await import('../src/modules/chat/recovery/readers/hermes-sqlite-reader')
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'nca-sqlite-test-'))
    const dbPath = join(dir, 'state.db')
    const db = new Database(dbPath)
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            parent_session_id TEXT,
            started_at REAL,
            ended_at REAL,
            end_reason TEXT,
            title TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            estimated_cost_usd REAL,
            actual_cost_usd REAL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            role TEXT,
            content TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            tool_name TEXT,
            timestamp REAL,
            reasoning TEXT,
            reasoning_content TEXT
        );
    `)
    const insertSession = db.prepare(
        `INSERT INTO sessions (id, parent_session_id, started_at, ended_at,
         end_reason, title, input_tokens, output_tokens, estimated_cost_usd, actual_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insertSession.run(
        'sess-root',
        null,
        1700000000,
        1700000100,
        'compression',
        'first segment',
        100,
        50,
        0.001,
        null
    )
    insertSession.run(
        'sess-target',
        'sess-root',
        1700000200,
        null,
        null,
        'continued',
        80,
        40,
        0.002,
        null
    )
    const insertMsg = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls,
         tool_name, timestamp, reasoning, reasoning_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insertMsg.run(
        1,
        'sess-root',
        'user',
        'old question',
        null,
        null,
        null,
        1700000010,
        null,
        null
    )
    insertMsg.run(
        2,
        'sess-root',
        'assistant',
        'old answer',
        null,
        null,
        null,
        1700000020,
        null,
        null
    )
    insertMsg.run(
        3,
        'sess-target',
        'user',
        'new question',
        null,
        null,
        null,
        1700000210,
        null,
        null
    )
    insertMsg.run(
        4,
        'sess-target',
        'assistant',
        'thinking it through',
        null,
        JSON.stringify([
            {
                id: 'call_a',
                function: { name: 'search', arguments: '{"q":"x"}' }
            }
        ]),
        null,
        1700000220,
        null,
        'I will search first.'
    )
    insertMsg.run(
        5,
        'sess-target',
        'tool',
        'search result body',
        'call_a',
        null,
        'search',
        1700000225,
        null,
        null
    )
    db.close()

    const buf = readFileSync(dbPath)
    const fs = {
        locate: async (): Promise<string> => dbPath,
        listFiles: async (): Promise<string[]> => [],
        exec: async (): Promise<string | null> => null,
        readFile: async (): Promise<string | null> => null,
        // Path-aware: this fixture is not in WAL mode, so the -wal sidecar the
        // reader now also asks for genuinely does not exist.
        readBinary: async (p: string): Promise<Buffer | null> =>
            p === dbPath ? buf : null
    }

    const result = await readHermesSqliteSession(fs, 'sess-target')
    rmSync(dir, { recursive: true, force: true })

    assert.ok(result, 'reader should return a result')
    assert.equal(result!.sourceFile, dbPath)
    assert.equal(result!.warnings.length, 0)
    // Two segments: root (user+assistant) + target (user+assistant+tool)
    const roles = result!.messages.map((m) => m.role)
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant'])
    const lastAssistant = result!.messages[3]
    const blocks = lastAssistant.contentBlocks
    // Expect: thinking → text → tool_call → tool_result, all merged
    assert.equal(blocks[0].type, 'thinking')
    if (blocks[0].type !== 'thinking') throw new Error('unreachable')
    assert.equal(blocks[0].text, 'I will search first.')
    assert.equal(blocks[1].type, 'text')
    if (blocks[1].type !== 'text') throw new Error('unreachable')
    assert.equal(blocks[1].text, 'thinking it through')
    assert.equal(blocks[2].type, 'tool_call')
    if (blocks[2].type !== 'tool_call') throw new Error('unreachable')
    assert.equal(blocks[2].toolName, 'search')
    assert.deepEqual(blocks[2].args, { q: 'x' })
    assert.equal(blocks[3].type, 'tool_result')
    if (blocks[3].type !== 'tool_result') throw new Error('unreachable')
    assert.equal(blocks[3].toolCallId, 'call_a')
    assert.equal(lastAssistant.sources.length, 2)
    assert.equal(lastAssistant.sources[0].rawFormat, 'sqlite_row')

    // Summary aggregates tokens across the chain and exposes the parent link
    assert.ok(result!.summary)
    assert.equal(result!.summary!.inputTokens, 180)
    assert.equal(result!.summary!.outputTokens, 90)
    assert.equal(result!.summary!.parentChain.length, 1)
    assert.equal(result!.summary!.parentChain[0].sessionId, 'sess-root')
    assert.equal(result!.summary!.parentChain[0].endReason, 'compressed')
})

// Reproduces the real sprite state: hermes keeps sqlite in WAL mode and never
// checkpoints, so the main state.db can hold ZERO tables while the schema and
// every row live in the -wal sidecar (measured on a live agent: main file 4 KiB
// / 0 tables, -wal 1 MiB / 6 messages). Reading state.db alone therefore made
// every hermes session import come back empty. This pins that the reader now
// materializes the sidecar too — and that without it there is nothing to read.
test('readHermesSqliteSession reads rows that are still in the -wal sidecar', async () => {
    const Database = (
        (await import('better-sqlite3')) as unknown as {
            default: new (path: string) => {
                exec: (sql: string) => void
                pragma: (sql: string) => unknown
                prepare: (sql: string) => { run: (...a: unknown[]) => unknown }
                close: () => void
            }
        }
    ).default
    const { readHermesSqliteSession } = await import(
        '../src/modules/chat/recovery/readers/hermes-sqlite-reader'
    )
    const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'nca-hermes-wal-'))
    const dbPath = join(dir, 'state.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL,
            ended_at REAL, end_reason TEXT, title TEXT, input_tokens INTEGER,
            output_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
            tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
            reasoning TEXT, reasoning_content TEXT
        );
    `)
    db.prepare(
        'INSERT INTO sessions (id, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?)'
    ).run('api-wal-1', 1700000000, 10, 20)
    db.prepare(
        'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'api-wal-1', 'user', 'why is blue calming?', 1700000001)
    db.prepare(
        'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(2, 'api-wal-1', 'assistant', 'Because of sky and water.', 1700000002)

    // Snapshot the files while the connection is OPEN — close() would
    // checkpoint the WAL into the main db and hide the very bug under test.
    const mainBuf = readFileSync(dbPath)
    const walPath = `${dbPath}-wal`
    assert.ok(existsSync(walPath), 'fixture should have a -wal sidecar')
    const walBuf = readFileSync(walPath)
    db.close()

    const mkFs = (withWal: boolean) => ({
        locate: async (): Promise<string> => dbPath,
        listFiles: async (): Promise<string[]> => [],
        exec: async (): Promise<string | null> => null,
        readFile: async (): Promise<string | null> => null,
        readBinary: async (p: string): Promise<Buffer | null> =>
            p === dbPath ? mainBuf : withWal && p === walPath ? walBuf : null
    })

    const recovered = await readHermesSqliteSession(mkFs(true), 'api-wal-1')
    assert.ok(recovered, 'reader should return a result when the -wal is present')
    assert.equal(recovered!.warnings.length, 0)
    assert.deepEqual(
        recovered!.messages.map((m) => m.role),
        ['user', 'assistant']
    )

    // Same bytes minus the sidecar = the old behaviour: the copy has no schema
    // at all, so the reader could not even query it (it threw SQLITE_ERROR
    // "no such table: sessions" rather than returning an empty result).
    let withoutWal: Awaited<ReturnType<typeof readHermesSqliteSession>> | 'threw'
    try {
        withoutWal = await readHermesSqliteSession(mkFs(false), 'api-wal-1')
    } catch {
        withoutWal = 'threw'
    }
    assert.ok(
        withoutWal === 'threw' ||
            withoutWal === null ||
            withoutWal.messages.length === 0,
        'without the -wal sidecar there is nothing to recover'
    )
    rmSync(dir, { recursive: true, force: true })
})

// gemini-cli ≥0.45 append-only .jsonl: metadata line, $set patches (incl. the
// bulk session_context message), and message snapshots re-appended per id as
// they gain content (last record wins). Modeled on a real captured session.
const geminiJsonlBlob = (): string =>
    [
        {
            sessionId: 'sess-jl-1',
            projectHash: 'hash',
            startTime: '2026-07-24T13:48:44.717Z',
            lastUpdated: '2026-07-24T13:48:44.717Z',
            kind: 'main'
        },
        {
            $set: {
                messages: [
                    {
                        id: 'ctx1',
                        timestamp: '2026-07-24T13:48:44.717Z',
                        type: 'user',
                        content: [{ text: '<session_context>\nplumbing</session_context>' }]
                    }
                ],
                lastUpdated: '2026-07-24T13:48:44.717Z'
            }
        },
        {
            id: 'u1',
            timestamp: '2026-07-24T13:48:44.738Z',
            type: 'user',
            content: [{ text: 'why is blue calming?' }]
        },
        { $set: { lastUpdated: '2026-07-24T13:48:44.738Z' } },
        {
            id: 'g1',
            timestamp: '2026-07-24T13:48:47.000Z',
            type: 'gemini',
            content: 'partial…'
        },
        {
            id: 'g1',
            timestamp: '2026-07-24T13:48:52.000Z',
            type: 'gemini',
            content: 'Blue is calming because…',
            model: 'gemini-2.5-flash',
            thoughts: [{ subject: 'plan', description: 'answer briefly' }],
            tokens: { input: 10, output: 5, cached: 0 },
            toolCalls: [
                {
                    id: 'tc1',
                    name: 'read_file',
                    args: { path: 'notes.md' },
                    result: [
                        { functionResponse: { response: { output: 'NOTES' } } }
                    ]
                }
            ]
        }
    ]
        .map((r) => JSON.stringify(r))
        .join('\n')

test('parseGeminiJsonl reconstructs last-wins, skips session_context, maps blocks', () => {
    const { messages, warnings } = parseGeminiJsonl(geminiJsonlBlob(), '/x/session-a.jsonl')
    assert.equal(warnings.length, 0)
    assert.equal(messages.length, 2)
    const [user, asst] = messages
    assert.equal(user.role, 'user')
    assert.equal(user.externalId, 'u1')
    assert.equal(user.contentBlocks[0].type, 'text')
    assert.equal(asst.role, 'assistant')
    assert.equal(asst.externalId, 'g1')
    assert.equal(asst.parentExternalId, 'u1')
    assert.equal(asst.model, 'gemini-2.5-flash')
    const types = asst.contentBlocks.map((b) => b.type)
    assert.deepEqual(types, ['thinking', 'text', 'tool_call', 'tool_result'])
    const textBlock = asst.contentBlocks[1]
    if (textBlock.type !== 'text') throw new Error('unreachable')
    assert.equal(textBlock.text, 'Blue is calming because…')
    const src = asst.sources[0]
    assert.equal(src.rawFormat, 'jsonl')
    assert.equal(src.sourceRef, 'sess-jl-1')
    assert.equal(src.sourceSeq, 6)
    assert.equal(src.parserName, 'gemini-session-jsonl')
    assert.ok(src.rawText?.includes('Blue is calming'))
})

test('gemini listCandidates dispatches .jsonl summaries and skips session_context', async () => {
    const reader = new GeminiCliSessionReader()
    const fs = scanFs({
        '/h/.gemini/tmp/a/chats/session-2026-07-24T13-48-sessjl1.jsonl': {
            head: geminiJsonlBlob()
        },
        '/h/.gemini/tmp/b/chats/session-old.json': {
            head: JSON.stringify({
                sessionId: 'sess-old-1',
                startTime: '2026-01-01T00:00:00.000Z',
                messages: [
                    { id: 'm1', type: 'user', content: 'old question' },
                    { id: 'm2', type: 'gemini', content: 'old answer' }
                ]
            })
        }
    })
    const { candidates } = await reader.listCandidates({ fs, agentId: 'agt' })
    assert.equal(candidates.length, 2)
    const jl = candidates.find((c) => c.sessionRef === 'sess-jl-1')
    assert.ok(jl)
    assert.equal(jl!.firstUserMessage, 'why is blue calming?')
    assert.equal(jl!.messageCount, 2)
    assert.equal(jl!.timestamp, '2026-07-24T13:48:44.717Z')
    // Last-wins: the superseded 'partial…' record must not become the reply.
    assert.equal(jl!.lastAssistantMessage, 'Blue is calming because…')
    assert.equal(jl!.lastActiveAt, '2026-07-24T13:48:52.000Z')
    assert.equal(jl!.model, 'gemini-2.5-flash')
    const old = candidates.find((c) => c.sessionRef === 'sess-old-1')
    assert.ok(old)
    assert.equal(old!.firstUserMessage, 'old question')
    assert.equal(old!.lastAssistantMessage, 'old answer')
    // The legacy whole-file format records no per-message model.
    assert.equal(old!.model, null)
})

// Executed via bash -lc (the same invocation RecoveryFs.locate uses): string
// assertions cannot catch quoting bugs in generated shell scripts.
test('gemini reader locate script finds new .jsonl by metadata and legacy .json by filename', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'gemini-reader-locate-'))
    const chats = join(home, '.gemini', 'tmp', 'hash', 'chats')
    mkdirSync(chats, { recursive: true })
    const legacyRef = '11111111-2222-3333-4444-555555555555'
    const legacy = join(chats, `session-${legacyRef}.json`)
    writeFileSync(legacy, JSON.stringify({ sessionId: legacyRef, messages: [] }))
    const newRef = 'dc52d624-311a-4664-93a9-9520e2b1ff31'
    const target = join(chats, 'session-2026-07-24T12-27-dc52d624.jsonl')
    writeFileSync(target, JSON.stringify({ sessionId: newRef, kind: 'main' }) + '\n')

    const run = (ref: string): string => {
        const res = spawnSync('bash', ['-lc', geminiReaderLocateScript(ref)], {
            env: { ...process.env, HOME: home },
            encoding: 'utf8'
        })
        return (
            res.stdout.split('\n').find((l: string) => l.trim().length > 0) ?? ''
        ).trim()
    }

    assert.equal(run(newRef), target)
    assert.equal(run(legacyRef), legacy)
    assert.equal(run('00000000-0000-0000-0000-000000000000'), '')
    rmSync(home, { recursive: true, force: true })
})

test('claude locate script prefers the filename match and greps as a fixed string', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'claude-reader-locate-'))
    const project = join(home, '.claude', 'projects', 'proj-a')
    mkdirSync(project, { recursive: true })
    const namedRef = 'aaaaaaaa-1111-2222-3333-444444444444'
    const named = join(project, `${namedRef}.jsonl`)
    writeFileSync(named, JSON.stringify({ sessionId: namedRef }) + '\n')
    const forkedRef = 'bbbbbbbb-1111-2222-3333-444444444444'
    const forked = join(project, `${namedRef.replace('aaaa', 'cccc')}.jsonl`)
    writeFileSync(
        forked,
        JSON.stringify({ sessionId: forkedRef, type: 'user' }) + '\n'
    )

    const run = (ref: string): string => {
        const res = spawnSync('bash', ['-lc', claudeSessionLocateScript(ref)], {
            env: { ...process.env, HOME: home },
            encoding: 'utf8'
        })
        return (
            res.stdout.split('\n').find((l: string) => l.trim().length > 0) ?? ''
        ).trim()
    }

    assert.equal(run(namedRef), named)
    assert.equal(run(forkedRef), forked)
    // A ref carrying regex metacharacters must not match as a pattern.
    assert.equal(run('.*'), '')
    rmSync(home, { recursive: true, force: true })
})

// A real bash run is the only thing that can show the batched stat works on
// both stat dialects (BSD locally, GNU in CI), keeps a path with spaces whole,
// sorts newest first, and answers an empty tree with nothing.
test('candidate index lists every transcript newest first in one stat call', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } =
        await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'candidate-index-'))
    const dir = join(home, '.claude', 'projects', 'proj a')
    mkdirSync(dir, { recursive: true })
    const older = join(dir, 'older one.jsonl')
    writeFileSync(older, 'line-1\nline-2\n')
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    const newer = join(dir, 'newer.jsonl')
    writeFileSync(newer, 'x'.repeat(1001))
    utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))

    const script = candidateIndexScript(
        `find "$HOME"/.claude/projects -type f -name '*.jsonl'`
    )
    const run = (h: string) =>
        spawnSync('bash', ['-lc', script], {
            env: { ...process.env, HOME: h },
            encoding: 'utf8'
        })
    assert.deepEqual(parseCandidateIndex(run(home).stdout), [
        { path: newer, mtimeMs: Date.parse('2026-02-01T00:00:00Z'), size: 1001 },
        { path: older, mtimeMs: Date.parse('2026-01-01T00:00:00Z'), size: 14 }
    ])

    const empty = mkdtempSync(join(tmpdir(), 'candidate-index-empty-'))
    const res = run(empty)
    assert.equal(res.status, 0)
    assert.deepEqual(parseCandidateIndex(res.stdout), [])
    rmSync(home, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
})

// The fetch reads exactly the paths it is given, re-stats each so the header
// describes the bytes actually read, and leaves out a path that vanished.
test('candidate fetch script reads the listed paths and re-stats each', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } =
        await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'candidate-fetch-'))
    const dir = join(home, '.claude', 'projects', 'proj a')
    mkdirSync(dir, { recursive: true })
    const older = join(dir, 'older one.jsonl')
    writeFileSync(older, 'line-1\nline-2\n')
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    const newer = join(dir, 'newer.jsonl')
    const bigLine = `${'x'.repeat(1000)}\n`
    writeFileSync(newer, bigLine.repeat(80))
    utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))

    const res = spawnSync(
        'bash',
        ['-lc', candidateFetchScript([newer, join(dir, 'gone.jsonl'), older])],
        { env: { ...process.env, HOME: home }, encoding: 'utf8' }
    )
    const heads = parseCandidateScan(res.stdout)

    assert.deepEqual(
        heads.map((h) => h.path),
        [newer, older]
    )
    assert.equal(heads[0].lineCount, 80)
    assert.equal(heads[0].size, 80 * 1001)
    assert.equal(heads[0].mtimeMs, Date.parse('2026-02-01T00:00:00Z'))
    assert.equal(heads[0].truncated, heads[0].size > 65536)
    assert.ok(heads[0].headText.startsWith('x'))
    assert.equal(heads[1].headText.trim(), 'line-1\nline-2')
    assert.equal(heads[1].mtimeMs, Date.parse('2026-01-01T00:00:00Z'))
    rmSync(home, { recursive: true, force: true })
})

test('openclaw readMessages falls back to the session file when the rpc fails or is empty', async () => {
    const reader = new OpenclawSessionReader()
    const jsonl = [
        JSON.stringify({
            type: 'session',
            id: 'sess-fb',
            timestamp: '2026-04-27T20:47:18.123Z'
        }),
        JSON.stringify({
            type: 'message',
            id: 'u1',
            timestamp: '2026-04-27T20:47:19.000Z',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'still on disk' }]
            }
        })
    ].join('\n')
    const fs = {
        locate: async (): Promise<string | null> =>
            '/h/.openclaw/agents/main/sessions/sess-fb.jsonl',
        listFiles: async (): Promise<string[]> => [],
        exec: async (): Promise<string | null> => null,
        readFile: async (): Promise<string | null> => jsonl,
        readBinary: async (): Promise<Buffer | null> => null
    }

    const failingRpc = {
        call: async (): Promise<never> => {
            throw new Error('gateway 502')
        }
    }
    const viaFailure = await reader.readMessages({
        fs,
        agentId: 'agt',
        frameworkSessionRef: 'sess-fb',
        openclawRpc: failingRpc as never
    })
    assert.equal(viaFailure.messages.length, 1)
    assert.ok(
        viaFailure.warnings.some((w) => w.includes('falling back to file scan'))
    )

    const emptyRpc = {
        call: async (): Promise<unknown> => []
    }
    const viaEmpty = await reader.readMessages({
        fs,
        agentId: 'agt',
        frameworkSessionRef: 'sess-fb',
        openclawRpc: emptyRpc as never
    })
    assert.equal(viaEmpty.messages.length, 1)
})

// The list row's newest-activity fields come from the END of a transcript, and
// only a real bash run can show whether the tail window is emitted, where it is
// cut, and that a short file never pays for one.
test('candidate scan emits a tail window only past the head window', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
        'node:fs'
    )
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'candidate-tail-'))
    const dir = join(home, '.claude', 'projects', 'proj-a')
    mkdirSync(dir, { recursive: true })

    const small = join(dir, 'small.jsonl')
    writeFileSync(small, 'first\nlast\n')

    // 100 filler lines of 1000 chars each puts the 64 KiB cut inside line 34,
    // so the tail's own first line is a fragment the reader must drop.
    const big = join(dir, 'big.jsonl')
    const filler = Array.from(
        { length: 100 },
        (_, i) => `filler-${i}-${'x'.repeat(990)}`
    ).join('\n')
    writeFileSync(big, `HEAD-ONLY-MARKER\n${filler}\nTAIL-ONLY-MARKER\n`)

    const res = spawnSync('bash', ['-lc', candidateFetchScript([small, big])], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
    })
    const heads = parseCandidateScan(res.stdout)
    const smallHead = heads.find((h) => h.path === small)
    const bigHead = heads.find((h) => h.path === big)
    assert.ok(smallHead)
    assert.ok(bigHead)

    // The head already IS the whole small file; a second window would double
    // the payload for nothing.
    assert.equal(smallHead!.tailText, null)
    assert.equal(smallHead!.truncated, false)
    assert.deepEqual(candidateTailLines(smallHead!).slice(0, 2), [
        'first',
        'last'
    ])

    assert.equal(bigHead!.truncated, true)
    assert.notEqual(bigHead!.tailText, null)
    assert.ok(bigHead!.headText.includes('HEAD-ONLY-MARKER'))
    assert.ok(!bigHead!.headText.includes('TAIL-ONLY-MARKER'))
    assert.ok(bigHead!.tailText!.includes('TAIL-ONLY-MARKER'))
    assert.ok(!bigHead!.tailText!.includes('HEAD-ONLY-MARKER'))

    const tailLines = candidateTailLines(bigHead!)
    // The straddled fragment is gone, and every surviving line is whole.
    assert.ok(tailLines.every((line) => line === '' || /^(filler-\d+-x|TAIL-ONLY-MARKER)/.test(line)))
    assert.ok(tailLines.includes('TAIL-ONLY-MARKER'))
    assert.ok(bigHead!.tailText!.split('\n')[0].startsWith('x'))

    rmSync(home, { recursive: true, force: true })
})

// A fake runtime for the two-exec scan: the index script is answered from the
// file map, the fetch script only for the paths it names, and every script is
// kept so a test can count execs and see which files were read.
const scanFs = (
    files: Record<string, { head: string; tail?: string; mtimeSec?: number }>
) => {
    const scripts: string[] = []
    const entry = (path: string) => {
        const file = files[path]
        return {
            mtimeSec: file.mtimeSec ?? 1753364924,
            size:
                file.tail === undefined ? Buffer.byteLength(file.head) : 999999
        }
    }
    return {
        scripts,
        locate: async (): Promise<string | null> => null,
        listFiles: async (): Promise<string[]> => Object.keys(files),
        exec: async (script: string): Promise<string | null> => {
            scripts.push(script)
            if (script.includes('xargs -0 stat'))
                return Object.keys(files)
                    .sort((a, b) => entry(b).mtimeSec - entry(a).mtimeSec)
                    .map(
                        (path) =>
                            `${entry(path).mtimeSec} ${entry(path).size} ${path}`
                    )
                    .join('\n')
            return script
                .split('\n')
                .filter((line) => line.startsWith('/') && files[line])
                .map((path) => {
                    const { head, tail } = files[path]
                    return formatCandidateScanRecord({
                        path,
                        ...entry(path),
                        lineCount: head.split('\n').length,
                        headText: head,
                        ...(tail === undefined ? {} : { tailText: tail })
                    })
                })
                .join('')
        },
        readFile: async (): Promise<string | null> => null,
        readBinary: async (): Promise<Buffer> => Buffer.alloc(0)
    }
}

const fetchedPaths = (fs: { scripts: string[] }): string[][] =>
    fs.scripts
        .filter((script) => !script.includes('xargs -0 stat'))
        .map((script) =>
            script.split('\n').filter((line) => line.startsWith('/'))
        )

// A real bash on a real HOME, for the one behaviour a fake cannot show: what
// the reader's own find leaves out.
const bashFs = (home: string) => ({
    locate: async (): Promise<string | null> => null,
    listFiles: async (): Promise<string[]> => [],
    exec: async (script: string): Promise<string | null> => {
        const { spawnSync } = await import('node:child_process')
        const res = spawnSync('bash', ['-lc', script], {
            env: { ...process.env, HOME: home },
            encoding: 'utf8'
        })
        return res.status === 0 ? res.stdout : null
    },
    readFile: async (): Promise<string | null> => null,
    readBinary: async (): Promise<Buffer> => Buffer.alloc(0)
})

const refSummary = (head: CandidateFileHead): { sessionRef: string } | null => {
    const ref = head.headText.trim().split('\n')[0]
    return ref ? { sessionRef: ref } : null
}

test('scanCandidates reads only what the cache does not already describe', async () => {
    const files: Record<string, { head: string; mtimeSec?: number }> = {
        '/h/a.jsonl': { head: 'ref-a', mtimeSec: 300 },
        '/h/b.jsonl': { head: 'ref-b', mtimeSec: 200 },
        '/h/c.jsonl': { head: 'ref-c', mtimeSec: 100 }
    }
    const fs = scanFs(files)
    const cache = new CandidateScanCache()
    const opts = { agentId: 'agt', limit: 2, cache, summarize: refSummary }

    const cold = await scanCandidates(fs, 'find x', opts)
    assert.deepEqual(
        cold.candidates.map((c) => c.sessionRef),
        ['ref-a', 'ref-b']
    )
    assert.equal(cold.total, 3)
    assert.equal(cold.listed, 2)
    // The index, then one fetch of exactly the page.
    assert.equal(fs.scripts.length, 2)
    assert.deepEqual(fetchedPaths(fs), [['/h/a.jsonl', '/h/b.jsonl']])

    // Nothing changed: the index alone answers.
    const warm = await scanCandidates(fs, 'find x', opts)
    assert.deepEqual(warm.candidates, cold.candidates)
    assert.equal(fs.scripts.length, 3)

    // b grew, so b is the only file read again.
    files['/h/b.jsonl'] = { head: 'ref-b\nmore', mtimeSec: 200 }
    const changed = await scanCandidates(fs, 'find x', opts)
    assert.deepEqual(fetchedPaths(fs).at(-1), ['/h/b.jsonl'])
    assert.deepEqual(
        changed.candidates.map((c) => c.sessionRef),
        ['ref-a', 'ref-b']
    )

    // a left the runtime: gone from the page, and c moves up into it.
    delete files['/h/a.jsonl']
    const gone = await scanCandidates(fs, 'find x', opts)
    assert.deepEqual(
        gone.candidates.map((c) => c.sessionRef),
        ['ref-b', 'ref-c']
    )
    assert.equal(gone.total, 2)
    assert.deepEqual(fetchedPaths(fs).at(-1), ['/h/c.jsonl'])
})

test('scanCandidates remembers a file that carried no session id', async () => {
    const fs = scanFs({
        '/h/junk.jsonl': { head: '', mtimeSec: 10 },
        '/h/a.jsonl': { head: 'ref-a', mtimeSec: 5 }
    })
    const cache = new CandidateScanCache()
    const opts = { agentId: 'agt', limit: 10, cache, summarize: refSummary }

    const first = await scanCandidates(fs, 'find x', opts)
    assert.deepEqual(
        first.candidates.map((c) => c.sessionRef),
        ['ref-a']
    )
    // Read, just not a session — it still counts as covered.
    assert.equal(first.listed, 2)

    await scanCandidates(fs, 'find x', opts)
    assert.equal(fs.scripts.length, 3)
})

test('scanCandidates reports a page the fetch cap cut short', async () => {
    const files: Record<string, { head: string; mtimeSec?: number }> = {}
    const total = CANDIDATE_FETCH_LIMIT + 10
    for (let i = 0; i < total; i++)
        files[`/h/f${String(i).padStart(3, '0')}.jsonl`] = {
            head: `ref-${i}`,
            mtimeSec: 1000 - i
        }
    const fs = scanFs(files)
    const cache = new CandidateScanCache()
    const opts = { agentId: 'agt', limit: total, cache, summarize: refSummary }

    const first = await scanCandidates(fs, 'find x', opts)
    assert.equal(first.total, total)
    assert.equal(first.listed, CANDIDATE_FETCH_LIMIT)
    assert.equal(first.candidates.length, CANDIDATE_FETCH_LIMIT)
    assert.equal(first.candidates[0].sessionRef, 'ref-0')

    // The same call again covers the rest and reads only the rest.
    const second = await scanCandidates(fs, 'find x', opts)
    assert.equal(second.listed, total)
    assert.equal(fetchedPaths(fs).at(-1)!.length, 10)
})

test('scanCandidates knows unread transcripts by filename when the reader can', async () => {
    const readId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const unreadId = 'aaaaaaaa-0000-4000-8000-000000000002'
    const fs = scanFs({
        [`/h/p/${readId}.jsonl`]: { head: 'content-ref-1', mtimeSec: 20 },
        [`/h/p/${unreadId}.jsonl`]: { head: 'content-ref-2', mtimeSec: 10 }
    })

    const listing = await scanCandidates(fs, 'find x', {
        agentId: 'agt',
        limit: 1,
        summarize: refSummary,
        refFromPath: claudeRefFromPath
    })

    assert.deepEqual(
        listing.candidates.map((c) => c.sessionRef),
        ['content-ref-1']
    )
    // The read file is keyed by what it says, the unread one by its name.
    assert.deepEqual(
        [...listing.filesByRef.keys()].sort(),
        [readId, unreadId, 'content-ref-1'].sort()
    )
    assert.equal(
        listing.filesByRef.get(unreadId)?.path,
        `/h/p/${unreadId}.jsonl`
    )
})

test('a transcript filename proves its session id only when it is one', () => {
    assert.equal(
        claudeRefFromPath(
            '/h/.claude/projects/p/9f3c1a20-7b4e-4d2a-9c11-5e8a2f0b6d34.jsonl'
        ),
        '9f3c1a20-7b4e-4d2a-9c11-5e8a2f0b6d34'
    )
    assert.equal(
        claudeRefFromPath(
            '/h/.claude/projects/p/9f3c1a20-7b4e-4d2a-9c11-5e8a2f0b6d34/subagents/agent-aa4750a8d3522dff8.jsonl'
        ),
        null
    )
    assert.equal(
        codexRefFromPath(
            '/h/.codex/sessions/2026/07/04/rollout-2026-07-04T09-00-00-019874d1-2b3c-4d5e-8f60-718293a4b5c6.jsonl'
        ),
        '019874d1-2b3c-4d5e-8f60-718293a4b5c6'
    )
    assert.equal(codexRefFromPath('/h/.codex/sessions/rollout-1.jsonl'), null)
})

// A subagent transcript carries the parent's sessionId on every line, so
// listing it would show the parent again with the helper's reply as its own.
test('claude listCandidates leaves subagent transcripts out of the list', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
        'node:fs'
    )
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'candidate-subagents-'))
    const project = join(home, '.claude', 'projects', 'proj-a')
    const sessionId = '9f3c1a20-7b4e-4d2a-9c11-5e8a2f0b6d34'
    const subagents = join(project, sessionId, 'subagents')
    mkdirSync(subagents, { recursive: true })
    const line = (
        role: 'user' | 'assistant',
        text: string,
        extra: Record<string, unknown> = {}
    ): string =>
        JSON.stringify({
            uuid: `${role}-${text}`,
            sessionId,
            type: role,
            timestamp: '2026-07-01T10:00:00.000Z',
            message: { role, content: text },
            ...extra
        })
    writeFileSync(
        join(project, `${sessionId}.jsonl`),
        [line('user', 'open a PR'), line('assistant', 'Opened.')].join('\n')
    )
    writeFileSync(
        join(subagents, 'agent-aa4750a8d3522dff8.jsonl'),
        [
            line('user', 'ROLE: helper', { isSidechain: true }),
            line('assistant', 'helper reply', { isSidechain: true })
        ].join('\n')
    )

    const listing = await new ClaudeCodeSessionReader().listCandidates({
        fs: bashFs(home),
        agentId: 'agt'
    })

    assert.equal(listing.total, 1)
    assert.deepEqual(
        listing.candidates.map((c) => c.sessionRef),
        [sessionId]
    )
    assert.equal(listing.candidates[0].lastAssistantMessage, 'Opened.')
    assert.deepEqual([...listing.filesByRef.keys()], [sessionId])
    rmSync(home, { recursive: true, force: true })
})

test('claude listCandidates reads the newest reply, activity and model from the tail', async () => {
    const reader = new ClaudeCodeSessionReader()
    const head = [
        JSON.stringify({
            uuid: 'u1',
            sessionId: 'sess-tail',
            type: 'user',
            timestamp: '2026-07-01T10:00:00.000Z',
            message: { role: 'user', content: 'open a PR' }
        }),
        JSON.stringify({
            uuid: 'a1',
            sessionId: 'sess-tail',
            type: 'assistant',
            timestamp: '2026-07-01T10:00:05.000Z',
            message: {
                role: 'assistant',
                model: 'claude-old-1',
                content: [{ type: 'text', text: 'early answer' }]
            }
        })
    ].join('\n')
    const tail = [
        '{"uuid":"frag',
        JSON.stringify({
            uuid: 'a9',
            sessionId: 'sess-tail',
            type: 'assistant',
            timestamp: '2026-07-01T12:30:00.000Z',
            message: {
                role: 'assistant',
                model: 'claude-fable-5-1',
                content: [{ type: 'text', text: 'Opened  the\n  PR.' }]
            }
        })
    ].join('\n')

    const {
        candidates: [candidate]
    } = await reader.listCandidates({
        fs: scanFs({ '/h/.claude/projects/p/sess-tail.jsonl': { head, tail } }),
        agentId: 'agt'
    })

    assert.equal(candidate.sessionRef, 'sess-tail')
    assert.equal(candidate.firstUserMessage, 'open a PR')
    // From the tail, not the head's earlier turn — and collapsed to one line.
    assert.equal(candidate.lastAssistantMessage, 'Opened the PR.')
    assert.equal(candidate.lastActiveAt, '2026-07-01T12:30:00.000Z')
    assert.equal(candidate.model, 'claude-fable-5-1')
    assert.equal(candidate.timestamp, '2026-07-01T10:00:00.000Z')
})

test('claude listCandidates falls back to the head when the file has no tail', async () => {
    const reader = new ClaudeCodeSessionReader()
    const head = [
        JSON.stringify({
            uuid: 'u1',
            sessionId: 'sess-small',
            type: 'user',
            timestamp: '2026-07-02T08:00:00.000Z',
            message: { role: 'user', content: 'hello' }
        }),
        JSON.stringify({
            uuid: 'a1',
            sessionId: 'sess-small',
            type: 'assistant',
            timestamp: '2026-07-02T08:00:09.000Z',
            message: {
                role: 'assistant',
                model: 'claude-opus-5',
                content: [{ type: 'text', text: 'hi there' }]
            }
        })
    ].join('\n')

    const {
        candidates: [candidate]
    } = await reader.listCandidates({
        fs: scanFs({ '/h/.claude/projects/p/sess-small.jsonl': { head } }),
        agentId: 'agt'
    })

    assert.equal(candidate.lastAssistantMessage, 'hi there')
    assert.equal(candidate.lastActiveAt, '2026-07-02T08:00:09.000Z')
    assert.equal(candidate.model, 'claude-opus-5')
})

test('claude listCandidates reports no reply rather than inventing one', async () => {
    const reader = new ClaudeCodeSessionReader()
    const head = JSON.stringify({
        uuid: 'u1',
        sessionId: 'sess-quiet',
        type: 'user',
        timestamp: '2026-07-03T08:00:00.000Z',
        message: { role: 'user', content: 'anyone there?' }
    })

    const {
        candidates: [candidate]
    } = await reader.listCandidates({
        fs: scanFs({ '/h/.claude/projects/p/sess-quiet.jsonl': { head } }),
        agentId: 'agt'
    })

    assert.equal(candidate.lastAssistantMessage, null)
    assert.equal(candidate.model, null)
    assert.equal(candidate.lastActiveAt, '2026-07-03T08:00:00.000Z')
})

test('codex listCandidates takes the model from the head when the tail has none', async () => {
    const reader = new CodexSessionReader()
    const head = [
        JSON.stringify({
            type: 'session_meta',
            timestamp: '2026-07-04T09:00:00.000Z',
            payload: { id: 'rollout-1' }
        }),
        JSON.stringify({
            type: 'turn_context',
            timestamp: '2026-07-04T09:00:00.000Z',
            model: 'gpt-5.4',
            payload: {}
        }),
        JSON.stringify({
            type: 'response_item',
            timestamp: '2026-07-04T09:00:01.000Z',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'refactor this' }]
            }
        })
    ].join('\n')
    const tail = [
        '{"type":"response_i',
        JSON.stringify({
            type: 'response_item',
            timestamp: '2026-07-04T11:45:00.000Z',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Refactor done.' }]
            }
        })
    ].join('\n')

    const {
        candidates: [candidate]
    } = await reader.listCandidates({
        fs: scanFs({ '/h/.codex/sessions/rollout-1.jsonl': { head, tail } }),
        agentId: 'agt'
    })

    assert.equal(candidate.sessionRef, 'rollout-1')
    assert.equal(candidate.lastAssistantMessage, 'Refactor done.')
    assert.equal(candidate.lastActiveAt, '2026-07-04T11:45:00.000Z')
    // The tail window carries no model event, so the head's turn_context is
    // the only honest source.
    assert.equal(candidate.model, 'gpt-5.4')
})

test('openclaw file listCandidates reads the tail and never guesses a model', async () => {
    const reader = new OpenclawSessionReader()
    const head = [
        JSON.stringify({ type: 'session', id: 'oc-1' }),
        JSON.stringify({
            type: 'message',
            id: 'u1',
            timestamp: '2026-07-05T07:00:00.000Z',
            message: { role: 'user', content: [{ type: 'text', text: 'ping' }] }
        })
    ].join('\n')
    const tail = [
        '{"type":"mess',
        JSON.stringify({
            type: 'message',
            id: 'a9',
            timestamp: '2026-07-05T07:20:00.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'pong' }]
            }
        })
    ].join('\n')

    const {
        candidates: [candidate]
    } = await reader.listCandidates({
        fs: scanFs({
            '/h/.openclaw/agents/a/sessions/oc-1.jsonl': { head, tail }
        }),
        agentId: 'agt'
    })

    assert.equal(candidate.sessionRef, 'oc-1')
    assert.equal(candidate.lastAssistantMessage, 'pong')
    assert.equal(candidate.lastActiveAt, '2026-07-05T07:20:00.000Z')
    assert.equal(candidate.model, null)
})

test('openclaw rpc candidates report last activity and no reply text', async () => {
    const reader = new OpenclawSessionReader()
    const rpc = {
        call: async (): Promise<unknown> => [
            {
                key: 'oc-rpc-1',
                messageCount: 12,
                lastActivity: '2026-07-06T06:00:00.000Z',
                firstUserMessage: 'deploy staging'
            }
        ]
    }

    const { candidates } = await reader.listCandidates({
        fs: scanFs({}),
        agentId: 'agt',
        openclawRpc: rpc as never
    })

    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].lastActiveAt, '2026-07-06T06:00:00.000Z')
    assert.equal(candidates[0].timestamp, '2026-07-06T06:00:00.000Z')
    // sessions.list summarizes; it carries neither reply text nor a model.
    assert.equal(candidates[0].lastAssistantMessage, null)
    assert.equal(candidates[0].model, null)
})

test('hermes sqlite candidates carry the newest reply and message time', async () => {
    const Database = (
        (await import('better-sqlite3')) as unknown as {
            default: new (path: string) => {
                exec: (sql: string) => void
                prepare: (sql: string) => {
                    run: (...args: unknown[]) => unknown
                }
                close: () => void
            }
        }
    ).default
    const { listHermesSqliteCandidates } = await import(
        '../src/modules/chat/recovery/readers/hermes-sqlite-reader'
    )
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'nca-sqlite-list-'))
    const dbPath = join(dir, 'state.db')
    const db = new Database(dbPath)
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL,
            ended_at REAL, end_reason TEXT, title TEXT, input_tokens INTEGER,
            output_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
            tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
            reasoning TEXT, reasoning_content TEXT
        );
    `)
    db.prepare(
        'INSERT INTO sessions (id, started_at) VALUES (?, ?)'
    ).run('hs-list-1', 1700000000)
    const insert = db.prepare(
        'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run(1, 'hs-list-1', 'user', 'why is blue calming?', 1700000001)
    insert.run(2, 'hs-list-1', 'assistant', 'An early answer.', 1700000002)
    // A tool row with no content must not be mistaken for the newest reply.
    insert.run(3, 'hs-list-1', 'tool', 'tool output', 1700000003)
    insert.run(4, 'hs-list-1', 'assistant', 'Because of sky and water.', 1700000004)
    insert.run(5, 'hs-list-1', 'assistant', '', 1700000005)
    const mainBuf = readFileSync(dbPath)
    db.close()

    const fs = {
        locate: async (): Promise<string> => dbPath,
        listFiles: async (): Promise<string[]> => [],
        exec: async (): Promise<string | null> => null,
        readFile: async (): Promise<string | null> => null,
        readBinary: async (p: string): Promise<Buffer | null> =>
            p === dbPath ? mainBuf : null
    }

    const [candidate] = await listHermesSqliteCandidates(fs)
    assert.equal(candidate.sessionRef, 'hs-list-1')
    assert.equal(candidate.firstUserMessage, 'why is blue calming?')
    assert.equal(candidate.lastAssistantMessage, 'Because of sky and water.')
    assert.equal(candidate.messageCount, 5)
    assert.equal(candidate.lastActiveAt, new Date(1700000005 * 1000).toISOString())
    // The hermes schema records no model on a message row.
    assert.equal(candidate.model, null)
    rmSync(dir, { recursive: true, force: true })
})
