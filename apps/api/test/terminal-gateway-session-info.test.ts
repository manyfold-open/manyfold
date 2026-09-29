import test from 'node:test'
import assert from 'node:assert/strict'
import type { HostDaemonRow } from '@manyfold/db'
import { TerminalGateway } from '../src/modules/terminal/terminal.gateway'
import {
    contextOf,
    daemonRow,
    hostRow,
    k8sHostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

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
    // The agent's machine: a local computer by default.
    placement?: 'daemon' | 'sprites' | 'k8s'
    // The host daemon's row as the gateway reads it; null = none registered.
    daemon?: Partial<HostDaemonRow> | null
    // What the resume service answers when the client asks for a session's
    // TUI; the default never resolves one, like a runtime with no resume path.
    resolve?: () => Promise<unknown>
    resumeChatSessionId?: string
    prevTerminalId?: string
    terminals?: ReturnType<typeof fakeTerminals>
    holder?: ReturnType<typeof fakeHolder>
    // The daemon driver, so a test can see what resume the tunnel got and
    // drive the close it reports.
    daemonTunnel?: (req: Record<string, unknown>) => Promise<void>
    // The hosts a terminal took an active sandbox slot on.
    slots?: string[]
}): Promise<Array<Record<string, unknown>>> => {
    const { socket, frames, fireClose } = makeSocket()
    const placement = args.placement ?? 'daemon'
    const host =
        placement === 'daemon'
            ? hostRow({ id: 'dh-1', userId: 'u1' })
            : placement === 'k8s'
              ? k8sHostRow({ id: 'h-1', userId: 'u1', terminalEnabled: true })
              : spritesHostRow({ id: 'h-1', userId: 'u1', terminalEnabled: true })
    const daemon =
        args.daemon === null
            ? null
            : daemonRow({ hostId: host.id, userId: 'u1', ...args.daemon })
    const ctx = contextOf({
        agent: args.agent as never,
        runtime: runtimeRow({
            id: 'rt-1',
            userId: 'u1',
            hostId: host.id,
            framework: String(args.agent.framework)
        }),
        host,
        daemon
    })
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
        { contextForCaller: async () => ctx } as never,
        {} as never,
        {} as never,
        {} as never,
        { tunnel: args.daemonTunnel ?? (async () => {}) } as never,
        {
            defaultTerminalCwd: (agent: { mountPath: string }) =>
                agent.mountPath
        } as never,
        { resolve: args.resolve ?? (async () => null) } as never,
        undefined,
        args.terminals as never,
        args.holder as never,
        {
            reserveActiveSlot: async (input: { hostId: string }) => {
                args.slots?.push(input.hostId)
                return {}
            }
        } as never
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
    status: 'ready',
    framework: 'claude-code',
    runtimeId: 'rt-1',
    workspacePath: '/Users/me/.manyfold/workspaces/agt-1',
    extras: {}
}

test('daemon session_info carries terminal_pty=false from the host row', async () => {
    const frames = await runSession({
        agent: daemonAgent,
        daemon: { terminalPty: false }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.terminal_pty, false)
})

test('daemon session_info reports null terminal_pty when the daemon has not said', async () => {
    const frames = await runSession({
        agent: daemonAgent,
        daemon: { terminalPty: null }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.terminal_pty, null)
})

// Every terminal is its host's daemon's (ADR-0037 R6), a sandbox's too; the
// shell wakes a sleeping sprite, which takes one of the user's active slots.
test('a sandbox agent\'s terminal opens through its daemon, on an active slot', async () => {
    const slots: string[] = []
    let tunnels = 0
    const frames = await runSession({
        agent: { ...daemonAgent, mountPath: '/work' },
        placement: 'sprites',
        daemon: { terminalPty: true },
        slots,
        daemonTunnel: async () => {
            tunnels += 1
        }
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.terminal_pty, true)
    assert.equal(tunnels, 1)
    assert.deepEqual(slots, ['h-1'])
})

/* The resume verdict rides on session_info because only the gateway knows it:
   it is decided against the session's turn lock at connect, which the client's
   own stream view lags (the turn ends while the shell stays plain) or leads (a
   chat turn starts under a TUI resumed while idle). Reported only when a
   resume was asked for, so a plain terminal says nothing about resumes. */
const spritesAgent = { ...daemonAgent, mountPath: '/work' }
// A sandbox daemon that can run a resume as its shell's argv, without owning
// its terminals: the stream-bound pty with its durable row.
const sandboxDaemon = { clientFeatures: ['pty.command'] }

test('session_info omits the resume outcome when none was asked for', async () => {
    const frames = await runSession({
        agent: spritesAgent,
        placement: 'sprites',
        daemon: sandboxDaemon,
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
        placement: 'sprites',
        daemon: sandboxDaemon,
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
        placement: 'sprites',
        daemon: sandboxDaemon,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        terminals,
        holder,
        daemonTunnel: async (req) => {
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
        placement: 'sprites',
        daemon: sandboxDaemon,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        terminals: fakeTerminals(),
        holder,
        daemonTunnel: async (req) => {
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
        placement: 'sprites',
        daemon: sandboxDaemon,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied',
            ref: 'thread-1'
        }),
        daemonTunnel: async (req) => {
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
        placement: 'sprites',
        daemon: sandboxDaemon,
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
        agent: daemonAgent,
        placement: 'k8s',
        daemon: null,
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
const owningDaemon = {
    terminalPty: true,
    clientFeatures: ['pty.command', 'pty.terminal.v1']
}

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
        daemon: owningDaemon,
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
        daemon: owningDaemon,
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
        daemon: { terminalPty: true, clientFeatures: ['pty.command'] },
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

// A sandbox's own shell is its daemon's too, whatever provider made the
// machine; it carries the user's token (DaemonTerminal.tunnelSandbox), and
// on a sprite it takes one of the user's active sandbox slots first.
const runSandboxSession = async (host: ReturnType<typeof spritesHostRow>) => {
    const { socket, frames, fireClose } = makeSocket()
    const opened: Array<Record<string, unknown>> = []
    const slots: string[] = []
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
        {} as never,
        { findForUser: async () => host } as never,
        {
            findByHostId: async () =>
                daemonRow({ hostId: host.id, userId: 'u1', terminalPty: true })
        } as never,
        {} as never,
        {
            tunnelSandbox: async (req: Record<string, unknown>) => {
                opened.push(req)
            }
        } as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        {
            reserveActiveSlot: async (input: { hostId: string }) => {
                slots.push(input.hostId)
                return {}
            }
        } as never
    )
    await (
        gateway as unknown as {
            handleConnection(socket: unknown, req: unknown): Promise<void>
        }
    ).handleConnection(socket, {
        query: { sandboxId: host.id, token: 'tok' }
    })
    fireClose()
    const info = frames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .find((frame) => frame.type === 'session_info')
    return { info, opened, slots }
}

test('a bare sandbox shell opens through its daemon on a sprite and on a pod', async () => {
    const sprite = await runSandboxSession(
        spritesHostRow({ id: 'sbx-1', userId: 'u1', terminalEnabled: true, homeDir: '/home/sprite' })
    )
    assert.deepEqual(
        sprite.opened.map((req) => [req.daemonId, req.userId]),
        [['sbx-1', 'u1']]
    )
    assert.deepEqual(sprite.slots, ['sbx-1'])
    assert.equal(sprite.info?.runtime, 'sprites')
    assert.equal(sprite.info?.cwd, '/home/sprite')
    assert.equal(sprite.info?.terminal_pty, true)

    const pod = await runSandboxSession(
        k8sHostRow({ id: 'pdh-1', userId: 'u1', terminalEnabled: true })
    )
    assert.deepEqual(pod.opened.map((req) => req.daemonId), ['pdh-1'])
    assert.deepEqual(pod.slots, [], 'a pod takes no sandbox slot')
    assert.equal(pod.info?.runtime, 'k8s')
})
