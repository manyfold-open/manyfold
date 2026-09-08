import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalGateway } from '../src/modules/terminal/terminal.gateway'

const makeSocket = (): {
    socket: Record<string, unknown>
    frames: string[]
    fireClose(): void
} => {
    const frames: string[] = []
    const handlers = new Map<string, () => void>()
    const socket = {
        OPEN: 1,
        readyState: 1,
        send: (data: unknown): void => {
            if (typeof data === 'string') frames.push(data)
        },
        on: (event: string, fn: () => void): void => {
            handlers.set(event, fn)
        },
        close: (): void => {},
        ping: (): void => {}
    }
    return {
        socket,
        frames,
        fireClose: () => handlers.get('close')?.()
    }
}

const runSession = async (args: {
    agent: Record<string, unknown>
    findById: () => Promise<unknown>
    // What the resume service answers when the client asks for a session's
    // TUI; the default never resolves one, like a runtime with no resume path.
    resolve?: () => Promise<unknown>
    resumeChatSessionId?: string
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
        { tunnel: async () => {} } as never,
        { tunnel: async () => {} } as never,
        { tunnel: async () => {} } as never,
        { findById: args.findById } as never,
        {} as never,
        { resolve: args.resolve ?? (async () => null) } as never
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

test('session_info reports an applied resume', async () => {
    const frames = await runSession({
        agent: spritesAgent,
        findById: async () => null,
        resumeChatSessionId: 'cs-1',
        resolve: async () => ({
            resume: { command: ['codex', 'resume', 'thread-1'], env: {} },
            outcome: 'applied'
        })
    })
    const info = frames.find((frame) => frame.type === 'session_info')
    assert.ok(info)
    assert.equal(info.resume, 'applied')
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
