import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalGateway } from '../src/modules/terminal/terminal.gateway'

const makeSocket = (): {
    socket: Record<string, unknown>
    frames: string[]
    fireClose(): void
} => {
    const frames: string[] = []
    const handlers = new Map<string, Array<() => void>>()
    const socket = {
        OPEN: 1,
        readyState: 1,
        send: (data: unknown): void => {
            if (typeof data === 'string') frames.push(data)
        },
        on: (event: string, fn: () => void): void => {
            handlers.set(event, [...(handlers.get(event) ?? []), fn])
        },
        close: (): void => {},
        ping: (): void => {}
    }
    return {
        socket,
        frames,
        fireClose: () => {
            for (const fn of handlers.get('close') ?? []) fn()
        }
    }
}

// The terminal's durable identity and its hold on the session (ADR-0029 §1):
// the gateway creates the row once every check passed, then acquires as the
// last fallible step of a resume.
const fakeTerminals = () => {
    const rows: Array<Record<string, unknown>> = []
    const handles: Array<[string, string]> = []
    return {
        rows,
        create: async (input: Record<string, unknown>) => {
            const row = { id: `tms_${rows.length + 1}`, ...input }
            rows.push(row)
            return row
        },
        bindToken: async () => {},
        setHandle: async (id: string, handle: string) => {
            handles.push([id, handle])
        },
        markHeld: async () => {},
        renewLease: async () => true,
        handles
    }
}

const fakeHolder = (
    outcome: string,
    reusable: Record<string, unknown> | null = null
) => {
    const calls: Array<[string, ...unknown[]]> = []
    return {
        calls,
        acquire: async (args: Record<string, unknown>) => {
            calls.push(['acquire', args])
            return outcome
        },
        reusableTerminal: async (args: Record<string, unknown>) => {
            calls.push(['reusableTerminal', args])
            return reusable
        },
        supersede: async (prevTerminalId: string) => {
            calls.push(['supersede', prevTerminalId])
        },
        finish: async (terminalId: string, cause: string) => {
            calls.push(['finish', terminalId, cause])
        }
    }
}

const runSession = async (args: {
    agent: Record<string, unknown>
    findById: () => Promise<unknown>
    // What the resume service answers when the client asks for a session's
    // TUI; the default never resolves one, like a runtime with no resume path.
    resolve?: () => Promise<unknown>
    resumeChatSessionId?: string
    prevTerminalId?: string
    terminals?: ReturnType<typeof fakeTerminals>
    holder?: ReturnType<typeof fakeHolder>
    // The sprites driver, so a test can see what resume the tunnel got and
    // drive the close it reports.
    spritesTunnel?: (req: Record<string, unknown>) => Promise<void>
    daemonTunnel?: (req: Record<string, unknown>) => Promise<void>
}): Promise<Array<Record<string, unknown>>> => {
    const { socket, frames, fireClose } = makeSocket()
    const gateway = new TerminalGateway(
        {} as never,
        {
            verifyBearerToken: async () => ({
                userId: 'u1',
                kind: 'human-session',
                provider: 'email',
                subject: 'usr_1'
            })
        } as never,
        { listForUser: async () => [{ agent: args.agent }] } as never,
        { findHostById: async () => ({ terminalEnabled: true }) } as never,
        { tunnel: args.spritesTunnel ?? (async () => {}) } as never,
        { tunnel: async () => {} } as never,
        { tunnel: args.daemonTunnel ?? (async () => {}) } as never,
        { findById: args.findById } as never,
        {} as never,
        { resolve: args.resolve ?? (async () => null) } as never,
        undefined,
        args.terminals as never,
        args.holder as never
    )
    await (
        gateway as unknown as {
            handleConnection(socket: unknown, req: unknown): Promise<void>
        }
    ).handleConnection(socket, {
        query: {
            agentId: 'agt-1',
            token: 'tok',
            ...(args.resumeChatSessionId
                ? { resumeChatSessionId: args.resumeChatSessionId }
                : {}),
            ...(args.prevTerminalId
                ? { prevTerminalId: args.prevTerminalId }
                : {})
        }
    })
    fireClose()
    return frames
        .map((frame) => {
            try {
                return JSON.parse(frame) as Record<string, unknown>
            } catch {
                return null
            }
        })
        .filter((frame): frame is Record<string, unknown> => frame !== null)
}

const daemonAgent = {
    id: 'agt-1',
    userId: 'u1',
    name: 'laptop agent',
    status: 'running',
    runtime: 'daemon',
    framework: 'claude-code',
    daemonId: 'dh-1',
    workspacePath: '/Users/me/.manyfold/workspaces/agt-1'
}

test('daemon session_info carries terminal_pty=false from the host row', async () => {
    const frames = await runSession({
        agent: daemonAgent,
        findById: async () => ({ id: 'dh-1', terminalPty: false })
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.terminal_pty, false)
})

test('daemon session_info reports null terminal_pty for unknown hosts', async () => {
    const frames = await runSession({
        agent: daemonAgent,
        findById: async () => null
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.terminal_pty, null)
})

test('non-daemon session_info omits terminal_pty', async () => {
    const frames = await runSession({
        agent: {
            ...daemonAgent,
            runtime: 'sprites',
            spriteName: 's',
            spriteId: 'sp-1',
            hostId: 'h-1',
            mountPath: '/work'
        },
        findById: async () => {
            throw new Error('should not be called')
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal('terminal_pty' in info, false)
})

/* The resume verdict rides on session_info because only the gateway knows it:
   it is decided against the session's turn lock at connect, which the client's
   own stream view lags (the turn ends while the shell stays plain) or leads (a
   chat turn starts under a TUI resumed while idle). Reported only when a
   resume was asked for, so a plain terminal says nothing about resumes. */
const spritesAgent = {
    ...daemonAgent,
    runtime: 'sprites',
    spriteName: 's',
    spriteId: 'sp-1',
    hostId: 'h-1',
    mountPath: '/work'
}

test('session_info omits the resume outcome when none was asked for', async () => {
    const frames = await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resolve: async () => {
            throw new Error('should not be consulted')
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal('resume' in info, false)
})

test('session_info reports a resume withheld for a turn in flight', async () => {
    const frames = await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({ resume: null, outcome: 'turn-in-flight' })
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.resume, 'turn-in-flight')
})

test('session_info reports an applied resume once the hold is acquired', async () => {
    const terminals = fakeTerminals()
    const holder = fakeHolder('applied')
    let tunnelResume: unknown = 'unset'
    const frames = await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        terminals,
        holder,
        spritesTunnel: async (req) => {
            tunnelResume = req.resume
            ;(req.onClose as (cause: string) => void)('client-closed')
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.resume, 'applied')
    // The id rides on the frame so the tab can name it on a reconnect.
    assert.equal(info.terminal_id, 'tms_1')
    assert.equal(terminals.rows.length, 1)
    assert.deepEqual(holder.calls[0], [
        'acquire',
        {
            terminalId: 'tms_1',
            userId: spritesAgent.userId,
            agentId: 'agt-1',
            sessionId: 'cs-1',
            expectedRef: 'thread-1'
        }
    ])
    assert.deepEqual(tunnelResume, {
        command: ['codex', 'resume', 'thread-1'],
        env: {}
    })
    // The driver's close reaches the holder with its cause.
    assert.deepEqual(holder.calls[1], ['finish', 'tms_1', 'client-closed'])
})

// Losing the acquire is not an error: the terminal still opens, as a plain
// shell, and the frame says another terminal owns the session.
test('a lost acquire opens a plain shell and reports session-held', async () => {
    const holder = fakeHolder('session-held')
    let tunnelResume: unknown = 'unset'
    const frames = await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        terminals: fakeTerminals(),
        holder,
        spritesTunnel: async (req) => {
            tunnelResume = req.resume
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.resume, 'session-held')
    assert.equal(tunnelResume, null)
})

// Without a durable identity nothing could release the hold, so a resume
// is never applied over it — the honest word is unavailable.
test('a resume is not applied without a terminal identity', async () => {
    let tunnelResume: unknown = 'unset'
    const frames = await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        spritesTunnel: async (req) => {
            tunnelResume = req.resume
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.resume, 'unavailable')
    assert.equal(tunnelResume, null)
    assert.equal('terminal_id' in info, false)
})

// An API restart makes the tab reconnect with the terminal it had; that one
// must be retired before the new one acquires, or the tab's own reconnect
// would be refused as session-held.
test('a reconnect retires the terminal it names before acquiring', async () => {
    const holder = fakeHolder('applied')
    await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        prevTerminalId: 'tms_0',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        terminals: fakeTerminals(),
        holder
    })
    assert.deepEqual(
        holder.calls.map((call) => call[0]),
        ['supersede', 'acquire']
    )
    assert.equal(holder.calls[0][1], 'tms_0')
})

// A runtime with no resume path never consults the service; the honest word
// for the resume the client asked for is still "unavailable", not silence.
test('session_info reports unavailable when the runtime cannot resume at all', async () => {
    const frames = await runSession({
        agent: { ...daemonAgent, runtime: 'k8s' },
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        resolve: async () => {
            throw new Error('should not be consulted')
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.resume, 'unavailable')
})

// A daemon that owns its terminals (ADR-0029 §6): the tab attaches to the
// terminal it names — hold and all — instead of opening another, a new one
// is addressed by its row from the start, and a daemon without the
// capability keeps today's stream-bound pty.
const owningHost = async () => ({
    terminalPty: true,
    clientFeatures: ['pty.command', 'pty.terminal.v1']
})

test('an owning daemon attaches the tab to the terminal it names, without a new row or acquire', async () => {
    const terminals = fakeTerminals()
    const holder = fakeHolder('applied', {
        id: 'tms_prev',
        tokenId: 'tok-old',
        heldSessionId: 'cs-1'
    })
    let tunnelReq: Record<string, unknown> | null = null
    const frames = await runSession({
        agent: daemonAgent,
        findById: owningHost,
        resumeChatSessionId: 'cs-1',
        prevTerminalId: 'tms_prev',
        resolve: async () => ({
            resume: { command: ['claude', '--resume', 's-1'], env: {} },
            outcome: 'applied',
            ref: 's-1'
        }),
        terminals,
        holder,
        daemonTunnel: async (req) => {
            tunnelReq = req
        }
    })
    assert.deepEqual(terminals.rows, [], 'no new row')
    assert.deepEqual(
        holder.calls.map((call) => call[0]),
        ['reusableTerminal'],
        'neither superseded nor acquired'
    )
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.terminal_id, 'tms_prev')
    assert.equal(info.resume, 'applied')
    const req = tunnelReq as Record<string, unknown> | null
    assert.equal(req?.ownedTerminalId, 'tms_prev')
    assert.equal(req?.boundTokenId, 'tok-old')
    assert.deepEqual(
        (req?.resume as { command: string[] } | null)?.command,
        ['claude', '--resume', 's-1'],
        'the command still goes, for the daemon that lost the terminal'
    )
})

test('with nothing to attach to, an owning daemon gets a new terminal addressed by its row', async () => {
    const terminals = fakeTerminals()
    const holder = fakeHolder('applied')
    let tunnelReq: Record<string, unknown> | null = null
    await runSession({
        agent: daemonAgent,
        findById: owningHost,
        resumeChatSessionId: 'cs-1',
        prevTerminalId: 'tms_dead',
        resolve: async () => ({
            resume: { command: ['claude', '--resume', 's-1'], env: {} },
            outcome: 'applied',
            ref: 's-1'
        }),
        terminals,
        holder,
        daemonTunnel: async (req) => {
            tunnelReq = req
        }
    })
    assert.equal(terminals.rows.length, 1)
    assert.deepEqual(terminals.handles, [['tms_1', 'tms_1']])
    assert.deepEqual(
        holder.calls.map((call) => call[0]),
        ['reusableTerminal', 'supersede', 'acquire']
    )
    const req = tunnelReq as Record<string, unknown> | null
    assert.equal(req?.ownedTerminalId, 'tms_1')
    assert.equal(req?.boundTokenId, null)
})

test('a daemon without the capability keeps the stream-bound terminal', async () => {
    const terminals = fakeTerminals()
    const holder = fakeHolder('applied')
    let tunnelReq: Record<string, unknown> | null = null
    await runSession({
        agent: daemonAgent,
        findById: async () => ({
            terminalPty: true,
            clientFeatures: ['pty.command']
        }),
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['claude', '--resume', 's-1'], env: {} },
            outcome: 'applied',
            ref: 's-1'
        }),
        terminals,
        holder,
        daemonTunnel: async (req) => {
            tunnelReq = req
        }
    })
    assert.deepEqual(terminals.handles, [])
    assert.deepEqual(
        holder.calls.map((call) => call[0]),
        ['acquire']
    )
    const req = tunnelReq as Record<string, unknown> | null
    assert.equal('ownedTerminalId' in (req ?? {}), false)
})
