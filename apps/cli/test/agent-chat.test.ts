import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import { createClient } from '@manyfold/sdk'
import { apiFetch, json, runMf, type Call } from './fixtures/fake-api'
import { chatEvent, sse, type StreamEvent } from './fixtures/chat-stream'
import {
    parseReplLine,
    replTurn,
    type ReplState
} from '../src/commands/agent/chat'
import { checkFiles, type TurnView } from '../src/commands/agent/chat-turn'

// `mf agent chat` is `mf agent send` in a loop at a prompt; the loop itself
// needs a terminal, so only what surrounds it is tested here.

test('without a terminal the chat points at mf agent send, before any request', async () => {
    const run = await runMf(['agent', 'chat', 'agt_1'])
    assert.ok(run.error instanceof CommanderError, String(run.error))
    assert.match(run.error.message, /needs a terminal.*use mf agent send/)
    assert.deepEqual(run.calls, [])
})

test('/new and /exit belong to the prompt; any other line goes to the agent', () => {
    assert.deepEqual(parseReplLine('  '), { kind: 'empty' })
    assert.deepEqual(parseReplLine('/exit'), { kind: 'exit' })
    assert.deepEqual(parseReplLine(' /quit '), { kind: 'exit' })
    assert.deepEqual(parseReplLine('/new'), { kind: 'new' })
    assert.deepEqual(parseReplLine('/compact'), {
        kind: 'message',
        text: '/compact'
    })
    assert.deepEqual(parseReplLine('fix the test'), {
        kind: 'message',
        text: 'fix the test'
    })
})

test('--file is checked before the chat starts, like send', async () => {
    const missing = await runMf([
        'agent',
        'chat',
        'agt_1',
        '--file',
        '/nonexistent/design.png'
    ])
    assert.ok(missing.error instanceof CommanderError, String(missing.error))
    assert.match(missing.error.message, /no such file/)
    assert.deepEqual(missing.calls, [])
    const both = await runMf(['agent', 'chat', 'agt_1', '-c', '--session', 'x'])
    assert.ok(both.error instanceof CommanderError, String(both.error))
    assert.match(both.error.message, /--session and --continue both pick/)
})

const silent: TurnView = {
    text: () => undefined,
    thinking: () => undefined,
    replaced: () => undefined,
    toolCall: () => undefined,
    notice: () => undefined,
    permission: () => undefined
}

const done = (n: number): StreamEvent[] => [
    chatEvent('token', n, { text: 'ok' }),
    chatEvent('done', n + 1, { finalMessageId: 'msg_a' })
]

test('the files --file names go with the first message, and only with it', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-chat-file-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const design = join(dir, 'design.png')
    await writeFile(design, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const calls: Call[] = []
    const client = createClient({
        baseUrl: 'https://api.test/api',
        token: 'nca_rt_test',
        fetch: apiFetch(
            {
                'POST /agents/agt_1/sessions': () =>
                    json({ id: 'cts_1', agentId: 'agt_1' }, 201),
                'PUT /agents/agt_1/files/write': (_call, index) =>
                    index === 0
                        ? json(
                              {
                                  error: {
                                      code: 'SANDBOX_CLI_TOO_OLD',
                                      message: 'too old'
                                  }
                              },
                              409
                          )
                        : json({ ok: true }),
                'POST /agents/agt_1/sessions/cts_1/messages': () =>
                    json(
                        {
                            userMessage: { id: 'msg_u' },
                            assistantMessageId: 'msg_a'
                        },
                        201
                    ),
                'GET /agents/agt_1/sessions/cts_1/stream': (_call, index) =>
                    sse(done(index * 10 + 1)),
                'GET /agents/agt_1/sessions/cts_1/messages': () =>
                    json({ messages: [], hasMore: false, nextBefore: null })
            },
            calls
        )
    })
    const state: ReplState = {
        sessionId: null,
        files: await checkFiles([design])
    }
    // The upload is refused (the sandbox's CLI too old): nothing is sent,
    // and the file waits for the next message.
    await assert.rejects(
        replTurn(client, 'agt_1', state, 'what is this?', silent),
        /too old/
    )
    assert.equal(state.files.length, 1)
    const posts = () =>
        calls.filter(
            (call) => call.method === 'POST' && call.path.endsWith('/messages')
        )
    assert.equal(posts().length, 0)

    await replTurn(client, 'agt_1', state, 'what is this?', silent)
    const [first] = posts()
    const path = (first.body as { attachments: Array<{ path: string }> })
        .attachments[0].path
    assert.match(path, /^chat-attachments\/cts_1\/[0-9a-f-]{36}\/design\.png$/)
    assert.equal(state.files.length, 0)

    await replTurn(client, 'agt_1', state, 'and the colours?', silent)
    assert.deepEqual(posts()[1].body, { text: 'and the colours?' })
    // One session for the whole chat, and one upload that went through.
    assert.equal(
        calls.filter((call) => call.path === '/agents/agt_1/sessions').length,
        1
    )
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 2)
})
