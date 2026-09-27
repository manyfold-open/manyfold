import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentAdapterRegistry } from '../src/modules/agents/adapters/adapter-registry'
import { HermesAgentAdapter } from '../src/modules/agents/adapters/hermes-agent.adapter'
import { OpenclawAgentAdapter } from '../src/modules/agents/adapters/openclaw-agent.adapter'
import {
    FrameworkExecResolver,
    type FrameworkExec,
    type FrameworkExecRunResult
} from '../src/modules/agents/adapters/framework-exec'
import { reconcilerFor } from './helpers/reconcile-fixture'
import { spritesHostRow } from './helpers/runtime-context-fixture'

// #405 regression: report-driven reconcile for Hermes/OpenClaw sprites died in
// FrameworkExecResolver before reaching the framework CLI. These tests run the
// REAL reconcile service, adapter registry, adapters and resolver — only the
// sprite exec transport and the accounts lookup are stubbed — so a structural
// incompatibility between reconcile and sprites execution cannot hide behind a
// mocked AgentAdapterRegistry again.

const HERMES_HOME = '/home/sprite/.hermes'
const HERMES_VENV_PYTHON = `${HERMES_HOME}/hermes-agent/venv/bin/python3`
const OPENCLAW_WS = '/home/sprite/.openclaw/workspace'

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'hermes',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    daemonId: null,
    hostId: 'host-1',
    primaryAgentId: 'agent-1',
    mountPath: HERMES_HOME,
    homeDir: HERMES_HOME,
    namespace: null,
    ingressHost: null,
    clusterId: null,
    spriteUrl: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const fakeDbAgent = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    framework: 'hermes',
    runtime: 'sprites',
    name: 'Primary Display',
    internalId: 'agent-1',
    status: 'failed',
    failureReason: 'not present in runtime',
    workspacePath: `${HERMES_HOME}/profiles/agent-1`,
    mountPath: HERMES_HOME,
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    accountId: 'acc-1',
    fileRoots: [],
    extras: {},
    model: null,
    namespace: null,
    ingressHost: null,
    clusterId: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = (rows: ReturnType<typeof fakeDbAgent>[]) => {
    const inserts: Array<Record<string, unknown>> = []
    const updates: Array<{ set: Record<string, unknown> }> = []
    return {
        inserts,
        updates,
        select: () => ({
            from: () => ({
                where: async () => rows
            })
        }),
        update: () => ({
            set: (s: Record<string, unknown>) => ({
                where: async () => {
                    updates.push({ set: s })
                }
            })
        }),
        insert: () => ({
            values: async (row: Record<string, unknown>) => {
                inserts.push(row)
            }
        })
    }
}

const HERMES_PROFILES_JSON = JSON.stringify([
    {
        name: 'default',
        path: HERMES_HOME,
        is_default: true,
        gateway_running: true,
        model: 'gpt-x',
        provider: 'openai',
        has_env: true,
        skill_count: 2,
        alias_path: null,
        active: true
    }
])

const OPENCLAW_AGENTS_JSON = JSON.stringify([
    {
        id: 'main',
        workspace: OPENCLAW_WS,
        model: 'claude-opus',
        identity: { name: 'Main' }
    }
])

// The host daemon's exec, recorded: every command the adapters run on the
// sprite goes through it (ADR-0036 R6).
class FakeTransportResolver extends FrameworkExecResolver {
    readonly execs: Array<{ opts: { cmd: string[] } }> = []
    behavior: (cmd: string[]) => FrameworkExecRunResult | null = () => null

    private exec(): FrameworkExec {
        return {
            run: async (req) => {
                this.execs.push({ opts: { cmd: req.cmd } })
                return (
                    this.behavior(req.cmd) ?? {
                        exitCode: 1,
                        stdout: '',
                        stderr: 'command not stubbed'
                    }
                )
            }
        }
    }

    override async forRuntime(): Promise<FrameworkExec> {
        return this.exec()
    }

    override async forHost(): Promise<FrameworkExec> {
        return this.exec()
    }
}

const frameworkStub = (framework: string) => ({ framework })

const makeHarness = () => {
    const resolver = new FakeTransportResolver(
        {} as never,
        {} as never,
        {} as never
    )
    const registry = new AgentAdapterRegistry(
        frameworkStub('claude-code') as never,
        frameworkStub('codex') as never,
        frameworkStub('gemini-cli') as never,
        frameworkStub('pi') as never,
        frameworkStub('antigravity-cli') as never,
        new OpenclawAgentAdapter(resolver),
        new HermesAgentAdapter(resolver),
        frameworkStub('dify') as never,
        frameworkStub('langflow') as never,
        frameworkStub('a2a') as never
    )
    return { resolver, registry }
}

// The #405 headline scenario: a fence-valid ready report reaches a hermes
// sprite whose agent row was poisoned to 'failed'. The real adapter must
// exec through the host daemon (bash -lc, venv python resolved from the
// host's declared homeDir — NOT mountPath, which diverges on
// custom-workspace runtimes) and heal the row.
test('verifiedByReport reconcile heals a false-failed hermes sprites agent through the real adapter chain', async () => {
    const { resolver, registry } = makeHarness()
    resolver.behavior = (cmd) =>
        cmd[0] === HERMES_VENV_PYTHON
            ? { exitCode: 0, stdout: HERMES_PROFILES_JSON, stderr: '' }
            : null
    const db = makeDb([fakeDbAgent()])
    const svc = reconcilerFor(db, registry)

    await svc.reconcileRuntime(
        fakeRuntime({ mountPath: '/home/sprite/custom-ws' }) as never,
        { verifiedByReport: true }
    )

    assert.equal(resolver.execs.length, 1, 'first venv candidate must hit')
    assert.equal(resolver.execs[0].opts.cmd[0], HERMES_VENV_PYTHON)
    assert.equal(resolver.execs[0].opts.cmd[1], '-c')
    assert.equal(db.inserts.length, 0)
    assert.equal(db.updates.length, 1)
    assert.equal(db.updates[0].set.status, 'ready')
    assert.equal(
        db.updates[0].set.failureReason,
        null,
        'heal must clear the stale "not present in runtime" reason'
    )
    assert.equal(
        'name' in db.updates[0].set,
        false,
        'the framework alias must not replace the user-facing primary name'
    )
})

test('verifiedByReport reconcile heals a false-failed openclaw sprites agent through the real adapter chain', async () => {
    const { resolver, registry } = makeHarness()
    resolver.behavior = (cmd) =>
        cmd.join(' ') === 'openclaw agents list --json'
            ? { exitCode: 0, stdout: OPENCLAW_AGENTS_JSON, stderr: '' }
            : null
    const db = makeDb([
        fakeDbAgent({
            framework: 'openclaw',
            workspacePath: OPENCLAW_WS,
            mountPath: OPENCLAW_WS
        })
    ])
    const svc = reconcilerFor(db, registry)

    await svc.reconcileRuntime(
        fakeRuntime({
            framework: 'openclaw',
            mountPath: OPENCLAW_WS,
            homeDir: '/home/sprite/.openclaw'
        }) as never,
        { verifiedByReport: true }
    )

    assert.equal(resolver.execs.length, 1)
    assert.deepEqual(resolver.execs[0].opts.cmd, [
        'openclaw',
        'agents',
        'list',
        '--json'
    ])
    assert.equal(db.updates.length, 1)
    assert.equal(db.updates[0].set.status, 'ready')
    assert.equal(db.updates[0].set.failureReason, null)
    assert.equal('name' in db.updates[0].set, false)
})

// WHY: after deleting a primary, the framework's undeletable built-in
// default/main profile can coexist with the promoted secondary's exact
// profile. The exact profile is authoritative; the built-in must not be
// aliased onto the same row or inserted as a phantom agent.
test('sprites reconcile ignores the built-in profile when the promoted primary has an exact live profile', async () => {
    const { resolver, registry } = makeHarness()
    resolver.behavior = (cmd) =>
        cmd.join(' ') === 'openclaw agents list --json'
            ? {
                  exitCode: 0,
                  stdout: JSON.stringify([
                      {
                          id: 'main',
                          workspace: OPENCLAW_WS,
                          identity: { name: 'Main' }
                      },
                      {
                          id: 'agent-1',
                          workspace: '/workspace/promoted',
                          identity: { name: 'Primary Display' }
                      }
                  ]),
                  stderr: ''
              }
            : null
    const db = makeDb([
        fakeDbAgent({
            framework: 'openclaw',
            status: 'ready',
            failureReason: null,
            workspacePath: '/workspace/promoted',
            mountPath: '/workspace/promoted'
        })
    ])
    const svc = reconcilerFor(db, registry)

    await svc.reconcileRuntime(
        fakeRuntime({
            framework: 'openclaw',
            mountPath: OPENCLAW_WS,
            homeDir: '/home/sprite/.openclaw'
        }) as never,
        { verifiedByReport: true }
    )

    assert.equal(db.updates.length, 1)
    assert.equal(db.inserts.length, 0)
    assert.equal(db.updates[0].set.workspacePath, '/workspace/promoted')
})

// WHY: sprites exec support must not weaken the sleep gate — a non-report
// touch on an all-asleep service sprite still returns before any exec, so
// the VM is never woken for billing.
test('non-report reconcile on a sleeping hermes sprite still skips without any exec', async () => {
    const { resolver, registry } = makeHarness()
    const db = makeDb([fakeDbAgent({ status: 'ready' })])
    const svc = reconcilerFor(db, registry, {
        host: spritesHostRow({ powerState: 'suspended' }),
        daemon: null
    })

    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(resolver.execs.length, 0, 'sleep gate must precede any exec')
    assert.equal(db.updates.length, 0)
    assert.equal(db.inserts.length, 0)
})

// WHY: the adapter truth contract — a failing CLI listing must throw (feeding
// the reconcile failure backoff), never masquerade as an empty sprite.
test('reconcile records a failure when the openclaw listing exits non-zero', async () => {
    const { resolver, registry } = makeHarness()
    resolver.behavior = () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'gateway not running'
    })
    const db = makeDb([fakeDbAgent({ framework: 'openclaw' })])
    const svc = reconcilerFor(db, registry)

    await assert.rejects(
        svc.reconcileRuntime(fakeRuntime({ framework: 'openclaw' }) as never, {
            verifiedByReport: true
        }),
        /openclaw agents list failed/
    )
    assert.equal(db.updates.length, 0)
    assert.equal(db.inserts.length, 0)
})

test('hermes discovery failure on every python candidate throws instead of returning empty', async () => {
    const { resolver, registry } = makeHarness()
    resolver.behavior = () => null
    const db = makeDb([fakeDbAgent()])
    const svc = reconcilerFor(db, registry)

    await assert.rejects(
        svc.reconcileRuntime(fakeRuntime() as never, {
            verifiedByReport: true
        }),
        /hermes profile discovery failed/
    )
    assert.equal(
        resolver.execs.length,
        6,
        'every python candidate must be tried before giving up'
    )
    assert.equal(db.updates.length, 0)
    assert.equal(db.inserts.length, 0)
})
