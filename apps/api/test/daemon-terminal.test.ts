import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DaemonTerminal } from '../src/modules/terminal/daemon-terminal'

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
    assert.equal(cancelled, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(apiTokens.calls.deleted, ['tok-1'])
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
