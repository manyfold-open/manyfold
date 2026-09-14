import test from 'node:test'
import assert from 'node:assert/strict'
import type {
    AgentRuntimeSummary,
    DaemonHostSummary,
    RuntimeAccessSummary,
    SandboxSummary
} from '@manyfold/shared'
import {
    advanceBlockedKey,
    initialFlowState,
    nextStep,
    previousStep,
    withFramework,
    withRuntime
} from '../src/pages/AgentNew/v4/flowState'
import type { RuntimeChoice } from '../src/pages/AgentNew/v4/flowState'
import {
    FRAMEWORK_GROUPS,
    canUseSubscription,
    runsOnOurMachine
} from '../src/pages/AgentNew/v4/frameworkCatalog'
import {
    buildMachineOptions,
    buildNewMachineOptions
} from '../src/pages/AgentNew/v4/machineOptions'

const runtime = (
    over: Partial<AgentRuntimeSummary> & Pick<AgentRuntimeSummary, 'id'>
): AgentRuntimeSummary =>
    ({
        userId: 'u1',
        name: 'runtime',
        framework: 'claude-code',
        frameworkVersion: null,
        kind: 'sprites',
        status: 'ready',
        accountSlug: null,
        clusterId: null,
        clusterName: null,
        spriteName: 'sprite',
        spriteId: null,
        hostId: null,
        mountPath: '/',
        namespace: null,
        ingressHost: null,
        endpointUrl: null,
        controlUiEnabled: false,
        dashboardEnabled: false,
        dashboardState: null,
        keepAliveEnabled: false,
        currentPhase: null,
        failureReason: null,
        primaryAgentId: null,
        startedAt: null,
        lastBootstrappedAt: null,
        createdAt: '',
        updatedAt: '',
        agentsCount: 0,
        daemonId: null,
        daemonName: null,
        daemonOnline: null,
        daemonCliVersion: null,
        homeDir: null,
        workspaceBaseDir: null,
        lastSeenAt: null,
        serviceStatus: 'unknown',
        serviceStatusAt: null,
        ...over
    }) as AgentRuntimeSummary

const sandbox = (id: string, name: string): SandboxSummary =>
    ({ id, name, agentsCount: 0 }) as SandboxSummary

const daemon = (id: string, name: string): DaemonHostSummary =>
    ({ id, name }) as DaemonHostSummary

const access = (over: Partial<RuntimeAccessSummary>): RuntimeAccessSummary =>
    ({
        statefulSandboxLimit: 5,
        statefulSandboxUsage: 2,
        statefulSandboxRemaining: 3,
        cloudComputerEnabled: false,
        ...over
    }) as RuntimeAccessSummary

test('the nine types are split into exactly two groups, by where they run', () => {
    assert.equal(FRAMEWORK_GROUPS.length, 2)
    const entries = FRAMEWORK_GROUPS.flatMap((g) => g.entries)
    assert.equal(entries.length, 9)
    // The group boundary IS the step ② fork: everything in the first group
    // asks about a machine, everything in the second about a service.
    for (const group of FRAMEWORK_GROUPS)
        for (const entry of group.entries)
            assert.equal(
                runsOnOurMachine(entry.framework),
                group.id === 'onMachine',
                entry.framework
            )
})

test('only the CLIs that carry their own sign-in advertise a subscription', () => {
    for (const entry of FRAMEWORK_GROUPS.flatMap((g) => g.entries))
        assert.equal(
            entry.subscriptionKey !== undefined,
            canUseSubscription(entry.framework),
            entry.framework
        )
})

test('no row line ranks what a framework is good at', () => {
    // The identity line says what the thing IS. Ability words are what the
    // rejected three-group taxonomy was made of, and they are false here:
    // Claude Code orchestrates, OpenClaw writes code.
    const banned = /assistant|orchestrat|writes code|general-purpose/i
    for (const entry of FRAMEWORK_GROUPS.flatMap((g) => g.entries))
        assert.ok(!banned.test(entry.identityKey), entry.identityKey)
})

test('nothing is preselected, and each step names what it is waiting for', () => {
    const fresh = initialFlowState()
    assert.equal(fresh.framework, null)
    assert.equal(fresh.runtime, null)
    assert.equal(fresh.cost, null)
    assert.equal(advanceBlockedKey(fresh), 'web.agentNewV4.blocked.type')
    const typed = withFramework(fresh, 'claude-code')
    assert.equal(advanceBlockedKey({ ...typed, step: 'runtime' }), 'web.agentNewV4.blocked.runtime')
})

test('changing the type drops the answers that depended on it', () => {
    const choice: RuntimeChoice = {
        kind: 'runtime',
        runtimeId: 'r1',
        hostKind: 'sprites',
        hostLabel: 'dev-box',
        ownComputer: false
    }
    const state = withRuntime(
        withFramework(initialFlowState(), 'claude-code'),
        choice
    )
    const switched = withFramework({ ...state, cost: { kind: 'platform' } }, 'dify')
    assert.equal(switched.runtime, null)
    assert.equal(switched.cost, null)
    // Picking the same type again changes nothing — re-selecting your own
    // answer must not wipe the work behind it.
    assert.equal(withFramework(state, 'claude-code'), state)
})

test('steps clamp at both ends', () => {
    assert.equal(previousStep('type'), 'type')
    assert.equal(nextStep('name'), 'name')
    assert.equal(nextStep('type'), 'runtime')
})

test('a machine already running agents costs no sign-in; a prepared one does', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [
            runtime({ id: 'r1', hostId: 'h1', agentsCount: 3 }),
            runtime({ id: 'r2', hostId: 'h2', agentsCount: 0 })
        ],
        sandboxes: [sandbox('h1', 'dev-box'), sandbox('h2', 'sandbox-a1b2')],
        daemonHosts: []
    })
    const working = rows.find((r) => r.title === 'dev-box')
    const prepared = rows.find((r) => r.title === 'sandbox-a1b2')
    assert.equal(working?.signInCost, 'none')
    // The machine left behind by an abandoned run comes back as an ordinary
    // row — same shape as any other, no "last time" marker.
    assert.equal(prepared?.signInCost, 'next-step')
    assert.equal(prepared?.disabled, false)
})

test('a sandbox without the CLI offers to install it, and flags an empty one', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [],
        sandboxes: [sandbox('h9', 'scratch')],
        daemonHosts: []
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'needs-install')
    assert.equal(rows[0].signInCost, 'after')
    assert.equal(rows[0].idle, true)
})

test('your own computer is never installed onto, and says so in place', () => {
    const rows = buildMachineOptions({
        framework: 'gemini-cli',
        runtimes: [],
        sandboxes: [],
        daemonHosts: [daemon('d1', 'My MacBook')]
    })
    assert.equal(rows[0].state, 'not-installable')
    assert.equal(rows[0].disabled, true)
    assert.equal(rows[0].ownComputer, true)
})

test('a service slot already taken stays in the list with its reason', () => {
    const rows = buildMachineOptions({
        framework: 'openclaw',
        runtimes: [
            runtime({
                id: 'r1',
                hostId: 'h1',
                framework: 'hermes',
                agentsCount: 1
            })
        ],
        sandboxes: [sandbox('h1', 'dev-box')],
        daemonHosts: []
    })
    const blocked = rows.find((r) => r.state === 'service-slot-taken')
    assert.ok(blocked, 'the blocked sandbox must not be hidden')
    assert.equal(blocked?.disabled, true)
    assert.equal(blocked?.blockedBy, 'hermes')
})

test('a cloud computer holding another framework is shown, not dropped', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [
            runtime({
                id: 'r1',
                kind: 'k8s',
                framework: 'hermes',
                clusterName: 'hermes-prod'
            })
        ],
        sandboxes: [],
        daemonHosts: []
    })
    assert.equal(rows[0].state, 'framework-fixed')
    assert.equal(rows[0].disabled, true)
    assert.equal(rows[0].blockedBy, 'hermes')
})

test('an exhausted sandbox quota disables the row instead of hiding it', () => {
    const full = buildNewMachineOptions({
        framework: 'claude-code',
        access: access({ statefulSandboxRemaining: 0, statefulSandboxUsage: 5 })
    })
    const row = full.find((o) => o.kind === 'sandbox')
    assert.equal(row?.disabled, true)
    assert.equal(row?.used, 5)
    assert.equal(row?.limit, 5)
})

test('a cloud computer nobody bought reads as needing a plan, and stays', () => {
    const options = buildNewMachineOptions({
        framework: 'claude-code',
        access: access({ cloudComputerEnabled: false })
    })
    const cloud = options.find((o) => o.kind === 'cloudComputer')
    assert.ok(cloud, 'the row must be present so it can explain itself')
    assert.equal(cloud?.disabled, true)
})

test('the one framework that cannot use a daemon says so on that row', () => {
    const narra = buildNewMachineOptions({
        framework: 'narranexus',
        access: access({})
    })
    const claude = buildNewMachineOptions({
        framework: 'claude-code',
        access: access({})
    })
    assert.equal(
        narra.find((o) => o.kind === 'ownComputer')?.disabled,
        true
    )
    assert.equal(
        claude.find((o) => o.kind === 'ownComputer')?.disabled,
        false
    )
})
