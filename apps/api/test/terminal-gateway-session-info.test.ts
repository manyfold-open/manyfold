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
        {} as never
    )
    await (
        gateway as unknown as {
            handleConnection(socket: unknown, req: unknown): Promise<void>
        }
    ).handleConnection(socket, {
        query: { agentId: 'agt-1', token: 'tok' }
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
