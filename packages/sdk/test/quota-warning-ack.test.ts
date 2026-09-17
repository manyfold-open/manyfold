import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
    apiPaths,
    createObjectId,
    type QuotaWarningEvent
} from '@manyfold/shared'
import { createClient } from '../src/client'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const event = (): QuotaWarningEvent => ({
    type: 'quota-warning',
    code: 'automation_runs',
    usage: 9,
    limit: 10,
    planName: 'Fixture',
    at: new Date().toISOString(),
    receiptId: createObjectId('quotaWarningReceipt')
})

const harness = (consume?: (event: QuotaWarningEvent) => void) => {
    const acks: Array<{
        body: { receiptId: string }
        headers: Headers
        result: ReturnType<typeof deferred<Response>>
    }> = []
    const errors: Error[] = []
    const opened = deferred<void>()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let updates = 0
    const client = createClient({
        baseUrl: 'https://sdk.fixture.invalid',
        token: 'fixture-token',
        accountScope: true,
        fetch: async (input, init) => {
            if (String(input).endsWith(apiPaths.AGENT_SPRITE_STATUS_STREAM))
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start: (value) => {
                            controller = value
                        }
                    })
                )
            assert.equal(
                String(input),
                `https://sdk.fixture.invalid${apiPaths.ME_RUNTIME_ACCESS_QUOTA_WARNING_ACK}`
            )
            assert.equal(init?.method, 'POST')
            const result = deferred<Response>()
            acks.push({
                body: JSON.parse(String(init?.body)),
                headers: new Headers(init?.headers),
                result
            })
            init?.signal?.addEventListener(
                'abort',
                () => result.reject(init.signal?.reason),
                { once: true }
            )
            return result.promise
        }
    })
    const handle = client.agents.streamSpriteStatus({
        onOpen: () => opened.resolve(),
        onQuotaWarning: consume,
        onUpdate: () => {
            updates++
        },
        onError: (error) => errors.push(error)
    })
    return {
        acks,
        errors,
        opened: opened.promise,
        updates: () => updates,
        send: (value: unknown) =>
            controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
            ),
        close: async () => {
            for (const ack of acks)
                ack.result.resolve(new Response('{"acknowledged":true}'))
            await flush()
            controller.close()
            handle.close()
            await flush()
        }
    }
}

for (const kind of ['absent', 'throwing', 'rejecting'] as const) {
    test(`a ${kind} quota consumer never ACKs and does not stop the reader`, async (t) => {
        const consume =
            kind === 'absent'
                ? undefined
                : kind === 'throwing'
                  ? () => {
                        throw new Error('consumer fixture failure')
                    }
                  : async () => {
                        throw new Error('consumer fixture failure')
                    }
        const h = harness(consume)
        t.after(h.close)
        await h.opened
        h.send(event())
        h.send({ type: 'update', agentId: 'fixture-agent' })
        await flush()
        assert.equal(h.acks.length, 0)
        assert.equal(h.updates(), 1)
        assert.deepEqual(h.errors, [])
    })
}

test('quota ACK follows consumer acceptance and preserves authenticated account scope', async (t) => {
    let consumed = 0
    const h = harness(() => {
        consumed++
    })
    t.after(h.close)
    await h.opened
    const warning = event()
    h.send(warning)
    await flush()
    assert.equal(consumed, 1)
    assert.equal(h.acks.length, 1)
    assert.deepEqual(h.acks[0].body, { receiptId: warning.receiptId })
    assert.equal(h.acks[0].headers.get('authorization'), 'Bearer fixture-token')
    assert.equal(h.acks[0].headers.get('x-account-scope'), '1')
})

test('a failed ACK is consumed, same receipt coalesces in flight, later cadence retries', async (t) => {
    let consumed = 0
    const h = harness(() => {
        consumed++
    })
    t.after(h.close)
    await h.opened
    const warning = event()
    h.send(warning)
    h.send(warning)
    h.send({ type: 'update', agentId: 'reader-stays-live' })
    await flush()
    assert.equal(h.acks.length, 1)
    assert.equal(consumed, 1)
    assert.equal(h.updates(), 1)
    h.acks[0].result.reject(new TypeError('fixture network failure'))
    await flush()
    assert.deepEqual(h.errors, [])
    assert.equal(h.acks.length, 1, 'failure must not auto-loop or reconnect')
    h.send(warning)
    await flush()
    assert.equal(h.acks.length, 2)
    assert.equal(consumed, 2)
})

test('ACK concurrency is bounded without hiding other warnings from the consumer', async (t) => {
    const consumed: string[] = []
    const h = harness((value) => {
        consumed.push(value.receiptId!)
    })
    t.after(h.close)
    await h.opened
    const warnings = Array.from({ length: 7 }, event)
    for (const warning of warnings) h.send(warning)
    h.send({ type: 'update', agentId: 'reader-stays-live' })
    await flush()
    assert.equal(h.acks.length, 4)
    assert.equal(consumed.length, 7)
    assert.equal(h.updates(), 1)
    for (const ack of h.acks)
        ack.result.resolve(new Response('{"acknowledged":true}'))
    await flush()
    for (const warning of warnings.slice(4)) h.send(warning)
    await flush()
    assert.equal(h.acks.length, 7)
    assert.deepEqual(h.errors, [])
})

test('ACK deadline releases capacity and late consumer completion cannot ACK or retire a newer attempt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pendingConsumer = deferred<void>()
    let consumed = 0
    const h = harness(() =>
        ++consumed === 1 ? pendingConsumer.promise : undefined
    )
    t.after(h.close)
    await h.opened
    const warning = event()
    h.send(warning)
    await flush()
    assert.equal(h.acks.length, 0)
    t.mock.timers.tick(10_000)
    h.send(warning)
    await flush()
    assert.equal(h.acks.length, 1)
    pendingConsumer.resolve()
    await flush()
    h.send(warning)
    await flush()
    assert.equal(h.acks.length, 1)
    assert.equal(consumed, 2)
    t.mock.timers.tick(10_000)
    await flush()
    assert.deepEqual(h.errors, [])
    h.send(warning)
    await flush()
    assert.equal(h.acks.length, 2)
})

test('legacy warning without receipt still reaches its consumer without an ACK', async (t) => {
    let consumed = 0
    const h = harness(() => {
        consumed++
    })
    t.after(h.close)
    await h.opened
    const warning = event()
    delete warning.receiptId
    h.send(warning)
    await flush()
    assert.equal(consumed, 1)
    assert.equal(h.acks.length, 0)
})

for (const mode of ['stop', 'eof']) {
    test(`real HTTP ${mode} closes pending ACK and permits the process to exit`, () => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            QUOTA_STREAM_FIXTURE_MODE: mode
        }
        delete env.NODE_TEST_CONTEXT
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--test',
                fileURLToPath(
                    new URL(
                        './fixtures/quota-stream-stop.test.ts',
                        import.meta.url
                    )
                )
            ],
            {
                env,
                encoding: 'utf8',
                timeout: 8000,
                killSignal: 'SIGKILL'
            }
        )
        assert.equal(result.error, undefined, result.stdout + result.stderr)
        assert.equal(result.status, 0, result.stdout + result.stderr)
        assert.match(
            result.stdout,
            /ACK transport closed without a server response/
        )
    })
}
