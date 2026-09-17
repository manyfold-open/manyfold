import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DaemonTerminal } from '../src/modules/terminal/daemon-terminal'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'

const makeAgent = () => ({
    id: 'agent-1',
    userId: 'user-1',
    daemonId: 'dh-1',
    workspacePath: '/Users/cy/.nca/workspaces/agent-1',
    mountPath: '/workspace',
    extras: { envText: 'MY_FLAG=on' }
})

const CONNECTION_ENV = { GH_TOKEN: 'gho_terminal', GIT_CONFIG_COUNT: '1' }

const fakeConnections = {
    resolveAgentEnv: async () => CONNECTION_ENV
}

const makeApiTokens = () => {
    const calls = { minted: 0, deleted: [] as string[] }
    return {
        calls,
        mint: async () => {
            calls.minted += 1
            return { tokenId: 'tok-1', plaintext: 'mfr_terminal_token' }
        },
        hardDelete: async (args: { tokenId: string }) => {
            calls.deleted.push(args.tokenId)
        }
    }
}

class FakeClient extends EventEmitter {
    OPEN = 1
    readyState = 1
    sent: Array<string | Buffer> = []
    closed: { code: number; reason: string } | null = null

    send(data: string | Buffer): void {
        this.sent.push(data)
    }

    close(code = 1000, reason = ''): void {
        this.closed = { code, reason }
        this.readyState = 3
    }
}

test('daemon terminal passes requested cwd to pty.open', async () => {
    let streamCall: Record<string, unknown> | null = null
    let cancelled = false
    const registry = {
        streamRpc: (call: Record<string, unknown>) => {
            streamCall = call
            return {
                refId: 'ref-1',
                result: new Promise<Record<string, unknown>>(() => {}),
                cancel: () => {
                    cancelled = true
                }
            }
        },
        rpc: async () => ({})
    }
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )

    await terminal.tunnel({
        agent: makeAgent() as never,
        cols: 80,
        cwd: '/Users/cy/project',
        rows: 24,
        client: client as never,
        onClose: () => {}
    })

    const capturedStreamCall = streamCall as Record<string, unknown> | null
    assert.equal(
        (capturedStreamCall?.payload as { cwd?: string } | undefined)?.cwd,
        '/Users/cy/project'
    )
    client.emit('close')
    // The close now waits for the daemon's pty.close ack before it cancels
    // the stream and drops the token.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelled, true)
    assert.deepEqual(apiTokens.calls.deleted, ['tok-1'])
})

// ADR-0029 §1: the hold this terminal carries is released only over a
// process known to be dead, so the browser's close asks the daemon to close
// the pty and waits for the ack; nothing is released before it arrives.
test('client close asks the daemon to close the pty and waits for the ack', async () => {
    const rpcCalls: Array<Record<string, unknown>> = []
    let ackPty!: () => void
    const ack = new Promise<Record<string, unknown>>((resolve) => {
        ackPty = () => resolve({ ok: true })
    })
    let cancelled = false
    const registry = {
        streamRpc: () => ({
            refId: 'ref-1',
            result: new Promise<Record<string, unknown>>(() => {}),
            cancel: () => {
                cancelled = true
            }
        }),
        rpc: async (call: Record<string, unknown>) => {
            rpcCalls.push(call)
            return ack
        }
    }
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )
    const handles: string[] = []
    let closeCause: string | null = null
    await terminal.tunnel({
        agent: makeAgent() as never,
        cols: 80,
        rows: 24,
        client: client as never,
        onClose: (cause) => {
            closeCause = cause
        },
        onHandle: (refId) => handles.push(refId)
    })
    assert.deepEqual(handles, ['ref-1'])

    client.emit('close')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0].method, 'pty.close')
    assert.deepEqual(rpcCalls[0].payload, { refId: 'ref-1' })
    assert.equal(closeCause, null, 'nothing released before the ack')
    assert.equal(cancelled, false)
    assert.deepEqual(apiTokens.calls.deleted, [])

    ackPty()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closeCause, 'client-closed')
    assert.equal(cancelled, true)
    assert.deepEqual(apiTokens.calls.deleted, ['tok-1'])
})

// A daemon that merely lost its socket may still be running the pty: the
// close reports daemon-lost so the hold is kept for the lease to decide. A
// daemon that answered with an error never ran it: tunnel-failed.
test('the pty ending on its own reports why', async () => {
    const causeFor = async (err: Error): Promise<string | null> => {
        const registry = {
            streamRpc: () => ({
                refId: 'ref-1',
                result: Promise.reject(err),
                cancel: () => {}
            }),
            rpc: async () => ({})
        }
        const client = new FakeClient()
        const terminal = new DaemonTerminal(
            registry as never,
            fakeConnections as never,
            makeApiTokens() as never
        )
        let cause: string | null = null
        await terminal.tunnel({
            agent: makeAgent() as never,
            cols: 80,
            rows: 24,
            client: client as never,
            onClose: (value) => {
                cause = value
            }
        })
        await new Promise((resolve) => setImmediate(resolve))
        return cause
    }
    assert.equal(
        await causeFor(new Error('daemon dh-1 is not connected')),
        'daemon-lost'
    )
    assert.equal(
        await causeFor(new DaemonRpcResponseError('cwd does not exist')),
        'tunnel-failed'
    )
})

test('daemon terminal injects env text, connection env and identity per session (#781)', async () => {
    let streamCall: Record<string, unknown> | null = null
    const registry = {
        streamRpc: (call: Record<string, unknown>) => {
            streamCall = call
            return {
                refId: 'ref-1',
                result: new Promise<Record<string, unknown>>(() => {}),
                cancel: () => {}
            }
        },
        rpc: async () => ({})
    }
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )

    await terminal.tunnel({
        agent: makeAgent() as never,
        cols: 80,
        rows: 24,
        client: client as never,
        onClose: () => {}
    })

    const env = (
        (streamCall as Record<string, unknown> | null)?.payload as {
            env?: Record<string, string>
        }
    )?.env
    assert.ok(env)
    assert.equal(env.MY_FLAG, 'on')
    for (const [key, value] of Object.entries(CONNECTION_ENV))
        assert.equal(env[key], value, `connection env ${key} not carried`)
    assert.equal(env.MF_AGENT_ID, 'agent-1')
    assert.equal(env.MF_API_TOKEN, 'mfr_terminal_token')
    assert.equal(env.TERM, 'xterm-256color')
})

test('daemon terminal strips protocol byte before forwarding pty input', async () => {
    let resolveResult!: (value?: Record<string, unknown>) => void
    const result = new Promise<Record<string, unknown> | undefined>(
        (resolve) => {
            resolveResult = resolve
        }
    )
    const rpcCalls: Array<Record<string, unknown>> = []
    const registry = {
        streamRpc: () => ({
            refId: 'ref-1',
            result,
            cancel: () => {}
        }),
        rpc: async (call: Record<string, unknown>) => {
            rpcCalls.push(call)
            return {}
        }
    }
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )

    await terminal.tunnel({
        agent: makeAgent() as never,
        cols: 80,
        rows: 24,
        client: client as never,
        onClose: () => {}
    })

    client.emit('message', Buffer.from([0x00, 0x61]), true)
    await new Promise((resolve) => setImmediate(resolve))
    resolveResult()

    assert.equal(rpcCalls.length, 1)
    assert.deepEqual(
        (rpcCalls[0].payload as { data: string }).data,
        Buffer.from('a').toString('base64')
    )
})

test('daemon terminal sends pty.open failures to browser', async () => {
    const registry = {
        streamRpc: () => ({
            refId: 'ref-1',
            result: Promise.reject(new Error('node-pty is required')),
            cancel: () => {}
        })
    }
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )
    let closed = false

    await terminal.tunnel({
        agent: makeAgent() as never,
        cols: 80,
        rows: 24,
        client: client as never,
        onClose: () => {
            closed = true
        }
    })
    await new Promise((resolve) => setImmediate(resolve))

    const errorFrame = client.sent.find(
        (item): item is string =>
            typeof item === 'string' && item.includes('node-pty is required')
    )
    assert.ok(errorFrame)
    assert.equal(JSON.parse(errorFrame).type, 'error')
    assert.equal(client.closed?.reason, 'pty closed')
    assert.equal(closed, true)
})
