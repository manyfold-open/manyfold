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

// A terminal the daemon owns (ADR-0029 §6): the stream is one attachment to
// it, so the browser going away detaches instead of killing, and the
// daemon's first event says whether the shell is the one it already had.
const ownedRegistry = () => {
    const calls: Array<Record<string, unknown>> = []
    const rpcCalls: Array<Record<string, unknown>> = []
    let onEvent: ((kind: string, data: string) => void) | null = null
    let resolveResult!: (payload: Record<string, unknown>) => void
    let cancelled = false
    const result = new Promise<Record<string, unknown>>((resolve) => {
        resolveResult = resolve
    })
    return {
        calls,
        rpcCalls,
        cancelled: () => cancelled,
        emit: (kind: string, data: string) => onEvent?.(kind, data),
        finish: (payload: Record<string, unknown>) => resolveResult(payload),
        registry: {
            streamRpc: (call: Record<string, unknown>) => {
                calls.push(call)
                onEvent = call.onEvent as (kind: string, data: string) => void
                return {
                    refId: 'ref-1',
                    result,
                    cancel: () => {
                        cancelled = true
                    }
                }
            },
            rpc: async (call: Record<string, unknown>) => {
                rpcCalls.push(call)
                return {}
            }
        }
    }
}

const TERMINAL_ID = 'tms_abcdefghijklmnopqrstuvwxyz'

test('an owned terminal is opened under its id and the browser going away only detaches', async () => {
    const r = ownedRegistry()
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        r.registry as never,
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
        onHandle: (refId) => handles.push(refId),
        ownedTerminalId: TERMINAL_ID,
        boundTokenId: null
    })
    assert.equal(
        (r.calls[0].payload as { terminalId?: string }).terminalId,
        TERMINAL_ID
    )
    assert.deepEqual(handles, [], 'the handle is the id, set by the gateway')

    client.emit('close')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(r.rpcCalls, [], 'no pty.close: the daemon keeps it')
    assert.equal(r.cancelled(), true)
    assert.equal(closeCause, 'detached')
    assert.deepEqual(apiTokens.calls.deleted, [], 'the shell keeps its token')
})

test("the daemon's attach verdict decides which token the shell carries", async () => {
    const run = async (mode: 'attached' | 'spawned') => {
        const r = ownedRegistry()
        const client = new FakeClient()
        const apiTokens = makeApiTokens()
        const terminal = new DaemonTerminal(
            r.registry as never,
            fakeConnections as never,
            apiTokens as never
        )
        const bound: string[] = []
        let closeCause: string | null = null
        await terminal.tunnel({
            agent: makeAgent() as never,
            cols: 80,
            rows: 24,
            client: client as never,
            onClose: (cause) => {
                closeCause = cause
            },
            onToken: (tokenId) => bound.push(tokenId),
            ownedTerminalId: TERMINAL_ID,
            boundTokenId: 'tok-old'
        })
        assert.deepEqual(bound, [], 'nothing bound before the daemon speaks')
        r.emit('pty.attach', JSON.stringify({ mode }))
        await new Promise((resolve) => setImmediate(resolve))
        const frames = client.sent
            .filter((data): data is string => typeof data === 'string')
            .map((data) => JSON.parse(data) as Record<string, unknown>)
        assert.deepEqual(frames.at(-1), { type: 'attached', mode })
        const afterAttach = [...apiTokens.calls.deleted]
        r.finish({ exitCode: 0 })
        await new Promise((resolve) => setImmediate(resolve))
        return {
            bound,
            afterAttach,
            deleted: apiTokens.calls.deleted,
            closeCause
        }
    }
    const attached = await run('attached')
    assert.deepEqual(attached.bound, [])
    assert.deepEqual(attached.afterAttach, ['tok-1'], 'fresh token unused')
    assert.deepEqual(attached.deleted, ['tok-1', 'tok-old'])
    assert.equal(attached.closeCause, 'exit')

    const spawned = await run('spawned')
    assert.deepEqual(spawned.bound, ['tok-1'])
    assert.deepEqual(spawned.afterAttach, ['tok-old'], 'old shell is gone')
    assert.deepEqual(spawned.deleted, ['tok-old', 'tok-1'])
    assert.equal(spawned.closeCause, 'exit')
})

test('a stream ended by another attachment closes the tab with 4409 and keeps the terminal', async () => {
    const r = ownedRegistry()
    const client = new FakeClient()
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        r.registry as never,
        fakeConnections as never,
        apiTokens as never
    )
    let closeCause: string | null = null
    await terminal.tunnel({
        agent: makeAgent() as never,
        cols: 80,
        rows: 24,
        client: client as never,
        onClose: (cause) => {
            closeCause = cause
        },
        ownedTerminalId: TERMINAL_ID,
        boundTokenId: null
    })
    r.finish({ detached: true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(client.closed, {
        code: 4409,
        reason: 'terminal attached elsewhere'
    })
    assert.equal(closeCause, 'detached')
    assert.deepEqual(apiTokens.calls.deleted, [])
})

test('closePty addresses an owned terminal by its id and a stream-bound pty by its refId', async () => {
    const r = ownedRegistry()
    const terminal = new DaemonTerminal(
        r.registry as never,
        fakeConnections as never,
        makeApiTokens() as never
    )
    await terminal.closePty('dh-1', TERMINAL_ID)
    await terminal.closePty('dh-1', 'ref-1')
    assert.deepEqual(
        r.rpcCalls.map((call) => call.payload),
        [{ terminalId: TERMINAL_ID }, { refId: 'ref-1' }]
    )
})

// ADR-0031: a herdr handoff carries the same env a pty would — the agent's
// env text, its connection tokens, the resume's own variables and the
// platform block with the terminal id and a fresh terminal token — as one
// unary call; a refusal drops the token again.
test('openInHerdr sends the pty env, the resume command and the labels in one rpc', async () => {
    const rpcCalls: Array<Record<string, unknown>> = []
    const registry = {
        streamRpc: () => {
            throw new Error('not a stream')
        },
        rpc: async (call: Record<string, unknown>) => {
            rpcCalls.push(call)
            return { paneId: 'w1:p2', tabId: 'w1:t2', workspaceId: 'w1', focused: true }
        }
    }
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )
    const tokens: string[] = []
    const result = await terminal.openInHerdr({
        agent: { ...makeAgent(), name: 'Reviewer' } as never,
        terminalId: 'tms_1',
        framework: 'claude-code',
        resume: {
            command: ['claude', '--resume', 'ref-1', '--dangerously-skip-permissions'],
            env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }
        },
        title: 'Fix the login bug',
        chatSessionId: 'cts_1',
        onToken: (tokenId) => tokens.push(tokenId)
    })
    assert.deepEqual(result, {
        paneId: 'w1:p2',
        tabId: 'w1:t2',
        workspaceId: 'w1',
        focused: true
    })
    assert.deepEqual(tokens, ['tok-1'])
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0].method, 'terminal.herdr.open')
    const payload = rpcCalls[0].payload as {
        terminalId: string
        framework: string
        command: string[]
        cwd: string
        env: Record<string, string>
        title: string
        agentName: string
        chatSessionId?: string
    }
    assert.equal(payload.terminalId, 'tms_1')
    // The daemon keeps one herdr tab per conversation with it.
    assert.equal(payload.chatSessionId, 'cts_1')
    assert.equal(payload.framework, 'claude-code')
    assert.deepEqual(payload.command, [
        'claude',
        '--resume',
        'ref-1',
        '--dangerously-skip-permissions'
    ])
    assert.equal(payload.cwd, '/Users/cy/.nca/workspaces/agent-1')
    assert.equal(payload.title, 'Fix the login bug')
    assert.equal(payload.agentName, 'Reviewer')
    assert.equal(payload.env.MY_FLAG, 'on')
    assert.equal(payload.env.GH_TOKEN, 'gho_terminal')
    assert.equal(payload.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '1')
    assert.equal(payload.env.MF_TERMINAL_ID, 'tms_1')
    assert.equal(payload.env.MF_API_TOKEN, 'mfr_terminal_token')
    assert.equal(payload.env.TERM, 'xterm-256color')
    assert.deepEqual(apiTokens.calls.deleted, [])
})

test('a herdr launch the daemon refuses drops the freshly minted token', async () => {
    const registry = {
        streamRpc: () => {
            throw new Error('not a stream')
        },
        rpc: async () => {
            throw new DaemonRpcResponseError('herdr_not_running: start herdr')
        }
    }
    const apiTokens = makeApiTokens()
    const terminal = new DaemonTerminal(
        registry as never,
        fakeConnections as never,
        apiTokens as never
    )
    await assert.rejects(
        terminal.openInHerdr({
            agent: makeAgent() as never,
            terminalId: 'tms_1',
            framework: 'codex',
            resume: { command: ['codex', 'resume', 'thr_1'], env: {} },
            title: 't'
        }),
        (err: unknown) => err instanceof DaemonRpcResponseError
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(apiTokens.calls.deleted, ['tok-1'])
})
