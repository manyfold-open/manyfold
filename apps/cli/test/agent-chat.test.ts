import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import { runMf } from './fixtures/fake-api'
import { parseReplLine } from '../src/commands/agent/chat'

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
