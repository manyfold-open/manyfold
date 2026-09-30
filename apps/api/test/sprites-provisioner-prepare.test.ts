import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import type { AgentRuntimeRow, RuntimeProvider } from '@manyfold/db'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'

// WHY: preparing a runtime on a bare sandbox is agent create's provisioning
// minus the agent: the (host, framework) row is claimed on the named host, the
// host's daemon is brought up, the framework is set up through it (a coding
// CLI's directories and configuration, and the CLI at the resolved version; a
// service framework installed and run by the daemon with no provider yet) and
// the row published ready — and a failure leaves the row `failed` in its slot,
// never touching the user's sandbox.

const provider = { id: 'rtp_1', kind: 'sprites', name: 'acct' } as RuntimeProvider

const host = {
    id: 'sbx_1',
    userId: 'user_1',
    kind: 'hosted',
    providerId: provider.id,
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sprite-1' },
    name: 'sandbox-001',
    status: 'ready',
    generation: 1,
    keepAwake: false
}

const row = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art_prep',
        userId: 'user_1',
        name: 'sandbox-001-claude-code',
        framework: 'claude-code',
        status: 'installing',
        currentPhase: 'bootstrapping',
        failureReason: null,
        hostId: 'sbx_1',
        mountPath: '/home/sprite/.manyfold/workspaces',
        frameworkVersion: null,
        createdAt: new Date('2026-09-11T00:00:00Z'),
        updatedAt: new Date('2026-09-11T00:00:00Z'),
        ...overrides
    }) as AgentRuntimeRow

interface SessionExec {
    open: boolean
    script: string
    env?: Record<string, string>
}

// `version`: what every version probe on the machine answers, so an install
// to that version is already done. `failWith`: every command fails so.
const buildHarness = (opts: { version?: string; failWith?: string } = {}) => {
    let stored: AgentRuntimeRow | null = null
    const calls: {
        reserve: unknown[]
        statusPatches: unknown[]
        provisioningPatches: unknown[]
        phases: unknown[]
        daemonAsked: string[]
        sessionExecs: SessionExec[]
        serviceSetUps: Array<Record<string, unknown>>
    } = {
        reserve: [],
        statusPatches: [],
        provisioningPatches: [],
        phases: [],
        daemonAsked: [],
        sessionExecs: [],
        serviceSetUps: []
    }
    const runtimes = {
        applyStatusPatch: async (_id: string, patch: Partial<AgentRuntimeRow>) => {
            calls.statusPatches.push(patch)
            stored = row({ ...stored, ...patch } as Partial<AgentRuntimeRow>)
        },
        setPhase: async (_id: string, phase: string | null) => {
            calls.phases.push(phase)
        },
        applyProvisioningPatch: async (_id: string, patch: Partial<AgentRuntimeRow>) => {
            calls.provisioningPatches.push(patch)
            stored = row({ ...stored, ...patch } as Partial<AgentRuntimeRow>)
        },
        findById: async () => stored
    }
    const provisioner = new SpritesProvisioner(
        {} as never,
        { findForUser: async () => host, findById: async () => host } as never,
        {} as never,
        {
            providerForHost: async () => provider,
            spritesClientForHost: async () => ({ client: {}, spriteName: 'sbx-1', provider }),
            spritesLoggerFor: () => ({ debug() {}, info() {}, warn() {}, error() {} })
        } as never,
        {} as never,
        {} as never,
        {
            withHost: async (
                args: { host: { id: string } },
                work: (session: unknown) => Promise<unknown>
            ) => {
                calls.daemonAsked.push(args.host.id)
                let open = true
                try {
                    return await work({
                        host: args.host,
                        daemonId: args.host.id,
                        exec: async (req: { stdin: string; env?: Record<string, string> }) => {
                            calls.sessionExecs.push({ open, script: req.stdin, env: req.env })
                            if (opts.failWith)
                                return { exitCode: 1, stdout: '', stderr: opts.failWith }
                            return { exitCode: 0, stdout: opts.version ?? '', stderr: '' }
                        }
                    })
                } finally {
                    open = false
                }
            }
        } as never,
        {} as never,
        runtimes as never,
        {
            setUp: async (args: Record<string, unknown>) => {
                calls.serviceSetUps.push(args)
                return {
                    frameworkVersion: null,
                    generatedCredentials: { apiServerKey: 'k1' },
                    home: '/home/sprite/.hermes'
                }
            }
        } as never,
        {
            reserveSpriteRuntime: async (input: Record<string, unknown>) => {
                calls.reserve.push(input)
                stored = row({
                    id: input.id as string,
                    framework: input.framework as AgentRuntimeRow['framework'],
                    mountPath: input.mountPath as string
                })
                return { runtime: stored, hostCreated: false }
            }
        } as never,
        { get: () => undefined } as never,
        {} as never,
        undefined
    )
    return { provisioner, calls, stored: () => stored }
}

test('a coding CLI is set up through the host daemon to the resolved version and the row is published ready with no agent', async () => {
    const h = buildHarness({ version: '2.1.300' })
    const out = await h.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'claude-code',
        hostId: 'sbx_1',
        frameworkVersion: '2.1.300',
        frameworkVersionSource: 'latest'
    })
    const reserve = h.calls.reserve[0] as Record<string, unknown>
    assert.equal(reserve.hostId, 'sbx_1')
    assert.equal(reserve.providerId, 'rtp_1')
    assert.equal(reserve.framework, 'claude-code')
    assert.equal(reserve.mountPath, '/home/sprite/.manyfold/workspaces')
    assert.deepEqual(h.calls.daemonAsked, ['sbx_1'], 'the setup goes through the daemon (R6)')
    const [setup] = h.calls.sessionExecs
    assert.match(setup.script, /mkdir -p '\/home\/sprite\/\.manyfold\/workspaces'/)
    assert.match(setup.script, /mkdir -p "\$HOME\/\.claude"/)
    assert.deepEqual(h.calls.phases, [null])
    assert.equal(
        (h.calls.provisioningPatches[0] as { frameworkVersion: string }).frameworkVersion,
        '2.1.300'
    )
    assert.ok(h.calls.statusPatches.some((p) => (p as { status?: string }).status === 'ready'))
    assert.equal(out.generatedCredentials, undefined)
})

test('a service framework is set up through the daemon session without a provider', async () => {
    const h = buildHarness()
    const out = await h.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'hermes',
        hostId: 'sbx_1'
    })
    assert.equal(h.calls.serviceSetUps.length, 1)
    const setUp = h.calls.serviceSetUps[0]
    assert.deepEqual(setUp.credentials, {})
    assert.equal(setUp.framework, 'hermes')
    assert.equal(setUp.runtimeId, (h.calls.reserve[0] as { id: string }).id)
    assert.ok(setUp.session, 'inside the session that holds the sandbox')
    assert.equal((h.calls.reserve[0] as { mountPath: string }).mountPath, '/home/sprite/.hermes')
    assert.deepEqual(out.generatedCredentials, { apiServerKey: 'k1' })
    assert.ok(h.calls.statusPatches.some((p) => (p as { status?: string }).status === 'ready'))
})

test('a failed setup leaves the row failed in its slot and the sandbox alone', async () => {
    const h = buildHarness({ failWith: 'npm exploded' })
    await assert.rejects(
        h.provisioner.prepareRuntime({
            userId: 'user_1',
            framework: 'codex',
            hostId: 'sbx_1'
        }),
        /npm exploded/
    )
    const failed = h.calls.statusPatches.find((p) => (p as { status?: string }).status === 'failed')
    assert.ok(failed)
    assert.match((failed as { failureReason?: string }).failureReason ?? '', /npm exploded/)
    assert.ok(!h.calls.statusPatches.some((p) => (p as { status?: string }).status === 'ready'))
})

test('a framework with no sprite bootstrap is refused before a row is reserved', async () => {
    const h = buildHarness()
    await assert.rejects(
        h.provisioner.prepareRuntime({
            userId: 'user_1',
            framework: 'dify',
            hostId: 'sbx_1'
        }),
        ConflictException
    )
    assert.equal(h.calls.reserve.length, 0)
})

// The four-step flow prepares a sandbox with no agent: pi's own directory
// (its quiet banner, the fd and ripgrep its tools need) is set up with the
// CLI, and the CLI answers offline before the row is ready.
test('a pi prepare sets up pi on the sandbox and checks the CLI offline', async () => {
    const h = buildHarness({ version: '0.87.1' })
    await h.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'pi',
        hostId: 'sbx_1',
        frameworkVersion: '0.87.1',
        frameworkVersionSource: 'latest'
    })
    assert.match(h.calls.sessionExecs[0].script, /mkdir -p "\$HOME\/\.pi\/agent"/)
    const verify = h.calls.sessionExecs.at(-1)!
    assert.equal(verify.script, 'pi --version\n')
    assert.deepEqual(verify.env, { PI_OFFLINE: '1' })
})

// WHY: a daemon exec is not platform-visible activity on a sprite, which
// suspends about a second after the last exec or task. The setup's commands
// must run inside the session that holds the machine awake, not after it.
test('a prepare runs its setup commands inside the session holding the sandbox', async () => {
    const h = buildHarness({ version: '2.1.300' })

    await h.provisioner.prepareRuntime({
        userId: 'user-1',
        hostId: 'sbx_1',
        framework: 'claude-code'
    } as never)

    assert.deepEqual(h.calls.daemonAsked, ['sbx_1'])
    assert.ok(h.calls.sessionExecs.length > 0)
    assert.ok(h.calls.sessionExecs.every((e) => e.open))
})
