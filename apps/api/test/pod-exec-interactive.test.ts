import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { PassThrough } from 'node:stream'
import type { V1Status } from '@kubernetes/client-node'
import { PodExec } from '../src/modules/k8s/pod-exec'

type StatusCb = (status: V1Status) => void

interface FakeSession {
    cmd: string[]
    tty: boolean
    stdinChunks: Buffer[]
    stdinEof: boolean
    ws: FakeWs
    stdout: PassThrough
    stderr: PassThrough
    status: StatusCb
}

class FakeWs extends EventEmitter {
    closed = false
    close(): void {
        this.closed = true
        this.emit('close')
    }
}

// PodExec constructs its Exec from the kube config; tests swap the instance
// for a fake that records the session and lets us drive both directions.
const makePodExec = (): { podExec: PodExec; sessions: FakeSession[] } => {
    const sessions: FakeSession[] = []
    const podExec = new PodExec(
        {} as never,
        { kubeConfig: {} } as never,
        'ns-1',
        'pod-1',
        'main'
    )
    const fakeExec = {
        exec: (
            _ns: string,
            _pod: string,
            _container: string,
            cmd: string[],
            stdout: PassThrough,
            stderr: PassThrough,
            stdin: PassThrough,
            tty: boolean,
            status: StatusCb
        ): Promise<FakeWs> => {
            const session: FakeSession = {
                cmd,
                tty,
                stdinChunks: [],
                stdinEof: false,
                ws: new FakeWs(),
                stdout,
                stderr,
                status
            }
            stdin.on('data', (chunk: Buffer) =>
                session.stdinChunks.push(
                    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                )
            )
            stdin.on('end', () => {
                session.stdinEof = true
            })
            sessions.push(session)
            return Promise.resolve(session.ws)
        }
    }
    ;(podExec as unknown as { exec: unknown }).exec = fakeExec
    return { podExec, sessions }
}

const nextTick = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

const collect = async (iter: AsyncIterable<string>): Promise<string> => {
    let out = ''
    for await (const chunk of iter) out += chunk
    return out
}

test('streamInteractive writes stdin after start and finalizes on status + close', async () => {
    const { podExec, sessions } = makePodExec()
    const handle = podExec.streamInteractive({
        cmd: ['hermes', 'acp'],
        timeoutMs: 5_000
    })
    await nextTick()
    assert.equal(sessions.length, 1)
    const session = sessions[0]
    assert.equal(session.tty, false)

    const stdoutDone = collect(handle.stdout)

    handle.stdin.write('{"jsonrpc":"2.0","id":1}\n')
    await nextTick()
    assert.equal(
        Buffer.concat(session.stdinChunks).toString('utf8'),
        '{"jsonrpc":"2.0","id":1}\n'
    )
    assert.equal(session.stdinEof, false)

    session.stdout.write('{"jsonrpc":"2.0","result":{}}\n')
    handle.stdin.write('more\n')
    await nextTick()
    assert.equal(
        Buffer.concat(session.stdinChunks).toString('utf8'),
        '{"jsonrpc":"2.0","id":1}\nmore\n'
    )

    handle.stdin.end()
    await nextTick()
    assert.equal(session.stdinEof, true)

    session.status({ status: 'Success' } as V1Status)
    session.ws.close()
    const result = await handle.result
    assert.equal(result.exitCode, 0)
    assert.equal(await stdoutDone, '{"jsonrpc":"2.0","result":{}}\n')

    handle.stdin.write('after-settle')
    assert.equal(
        Buffer.concat(session.stdinChunks).toString('utf8'),
        '{"jsonrpc":"2.0","id":1}\nmore\n'
    )
})

test('streamInteractive abort sends stdin EOF before closing the socket', async () => {
    const { podExec, sessions } = makePodExec()
    const handle = podExec.streamInteractive({
        cmd: ['hermes', 'acp'],
        timeoutMs: 5_000
    })
    await nextTick()
    const session = sessions[0]

    let eofBeforeClose = false
    session.ws.on('close', () => {
        eofBeforeClose = session.stdinEof
    })

    const rejected = assert.rejects(handle.result, /pod exec aborted/)
    handle.abort()
    await nextTick()
    assert.equal(session.stdinEof, true)
    assert.equal(session.ws.closed, true)
    assert.equal(eofBeforeClose, true)
    await rejected
})

test('streamInteractive rejects on timeout with stdin still open', async () => {
    const { podExec, sessions } = makePodExec()
    const handle = podExec.streamInteractive({
        cmd: ['hermes', 'acp'],
        timeoutMs: 1_000
    })
    await nextTick()
    assert.equal(sessions[0].stdinEof, false)
    await assert.rejects(handle.result, /pod exec timed out after 1000ms/)
    assert.equal(sessions[0].stdinEof, true)
})

test('streamInteractive close without status rejects instead of fabricating success', async () => {
    const { podExec, sessions } = makePodExec()
    const handle = podExec.streamInteractive({
        cmd: ['hermes', 'acp'],
        timeoutMs: 5_000
    })
    await nextTick()
    sessions[0].ws.close()
    await assert.rejects(handle.result, /pod exec closed without status/)
})
