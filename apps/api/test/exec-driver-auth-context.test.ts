import assert from 'node:assert/strict'
import test from 'node:test'
import type { DaemonAuthContextRef } from '@manyfold/shared'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import {
    SpritesExecDriver,
    wrapSpriteCommand
} from '../src/modules/chat/adapters/sprites-exec-driver'

const ref: DaemonAuthContextRef = {
    framework: 'codex',
    runtimeId: 'art_1',
    profileId: 'rap_' + 'a'.repeat(26),
    bindingVersion: 4
}

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
    const sprite = wrapSpriteCommand(
        ['codex', 'exec'],
        '/ws',
        undefined,
        '/ws/agt'
    )
    assert.match(sprite[2], /CODEX_HOME="\$\{CODEX_HOME:-\$HOME\/\.codex\}"/)
})

test('bare sprite exec refuses a profile-bound agent instead of running the sandbox sign-in', () => {
    const driver = new SpritesExecDriver({} as never, 'sprite-1', {} as never, {
        sessionRegistry: {} as never,
        agentId: 'agt',
        authContext: ref
    })
    assert.throws(
        () => driver.stream({ cmd: ['codex', 'exec'], timeoutMs: 1000 }),
        /auth_context_unsupported/
    )
})
