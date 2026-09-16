#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

assert.equal(
    process.env.RUN_CODEX_FAILURE_FIXTURE,
    '1',
    'fixture must only run in an explicitly owned QA runtime'
)
const args = process.argv.slice(2)
if (args.includes('--version')) {
    console.log('codex-cli 0.0.0-fixture')
} else {
    assert.equal(args[0], 'exec')
    const failure = process.env.CODEX_FIXTURE_FAILURE || 'overload'
    const message =
        failure === 'overload'
            ? 'stream disconnected before completion: Our servers are currently overloaded. Please try again later.'
            : failure === 'throttle'
              ? 'exceeded retry limit, last status: 429 Too Many Requests'
              : 'fixture permanent local failure'
    const threadId = args[1] === 'resume' ? args.at(-2) : randomUUID()
    if (process.env.CODEX_FIXTURE_CALL_LOG)
        await appendFile(
            process.env.CODEX_FIXTURE_CALL_LOG,
            JSON.stringify({
                command: args[1] === 'resume' ? 'resume' : 'fresh',
                threadId
            }) + '\n'
        )
    console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }))
    process.stderr.write('MCP startup warning: fixture-only optional server\n')
    const delay = Math.max(
        0,
        Math.min(60000, Number(process.env.CODEX_FIXTURE_DELAY_MS) || 0)
    )
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    console.log(JSON.stringify({ type: 'turn.failed', error: { message } }))
    process.exitCode = 1
}
