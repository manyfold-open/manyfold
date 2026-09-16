import assert from 'node:assert/strict'
import test from 'node:test'
import { runAdapterWire } from './adapter-wire-harness'
import { normalizeChatErrorPayload } from '../src/modules/chat/chat-failure-cause'
import { buildTelemetryCaptureOptions } from '../src/sentry-grouping'

const overload =
    'stream disconnected before completion: Our servers are currently overloaded. Please try again later.'
const throttled = 'exceeded retry limit, last status: 429 Too Many Requests'
const line = (value: unknown) => JSON.stringify(value) + '\n'

for (const resume of [false, true]) {
    for (const [detail, code, cause] of [
        [overload, 'codex_provider_overloaded', 'provider_overloaded'],
        [throttled, 'codex_rate_limited', 'rate_limited']
    ]) {
        for (const source of [
            'stderr',
            'turn.failed',
            'warning-and-terminal',
            'long-stderr'
        ]) {
            test(`${resume ? 'resume' : 'fresh'} Codex ${source} ${cause} survives the normalized terminal JSON round-trip`, async () => {
                const { events, calls, refs } = await runAdapterWire(
                    'codex',
                    source === 'turn.failed' ||
                        source === 'warning-and-terminal'
                        ? line({
                              type: 'turn.failed',
                              error: { message: detail }
                          })
                        : '',
                    {
                        resume,
                        stderr:
                            source === 'stderr'
                                ? detail
                                : source === 'warning-and-terminal'
                                  ? 'MCP startup warning: optional server is unavailable'
                                  : source === 'long-stderr'
                                    ? 'startup diagnostic '.repeat(80) +
                                      '\nERROR: ' +
                                      detail
                                    : '',
                        exitCode: 1
                    }
                )
                const event = events.find((event) => event.type === 'error')
                assert.ok(event?.type === 'error')
                const stored = JSON.parse(
                    JSON.stringify(
                        normalizeChatErrorPayload({ error: event.error })
                    )
                )
                assert.equal(stored.error.code, code)
                assert.equal(stored.error.cause, cause)
                assert.equal(stored.error.retryable, true)
                assert.equal(stored.error.message, `codex exited 1: ${detail}`)
                assert.equal(event.managedChannelFailure, undefined)
                assert.equal(
                    calls.length,
                    1,
                    'retryability must not replay a turn'
                )
                assert.ok(
                    !refs.includes(null),
                    'a provider refusal must not clear a resume ref'
                )
                const options = buildTelemetryCaptureOptions(
                    'chat.stream.error',
                    {
                        cause: stored.error.cause,
                        errorCode: stored.error.code,
                        phase: resume ? 'resume' : 'stream',
                        framework: 'codex',
                        runtimeKind: 'sprites',
                        message: detail,
                        requestId: 'opaque-request-fixture',
                        providerUrl:
                            'https://provider.example.test/?token=private-fixture',
                        userId: 'user_fixture',
                        messageId: 'msg_fixture'
                    }
                )
                assert.deepEqual(options.fingerprint, [
                    'chat.stream.error.v1',
                    cause
                ])
                const indexed = JSON.stringify([
                    options.tags,
                    options.fingerprint
                ])
                for (const forbidden of [
                    detail,
                    'opaque-request-fixture',
                    'provider.example.test',
                    'private-fixture',
                    'user_fixture',
                    'msg_fixture'
                ])
                    assert.ok(!indexed.includes(forbidden), forbidden)
            })
        }
    }
    test(`${resume ? 'resume' : 'fresh'} Codex keeps ordinary failures and tool/user prose unclassified`, async () => {
        for (const stderr of [
            'panic: local failure',
            'Our servers are currently overloaded. Please try again later.',
            `The README says: ${overload}`,
            `${overload}\npermanent local failure`,
            'the tool saw 429 warnings'
        ]) {
            const stdout =
                line({
                    type: 'item.completed',
                    item: { type: 'agent_message', text: overload }
                }) +
                line({
                    type: 'item.completed',
                    item: {
                        type: 'command_execution',
                        aggregated_output: throttled
                    }
                })
            const { events } = await runAdapterWire('codex', stdout, {
                resume,
                stderr,
                exitCode: 1
            })
            const event = events.find((event) => event.type === 'error')
            assert.ok(event?.type === 'error')
            const stored = normalizeChatErrorPayload({ error: event.error })
                .error as Record<string, unknown>
            assert.equal(stored.code, 'codex_exec_failed')
            assert.equal(stored.retryable, false)
            assert.equal(stored.cause, undefined)
        }
    })
}

test('a structured final failure is not replaced by earlier or later nonterminal diagnostics', async () => {
    const wire =
        line({ type: 'error', message: overload }) +
        line({
            type: 'turn.failed',
            error: { message: 'permanent local failure' }
        }) +
        line({ type: 'error', message: overload })
    for (const resume of [false, true]) {
        const { events } = await runAdapterWire('codex', wire, {
            resume,
            exitCode: 1
        })
        const event = events.find((event) => event.type === 'error')
        assert.ok(event?.type === 'error')
        assert.equal(event.error.code, 'codex_exec_failed')
        assert.equal(event.error.retryable, false)
    }
})

test('a permanent terminal owns the verdict even when stderr ends with an older transient failure', async () => {
    for (const resume of [false, true]) {
        for (const message of [
            'authentication failed',
            'permanent local failure'
        ]) {
            const { events } = await runAdapterWire(
                'codex',
                line({ type: 'turn.failed', error: { message } }),
                {
                    resume,
                    exitCode: 1,
                    stderr: overload
                }
            )
            const event = events.find((event) => event.type === 'error')
            assert.ok(event?.type === 'error')
            const payload = normalizeChatErrorPayload({ error: event.error })
                .error as Record<string, unknown>
            assert.equal(payload.code, 'codex_exec_failed')
            assert.equal(payload.retryable, false)
            assert.equal(payload.message, `codex exited 1: ${message}`)
            assert.equal(
                payload.cause,
                message === 'authentication failed' ? 'auth_invalid' : undefined
            )
        }
    }
})

test('the existing managed-pool signal keeps precedence over a transient provider diagnostic', async () => {
    const { events } = await runAdapterWire(
        'codex',
        line({ type: 'turn.failed', error: { message: overload } }),
        {
            exitCode: 1,
            stderr: 'unexpected status 503 {"error":{"code":503,"message":"No available Gemini accounts: no available accounts"}}'
        }
    )
    const event = events.find((event) => event.type === 'error')
    assert.ok(event?.type === 'error')
    assert.equal(event.managedChannelFailure, 'account_pool_empty')
    assert.equal(event.error.code, 'codex_exec_failed')
    assert.equal(event.error.retryable, false)
})

test('Codex overload text in a successful turn does not create a failure or replay', async () => {
    const { events, calls } = await runAdapterWire(
        'codex',
        line({
            type: 'item.completed',
            item: { type: 'agent_message', text: overload }
        })
    )
    assert.equal(events.at(-1)?.type, 'done')
    assert.ok(events.every((event) => event.type !== 'error'))
    assert.equal(calls.length, 1)
})
