import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'

// S0 of the resident-runner work: a resumed runner stream restarts from the last
// DURABLY recorded transport seq instead of replaying the whole turn. These pin
// the two properties the cursor's correctness rests on:
//   1. the seq advances only when the consumer DEQUEUES a chunk — a cursor built
//      from arrival order could skip content the API never actually consumed;
//   2. carrying the seq must not perturb rawSha256 / sourceEventKey, or replayed
//      lines would land as NEW rows instead of being deduped.

interface FakeStream {
    refId: string
    result: Promise<{ exitCode: number }>
    cancel: () => void
}

const driverWith = (
    emit: (onEvent: (kind: string, data: string, seq?: number) => void) => void
): DaemonExecDriver => {
    const registry = {
        streamRpc: (args: {
            onEvent?: (kind: string, data: string, seq?: number) => void
        }): FakeStream => {
            if (args.onEvent) emit(args.onEvent)
            return {
                refId: 'ref-1',
                result: Promise.resolve({ exitCode: 0 }),
                cancel: () => {}
            }
        }
    }
    return new DaemonExecDriver(
        registry as unknown as ConstructorParameters<
            typeof DaemonExecDriver
        >[0],
        'daemon-1'
    )
}

test('lastDeliveredSeq tracks dequeued chunks, not arrived chunks', async () => {
    // All three chunks arrive before anything is read — the cursor must still
    // report 0 until the consumer actually takes them.
    const driver = driverWith((onEvent) => {
        onEvent('stdout', 'a\n', 1)
        onEvent('stdout', 'b\n', 2)
        onEvent('stdout', 'c\n', 3)
    })
    const handle = driver.stream({ cmd: ['x'], timeoutMs: 1000 })
    assert.equal(handle.lastDeliveredSeq?.(), 0, 'nothing dequeued yet')

    const seen: Array<{ data: string; seq: number | undefined }> = []
    const it = handle.stdout[Symbol.asyncIterator]()
    for (let i = 0; i < 3; i++) {
        const next = await it.next()
        seen.push({
            data: next.value as string,
            seq: handle.lastDeliveredSeq?.()
        })
    }
    assert.deepEqual(seen, [
        { data: 'a\n', seq: 1 },
        { data: 'b\n', seq: 2 },
        { data: 'c\n', seq: 3 }
    ])
})

test('lastDeliveredSeq advances for chunks handed to a waiting consumer', async () => {
    // The other half of the sink: a consumer parked on next() before data
    // arrives is resolved directly, bypassing the queue.
    let push: ((kind: string, data: string, seq?: number) => void) | null = null
    const driver = driverWith((onEvent) => {
        push = onEvent
    })
    const handle = driver.stream({ cmd: ['x'], timeoutMs: 1000 })
    const it = handle.stdout[Symbol.asyncIterator]()
    const pending = it.next()
    assert.equal(handle.lastDeliveredSeq?.(), 0)
    push!('stdout', 'live\n', 42)
    assert.equal((await pending).value, 'live\n')
    assert.equal(handle.lastDeliveredSeq?.(), 42)
})

test('stderr chunks share the cursor with stdout', async () => {
    // One transport sequence covers both kinds, so a resume must not rewind
    // past interleaved stderr.
    const driver = driverWith((onEvent) => {
        onEvent('stdout', 'out\n', 7)
        onEvent('stderr', 'err\n', 8)
    })
    const handle = driver.stream({ cmd: ['x'], timeoutMs: 1000 })
    await handle.stdout[Symbol.asyncIterator]().next()
    assert.equal(handle.lastDeliveredSeq?.(), 7)
    await handle.stderr[Symbol.asyncIterator]().next()
    assert.equal(handle.lastDeliveredSeq?.(), 8)
})

test('resumeStream forwards the cursor as fromSeq', async () => {
    let captured: Record<string, unknown> | null = null
    const registry = {
        streamRpc: (args: {
            method: string
            payload: Record<string, unknown>
        }): FakeStream => {
            captured = { method: args.method, ...args.payload }
            return {
                refId: 'ref-2',
                result: Promise.resolve({ exitCode: 0 }),
                cancel: () => {}
            }
        }
    }
    const driver = new DaemonExecDriver(
        registry as unknown as ConstructorParameters<
            typeof DaemonExecDriver
        >[0],
        'daemon-1'
    )
    driver.resumeStream({ refId: 'orig-ref', fromSeq: 17, timeoutMs: 1000 })
    assert.deepEqual(captured, {
        method: 'exec.resume',
        originalRefId: 'orig-ref',
        fromSeq: 17
    })
})

test('aborting a resume stops the attach and the original child exactly once', async () => {
    const attach = {
        cancels: 0,
        reject: (_err: Error): void => {}
    }
    const result = new Promise<{ exitCode: number }>((_resolve, reject) => {
        attach.reject = reject
    })
    result.catch(() => {})
    const rpcCalls: Array<{
        daemonId: string
        method: string
        payload: Record<string, unknown>
    }> = []
    const registry = {
        streamRpc: () => ({
            refId: 'resume-attach-ref',
            result,
            cancel: () => {
                attach.cancels += 1
                attach.reject(new Error('cancelled'))
            }
        }),
        rpc: async (args: {
            daemonId: string
            method: string
            payload: Record<string, unknown>
        }) => {
            rpcCalls.push(args)
            return {}
        }
    }
    const driver = new DaemonExecDriver(
        registry as unknown as ConstructorParameters<
            typeof DaemonExecDriver
        >[0],
        'daemon-1'
    )
    const handle = driver.resumeStream({
        refId: 'original-exec-ref',
        fromSeq: 0,
        timeoutMs: 1000
    })

    handle.abort()
    handle.abort()
    await assert.rejects(handle.result, /cancelled/)

    assert.equal(attach.cancels, 1)
    assert.deepEqual(rpcCalls, [
        {
            daemonId: 'daemon-1',
            method: 'exec.abort',
            payload: { refId: 'original-exec-ref' },
            timeoutMs: 10_000
        }
    ])
})

test('runnerSeq is recorded on the row but changes neither hash nor dedup key', () => {
    const source = {
        sourceRef: 'sess-1',
        sourceSeq: 3,
        externalId: 'uuid-1',
        parentExternalId: null,
        rawFormat: 'jsonl' as const,
        rawText: '{"type":"assistant"}',
        parserName: 'claude-stream-json',
        parserVersion: '1'
    }
    const base = {
        sourceKind: 'live_stream' as const,
        sessionId: 'cts-1',
        messageId: 'msg-1',
        framework: 'claude-code' as const,
        runtime: 'daemon' as const,
        source
    }
    const withoutSeq = buildChatMessageSourceRow(base)
    const withSeq = buildChatMessageSourceRow({ ...base, runnerSeq: 9 })
    const replayed = buildChatMessageSourceRow({ ...base, runnerSeq: 12 })

    assert.equal(withoutSeq.runnerSeq, null)
    assert.equal(withSeq.runnerSeq, 9)
    // Identical raw line ⇒ identical hash and dedup key regardless of which
    // transport event carried it, so a replayed tail is dropped by the
    // source_event_key unique index instead of duplicating content.
    assert.equal(withSeq.rawSha256, withoutSeq.rawSha256)
    assert.equal(withSeq.sourceEventKey, withoutSeq.sourceEventKey)
    assert.equal(replayed.sourceEventKey, withSeq.sourceEventKey)
    assert.equal(replayed.rawBytes, withSeq.rawBytes)
})
