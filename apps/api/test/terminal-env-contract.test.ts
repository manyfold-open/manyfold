import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
    MF_ENV_API_URL,
    MF_ENV_DEPLOY_ENV,
    MF_ENV_TERMINAL_ID,
    MF_RUNTIME_IDENTITY_ENV_KEYS
} from '@manyfold/shared'
import { terminalEnvSurfaces } from './exec-env-contract'
import { terminalIdentityEnv } from '../src/modules/terminal/terminal-env'
import { DaemonTerminal } from '../src/modules/terminal/daemon-terminal'

// The terminal surfaces' half of the exec env contract (ADR-0029 §3): a shell
// the platform opens carries the same four-key runtime identity a chat turn
// does, plus MF_TERMINAL_ID. Every such shell is a daemon pty (ADR-0037 R6).

const fakeConfig = {
    get: (key: string) =>
        key === 'PUBLIC_API_BASE_URL'
            ? 'https://api.example.test'
            : key === 'MF_DEPLOY_ENV'
              ? 'staging'
              : undefined
} as never

class FakeClient extends EventEmitter {
    OPEN = 1
    readyState = 1
    send(): void {}
    close(): void {
        this.readyState = 3
    }
}

test('the terminal surface is declared once, for the daemon', () => {
    assert.deepEqual(
        terminalEnvSurfaces.map((surface) => surface.runtime),
        ['daemon']
    )
    for (const surface of terminalEnvSurfaces) {
        assert.equal(surface.identity, 'per-session')
        assert.equal(surface.terminalId, 'per-session')
    }
})

test('terminalIdentityEnv composes all four identity keys plus the terminal id', () => {
    const env = terminalIdentityEnv({
        config: fakeConfig,
        agentId: 'agt_1',
        terminalId: 'tms_1',
        tokenPlaintext: 'mfr_terminal'
    })
    for (const key of MF_RUNTIME_IDENTITY_ENV_KEYS)
        assert.ok(env[key], `${key} missing from the terminal identity env`)
    assert.equal(env.MF_AGENT_ID, 'agt_1')
    assert.equal(env.MF_API_TOKEN, 'mfr_terminal')
    assert.equal(env[MF_ENV_API_URL], 'https://api.example.test/api')
    assert.equal(env[MF_ENV_DEPLOY_ENV], 'staging')
    assert.equal(env[MF_ENV_TERMINAL_ID], 'tms_1')
})

test('a terminal without a durable row carries no MF_TERMINAL_ID', () => {
    const env = terminalIdentityEnv({
        config: undefined,
        agentId: 'agt_1',
        terminalId: null,
        tokenPlaintext: 'mfr_terminal'
    })
    assert.equal(MF_ENV_TERMINAL_ID in env, false)
    // Without a public API base the URL key is honestly absent rather than
    // pointing the CLI at nothing.
    assert.equal(MF_ENV_API_URL in env, false)
    assert.equal(env[MF_ENV_DEPLOY_ENV], 'local')
})

test('the daemon arm injects the four identity keys and MF_TERMINAL_ID into pty.open', async () => {
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
    const hostAccess = {
        withHost: async (
            args: { host: { id: string } },
            work: (session: Record<string, unknown>) => Promise<unknown>
        ) =>
            work({
                host: args.host,
                daemon: { clientFeatures: [] },
                daemonId: args.host.id,
                rpc: (call: Record<string, unknown>) =>
                    (registry.rpc as (args: unknown) => Promise<unknown>)({
                        daemonId: args.host.id,
                        ...call
                    })
            }),
        hold: () => ({ release: async () => {} })
    }
    const terminal = new DaemonTerminal(
        registry as never,
        { resolveAgentEnv: async () => ({}) } as never,
        {
            mint: async () => ({
                tokenId: 'tok-1',
                plaintext: 'mfr_terminal_token'
            }),
            hardDelete: async () => {}
        } as never,
        { findById: async (id: string) => ({ id, kind: 'local', providerRef: null, name: 'laptop' }) } as never,
        hostAccess as never,
        fakeConfig
    )
    await terminal.tunnel({
        agent: {
            id: 'agt_1',
            userId: 'user-1',
            daemonId: 'dh-1',
            workspacePath: '/home/me/ws',
            mountPath: '/workspace',
            extras: {}
        } as never,
        hostId: 'dh-1',
        placement: 'daemon',
        terminalId: 'tms_1',
        cols: 80,
        rows: 24,
        client: new FakeClient() as never,
        onClose: () => {}
    })
    const env = (
        (streamCall as Record<string, unknown> | null)?.payload as {
            env?: Record<string, string>
        }
    )?.env
    assert.ok(env)
    for (const key of MF_RUNTIME_IDENTITY_ENV_KEYS)
        assert.ok(env[key], `${key} missing from the daemon terminal env`)
    assert.equal(env.MF_AGENT_ID, 'agt_1')
    assert.equal(env.MF_API_TOKEN, 'mfr_terminal_token')
    assert.equal(env[MF_ENV_API_URL], 'https://api.example.test/api')
    assert.equal(env[MF_ENV_DEPLOY_ENV], 'staging')
    assert.equal(env[MF_ENV_TERMINAL_ID], 'tms_1')
})
