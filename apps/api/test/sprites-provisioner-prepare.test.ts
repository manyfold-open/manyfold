import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import type { BootstrapContext } from '../src/modules/agents/bootstrap/framework-bootstrap'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import type { SandboxExecProbeResult } from '../src/modules/agent-runtimes/provisioning/sandbox-exec-health'

// WHY: preparing a runtime on a bare sandbox is agent create's provisioning
// minus the agent: the row is reserved on the named host, the framework is
// installed (a coding CLI to the resolved version; a service framework
// installed and started with no provider yet), the host helpers are laid down
// and the row published ready — and a failure removes only the row, never the
// user's sandbox.

const account = {
    id: 'spa_1',
    slug: 'acct',
    tokenCiphertext: 'enc',
    tokenKeyVersion: 1
}

const row = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art_prep',
        userId: 'user_1',
        name: 'sandbox-001-claude-code',
        framework: 'claude-code',
        kind: 'sprites',
        status: 'pending',
        currentPhase: 'creating_sprite',
        failureReason: null,
        accountId: account.id,
        spriteName: 'sbx-1',
        spriteId: 'sprite-1',
        hostId: 'sbx_1',
        clusterId: null,
        daemonId: null,
        homeDir: null,
        namespace: null,
        ingressHost: null,
        mountPath: '/home/sprite/.manyfold/workspaces',
        primaryAgentId: null,
        frameworkVersion: null,
        createdAt: new Date('2026-09-11T00:00:00Z'),
        updatedAt: new Date('2026-09-11T00:00:00Z'),
        ...overrides
    }) as AgentRuntimeRow

class TestProvisioner extends SpritesProvisioner {
    installed: Array<{ framework: string; ctx: BootstrapContext }> = []
    installResult: string | null = '2.1.300'
    installError: Error | null = null

    protected async probeExec(): Promise<SandboxExecProbeResult> {
        return { ok: true, attempts: 1 }
    }

    protected async installCodingFramework(
        ctx: BootstrapContext,
        framework: 'claude-code' | 'codex' | 'gemini-cli'
    ): Promise<string | null> {
        this.installed.push({ framework, ctx })
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
        deleted: string[]
        hermesRuns: unknown[]
        shellEnv: unknown[]
    } = {
        reserve: [],
        statusPatches: [],
        provisioningPatches: [],
        phases: [],
        deleted: [],
        hermesRuns: [],
        shellEnv: []
    }
    const runtimes = {
        findHostById: async () => ({
            id: 'sbx_1',
            userId: 'user_1',
            kind: 'sandbox',
            status: 'active',
            accountId: account.id,
            spriteId: 'sprite-1',
            spriteName: 'sbx-1'
        }),
        applyStatusPatch: async (
            _id: string,
            patch: Partial<AgentRuntimeRow>
        ) => {
            calls.statusPatches.push(patch)
            stored = row({ ...stored, ...patch } as Partial<AgentRuntimeRow>)
        },
        setPhase: async (_id: string, phase: string | null) => {
            calls.phases.push(phase)
        },
        applyProvisioningPatch: async (
            _id: string,
            patch: Partial<AgentRuntimeRow>
        ) => {
            calls.provisioningPatches.push(patch)
            stored = row({ ...stored, ...patch } as Partial<AgentRuntimeRow>)
        },
        findById: async () => stored,
        setSandboxHostSprite: async () => {},
        delete: async (id: string) => {
            calls.deleted.push(id)
        }
    }
    const provisioner = new TestProvisioner(
        {} as never,
        {
            getById: async () => account,
            decryptToken: () => 'tok'
        } as never,
        runtimes as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
        { run: async () => ({ homeDir: undefined }) } as never,
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
        { framework: 'openclaw' } as never,
        { framework: 'narranexus' } as never,
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

test('a coding CLI is installed to the resolved version and the row is published ready with no agent', async () => {
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
    assert.equal(reserve.framework, 'claude-code')
    assert.equal(reserve.mountPath, '/home/sprite/.manyfold/workspaces')
    assert.equal(h.provisioner.installed.length, 1)
    assert.equal(h.provisioner.installed[0].ctx.agentId, '')
    assert.equal(h.provisioner.installed[0].ctx.frameworkVersion, '2.1.300')
    assert.deepEqual(h.calls.phases, ['bootstrapping', null])
    assert.equal(
        (h.calls.provisioningPatches[0] as { homeDir: string }).homeDir,
        '/home/sprite'
    )
    assert.equal(
        (h.calls.provisioningPatches[0] as { frameworkVersion: string })
            .frameworkVersion,
        '2.1.300'
    )
    assert.ok(
        h.calls.statusPatches.some(
            (p) => (p as { status?: string }).status === 'ready'
        )
    )
    assert.equal(out.runtime.primaryAgentId, null)
    assert.equal(out.generatedCredentials, undefined)
    assert.equal(h.calls.deleted.length, 0)
})

test('a service framework is installed and started without a provider, and its endpoint lands on the row', async () => {
    const h = buildHarness()
    const out = await h.provisioner.prepareRuntime({
        userId: 'user_1',
        framework: 'hermes',
        hostId: 'sbx_1'
    })
    assert.equal(h.calls.hermesRuns.length, 1)
    assert.deepEqual(
        (h.calls.hermesRuns[0] as { credentials: unknown }).credentials,
        {}
    )
    assert.equal(
        (h.calls.reserve[0] as { mountPath: string }).mountPath,
        '/home/sprite/.hermes'
    )
    assert.deepEqual(out.generatedCredentials, {
        apiServerKey: 'k1',
        runtimeReportToken: 'r1'
    })
    assert.equal(
        (h.calls.provisioningPatches[0] as { ingressHost: string }).ingressHost,
        'sbx-1.sprites.app'
    )
    assert.equal(h.provisioner.installed.length, 0)
})

test('a failed install removes the row it added and leaves the sandbox alone', async () => {
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
    assert.deepEqual(
        h.calls.deleted,
        ['art_prep'].map(() => h.calls.deleted[0])
    )
    assert.equal(h.calls.deleted.length, 1)
    assert.ok(
        !h.calls.statusPatches.some(
            (p) => (p as { status?: string }).status === 'ready'
        )
    )
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
