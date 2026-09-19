import assert from 'node:assert/strict'
import test from 'node:test'
import type { DaemonAuthContextRef } from '@manyfold/shared'
import { DAEMON_FEATURE_AUTH_CONTEXT } from '@manyfold/shared'
import { agentCredentials, runtimeHosts, userModelProviders, type Agent } from '@manyfold/db'
import { ExecDriverFactory } from '../src/modules/chat/adapters/exec-driver-factory'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'

const ref: DaemonAuthContextRef = {
    framework: 'codex',
    runtimeId: 'art_1',
    profileId: 'rap_' + 'a'.repeat(26),
    bindingVersion: 4
}

test('per-turn auth selection controls the actual driver, and local/profile operations never decrypt the bound provider', async () => {
    let providerReads = 0
    const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => {
        if (table === userModelProviders) { providerReads++; throw new Error('stale provider cannot be decrypted') }
        if (table === agentCredentials) return []
        if (table === runtimeHosts) return [{ kind: 'daemon', status: 'active', cliVersion: '4.1.0', rpcLastSeenAt: new Date(), clientFeatures: [DAEMON_FEATURE_AUTH_CONTEXT] }]
        return []
    } }) }) }) }
    const factory = new ExecDriverFactory(db as never, {} as never, { decrypt: () => { throw new Error('unused stale provider') } } as never, {} as never, {} as never, {} as never,
        { resolveAgentEnv: async () => ({}) } as never)
    const agent = { id: 'agent', userId: 'user', framework: 'codex', runtime: 'daemon', runtimeId: 'runtime',
        daemonId: 'daemon', modelProviderId: 'old-provider', runtimeAuthProfileId: ref.profileId, runtimeAuthBindingVersion: 4,
        extras: { modelConfig: { source: 'runtime-local' } } } as unknown as Agent
    const local = await factory.forAgent(agent.id, agent, 'runtime-local')
    assert.equal(local.authContext?.profileId, ref.profileId)
    const platform = await factory.forAgent(agent.id, agent, 'platform')
    assert.equal(platform.authContext, null, 'one platform turn does not inherit the saved profile selection')
    assert.equal(providerReads, 0, 'factory reads credentials once but validates a provider only on requested platform dispatch')
    await assert.rejects(platform.resolvePriceScope!(), /stale provider/)
    assert.equal(providerReads, 1)
})

const registryCapturing = () => {
    const payloads: Record<string, unknown>[] = []
    const registry = {
        streamRpc: (args: { payload: Record<string, unknown> }) => {
            payloads.push(args.payload)
            return {
                refId: 'ref',
                result: Promise.resolve({ exitCode: 0 }),
                cancel: () => {}
            }
        }
    }
    return { registry, payloads }
}

test('a daemon driver built for a profile-bound agent stamps the selection on every exec.start', () => {
    const { registry, payloads } = registryCapturing()
    const driver = new DaemonExecDriver(
        registry as never,
        'dh_x',
        { MF_AGENT_ID: 'agt' },
        undefined,
        ref
    )
    driver.stream({ cmd: ['codex', 'exec'], timeoutMs: 1000 })
    assert.deepEqual(payloads[0].authSelection, { mode: 'profile', ...ref })
    const plain = new DaemonExecDriver(registry as never, 'dh_x', {
        MF_AGENT_ID: 'agt'
    })
    plain.stream({ cmd: ['codex', 'exec'], timeoutMs: 1000 })
    assert.equal(
        'authSelection' in payloads[1],
        false,
        'an inherited agent sends the old payload'
    )
})

test('the codex HOME relocation no longer re-pins CODEX_HOME over a daemon-injected profile', () => {
    const { registry, payloads } = registryCapturing()
    new DaemonExecDriver(
        registry as never,
        'dh_x',
        undefined,
        undefined,
        ref
    ).stream({
        cmd: ['codex', 'exec'],
        codexHome: '/ws/agt',
        timeoutMs: 1000
    })
    const cmd = payloads[0].cmd as string[]
    assert.match(cmd[2], /CODEX_HOME="\$\{CODEX_HOME:-\$HOME\/\.codex\}"/)
})
