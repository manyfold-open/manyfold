import assert from 'node:assert/strict'
import test from 'node:test'
import { parseClaudeJsonl } from '../src/modules/chat/recovery/readers/claude-code-reader'
import { parseCodexJsonl } from '../src/modules/chat/recovery/readers/codex-reader'
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
    candidateScanScript,
    parseCandidateScan
} from '../src/modules/chat/recovery/readers/candidate-scan'
import { claudeSessionLocateScript } from '../src/modules/chat/recovery/readers/claude-code-reader'

const formatCandidateScanRecord = (record: {
    path: string
    mtimeSec: number
    size: number
    lineCount: number
    headText: string
}): string =>
    `-----MF-RECOVERY-CANDIDATE-----\t${record.path}\t${record.mtimeSec}\t${record.size}\t${record.lineCount}\n${record.headText}\n`

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
    const files: Record<string, string> = {
        '/h/.gemini/tmp/a/chats/session-2026-07-24T13-48-sessjl1.jsonl':
            geminiJsonlBlob(),
        '/h/.gemini/tmp/b/chats/session-old.json': JSON.stringify({
            sessionId: 'sess-old-1',
            startTime: '2026-01-01T00:00:00.000Z',
            messages: [
                { id: 'm1', type: 'user', content: 'old question' },
                { id: 'm2', type: 'gemini', content: 'old answer' }
            ]
        })
    }
    const fs = {
        locate: async (): Promise<string | null> => null,
        listFiles: async (): Promise<string[]> => Object.keys(files),
        exec: async (): Promise<string | null> =>
            Object.entries(files)
                .map(([path, text]) =>
                    formatCandidateScanRecord({
                        path,
                        mtimeSec: 1753364924,
                        size: Buffer.byteLength(text),
                        lineCount: text.split('\n').length,
                        headText: text
                    })
                )
                .join(''),
        readFile: async (path: string): Promise<string | null> =>
            files[path] ?? null,
        readBinary: async (): Promise<Buffer> => Buffer.alloc(0)
    }
    const candidates = await reader.listCandidates({ fs, agentId: 'agt' })
    assert.equal(candidates.length, 2)
    const jl = candidates.find((c) => c.sessionRef === 'sess-jl-1')
    assert.ok(jl)
    assert.equal(jl!.firstUserMessage, 'why is blue calming?')
    assert.equal(jl!.messageCount, 2)
    assert.equal(jl!.timestamp, '2026-07-24T13:48:44.717Z')
    const old = candidates.find((c) => c.sessionRef === 'sess-old-1')
    assert.ok(old)
    assert.equal(old!.firstUserMessage, 'old question')
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

test('candidate scan script emits mtime-sorted bounded heads', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } =
        await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const home = mkdtempSync(join(tmpdir(), 'candidate-scan-'))
    const dir = join(home, '.claude', 'projects', 'proj-a')
    mkdirSync(dir, { recursive: true })
    const older = join(dir, 'older.jsonl')
    writeFileSync(older, 'line-1\nline-2\n')
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    const newer = join(dir, 'newer.jsonl')
    const bigLine = `${'x'.repeat(1000)}\n`
    writeFileSync(newer, bigLine.repeat(80))
    utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))

    const script = candidateScanScript(
        `find "$HOME"/.claude/projects -type f -name '*.jsonl'`,
        1
    )
    const res = spawnSync('bash', ['-lc', script], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
    })
    const heads = parseCandidateScan(res.stdout)

    // limit 1 must keep the NEWEST file, not an arbitrary one
    assert.equal(heads.length, 1)
    assert.equal(heads[0].path, newer)
    assert.equal(heads[0].lineCount, 80)
    assert.equal(heads[0].size, 80 * 1001)
    assert.equal(heads[0].truncated, heads[0].size > 65536)
    assert.ok(heads[0].headText.startsWith('x'))

    const full = spawnSync(
        'bash',
        [
            '-lc',
            candidateScanScript(
                `find "$HOME"/.claude/projects -type f -name '*.jsonl'`,
                10
            )
        ],
        { env: { ...process.env, HOME: home }, encoding: 'utf8' }
    )
    const both = parseCandidateScan(full.stdout)
    assert.deepEqual(
        both.map((h) => h.path),
        [newer, older]
    )
    assert.equal(both[1].headText.trim(), 'line-1\nline-2')
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
