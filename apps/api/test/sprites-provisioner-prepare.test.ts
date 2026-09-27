import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import type { AgentRuntimeRow, RuntimeProvider } from '@manyfold/db'
import type { BootstrapContext } from '../src/modules/agents/bootstrap/framework-bootstrap'
import type { HostScriptRunner } from '../src/modules/agents/bootstrap/framework-version-install'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import { SpriteServiceBootstraps } from '../src/modules/agents/bootstrap/sprite-service-bootstraps'

// WHY: preparing a runtime on a bare sandbox is agent create's provisioning
// minus the agent: the (host, framework) row is claimed on the named host, the
// host's daemon is brought up, the framework is installed through it (a coding
// CLI to the resolved version; a service framework installed and started with
// no provider yet), the host helpers are laid down and the row published
// ready — and a failure leaves the row `failed` in its slot, never touching
// the user's sandbox.

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
        primaryAgentId: null,
        frameworkVersion: null,
        createdAt: new Date('2026-09-11T00:00:00Z'),
        updatedAt: new Date('2026-09-11T00:00:00Z'),
        ...overrides
    }) as AgentRuntimeRow

class TestProvisioner extends SpritesProvisioner {
    installed: Array<{ framework: string; ctx: BootstrapContext; runner: HostScriptRunner }> = []
    installResult: string | null = '2.1.300'
    installError: Error | null = null

    protected async installCodingFramework(
        ctx: BootstrapContext,
        framework: 'claude-code' | 'codex' | 'gemini-cli' | 'pi' | 'antigravity-cli',
        runner: HostScriptRunner
    ): Promise<string | null> {
        this.installed.push({ framework, ctx, runner })
        if (this.installError) throw this.installError
        return this.installResult
    }
}

const buildHarness = () => {
    let stored: AgentRuntimeRow | null = null
    const calls: {
        reserve: unknown[]
        statusPatches: unknown[]
        provisioningPatches: unknown[]
        phases: unknown[]
        daemonAsked: string[]
        hermesRuns: unknown[]
        shellEnv: unknown[]
        piSetups: BootstrapContext[]
    } = {
        reserve: [],
        statusPatches: [],
        provisioningPatches: [],
        phases: [],
        daemonAsked: [],
        hermesRuns: [],
        shellEnv: [],
        piSetups: []
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
    const provisioner = new TestProvisioner(
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
            ensureHostDaemon: async (args: { host: { id: string } }) => {
                calls.daemonAsked.push(args.host.id)
                return {
                    handle: { daemonId: args.host.id, started: false, generation: null },
                    workspace: { outcome: 'none' }
                }
            }
        } as never,
        { streamRpc: () => ({ result: Promise.resolve({ exitCode: 0 }), refId: 'r', cancel() {} }) } as never,
        {} as never,
        runtimes as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        {
            run: async () => ({ homeDir: undefined }),
            setupSandbox: async (ctx: BootstrapContext) => {
                calls.piSetups.push(ctx)
            }
        } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        new SpriteServiceBootstraps(
            {
                framework: 'hermes',
                run: async (ctx: BootstrapContext, credentials: unknown) => {
                    calls.hermesRuns.push({ ctx, credentials })
                    return {
                        homeDir: '/home/sprite/.hermes',
                        serviceName: 'hermes',
                        endpointUrl: 'https://sbx-1.sprites.app',
                        generatedCredentials: {
                            apiServerKey: 'k1',
                            runtimeReportToken: 'r1'
                        }
                    }
                }
            } as never,
            { framework: 'openclaw' } as never
        ),
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
        {
            write: async (input: unknown) => {
                calls.shellEnv.push(input)
            },
            installCli: async () => {}
        } as never,
        {} as never,
        {} as never,
        undefined,
        undefined
    )
    return { provisioner, calls, stored: () => stored }
}

test('a coding CLI is installed through the host daemon to the resolved version and the row is published ready with no agent', async () => {
    const h = buildHarness()
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
    assert.deepEqual(h.calls.daemonAsked, ['sbx_1'], 'the install goes through the daemon (R6)')
    assert.equal(h.provisioner.installed.length, 1)
    assert.equal(h.provisioner.installed[0].ctx.agentId, '')
    assert.equal(h.provisioner.installed[0].ctx.frameworkVersion, '2.1.300')
    assert.equal(typeof h.provisioner.installed[0].runner.run, 'function')
    assert.deepEqual(h.calls.phases, [null])
    assert.equal(
        (h.calls.provisioningPatches[0] as { frameworkVersion: string }).frameworkVersion,
        '2.1.300'
    )
    assert.ok(h.calls.statusPatches.some((p) => (p as { status?: string }).status === 'ready'))
    assert.equal(out.runtime.primaryAgentId, null)
    assert.equal(out.generatedCredentials, undefined)
})

test('a service framework is installed and started without a provider, and its endpoint is returned', async () => {
    const h = buildHarness()
    const out = await h.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'hermes',
        hostId: 'sbx_1'
    })
    assert.equal(h.calls.hermesRuns.length, 1)
    assert.deepEqual((h.calls.hermesRuns[0] as { credentials: unknown }).credentials, {})
    assert.equal((h.calls.reserve[0] as { mountPath: string }).mountPath, '/home/sprite/.hermes')
    assert.deepEqual(out.generatedCredentials, {
        apiServerKey: 'k1',
        runtimeReportToken: 'r1'
    })
    assert.equal(out.endpointUrl, 'https://sbx-1.sprites.app')
    assert.equal(h.provisioner.installed.length, 0)
})

test('a failed install leaves the row failed in its slot and the sandbox alone', async () => {
    const h = buildHarness()
    h.provisioner.installError = new Error('npm exploded')
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
    assert.equal((failed as { failureReason?: string }).failureReason, 'npm exploded')
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

// The four-step flow prepares a sandbox with no agent, so no bootstrap runs:
// pi's own directory (its quiet banner, the fd and ripgrep its tools need)
// is set up with the CLI instead. The other coding CLIs keep nothing there.
test('a pi prepare sets up pi on the sandbox; the other coding CLIs need nothing', async () => {
    const h = buildHarness()
    await h.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'pi',
        hostId: 'sbx_1',
        frameworkVersion: '0.87.1',
        frameworkVersionSource: 'latest'
    })
    assert.equal(h.calls.piSetups.length, 1)
    assert.equal(h.calls.piSetups[0].spriteName, 'sbx-1')

    const other = buildHarness()
    await other.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'codex',
        hostId: 'sbx_1',
        frameworkVersion: '0.9.0',
        frameworkVersionSource: 'latest'
    })
    assert.equal(other.calls.piSetups.length, 0)
})
