import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRuntimeSummary, SandboxSummary } from '@manyfold/shared'
import {
    computeSpriteTargets,
    spriteHostOccupancy,
    type SpriteAttachTarget,
    type SpriteBlockedTarget
} from '../src/lib/agentCreate/spriteTargets'

const runtime = (
    patch: Partial<AgentRuntimeSummary> = {}
): AgentRuntimeSummary => ({
    id: 'rt_1',
    userId: 'usr_1',
    name: 'runtime',
    framework: 'claude-code',
    frameworkVersion: null,
    kind: 'sprites',
    status: 'ready',
    accountSlug: 'acct',
    clusterId: null,
    clusterName: null,
    spriteName: 'sprite-a',
    spriteId: 'spr_a',
    hostId: 'host_a',
    mountPath: '/work',
    namespace: null,
    ingressHost: null,
    endpointUrl: null,
    controlUiEnabled: false,
    dashboardEnabled: false,
    dashboardState: null,
    keepAliveEnabled: false,
    dashboardUrl: null,
    currentPhase: null,
    failureReason: null,
    primaryAgentId: null,
    startedAt: null,
    lastBootstrappedAt: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    agentsCount: 1,
    daemonId: null,
    daemonName: null,
    daemonOnline: null,
    daemonCliVersion: null,
    homeDir: null,
    workspaceBaseDir: null,
    lastSeenAt: null,
    serviceStatus: 'ready',
    serviceStatusAt: null,
    ...patch
})

const sandbox = (patch: Partial<SandboxSummary> = {}): SandboxSummary => ({
    id: 'sbx_1',
    userId: 'usr_1',
    name: 'sandbox',
    accountSlug: 'acct',
    spriteName: 'sprite-1',
    spriteStatus: 'running',
    terminalEnabled: false,
    terminalModelCredentials: false,
    activeSecondsThisPeriod: 0,
    agentsCount: 0,
    detectedFrameworks: [],
    cliVersion: null,
    latestCliVersion: null,
    cliUpdateAvailable: false,
    emptiedAt: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...patch
})

const attachTargets = (
    runtimes: AgentRuntimeSummary[],
    framework: Parameters<typeof computeSpriteTargets>[1],
    sandboxes: SandboxSummary[] = []
): SpriteAttachTarget[] =>
    computeSpriteTargets(runtimes, framework, sandboxes).filter(
        (t): t is SpriteAttachTarget => t.type === 'attach'
    )

const blockedTargets = (
    runtimes: AgentRuntimeSummary[],
    framework: Parameters<typeof computeSpriteTargets>[1],
    sandboxes: SandboxSummary[] = []
): SpriteBlockedTarget[] =>
    computeSpriteTargets(runtimes, framework, sandboxes).filter(
        (t): t is SpriteBlockedTarget => t.type === 'blocked'
    )

test('matching-framework sprite runtime becomes a reuse target', () => {
    const targets = computeSpriteTargets(
        [runtime({ id: 'rt_cc', framework: 'claude-code' })],
        'claude-code'
    )
    assert.equal(targets.length, 1)
    assert.equal(targets[0].type, 'reuse')
    assert.equal(
        targets[0].type === 'reuse' ? targets[0].runtime.id : '',
        'rt_cc'
    )
})

test('a sandbox running a different coding framework is an attach target', () => {
    // host_a runs claude-code; selecting codex should offer it as an attach.
    const targets = computeSpriteTargets(
        [runtime({ id: 'rt_cc', framework: 'claude-code', hostId: 'host_a' })],
        'codex'
    )
    assert.equal(targets.length, 1)
    assert.equal(targets[0].type, 'attach')
    assert.equal(targets[0].type === 'attach' ? targets[0].hostId : '', 'host_a')
    // No sandbox list supplied, so the friendly name is unknown -> null. The UI
    // falls back to spriteName/hostId; it must never surface a stale wrong name.
    assert.equal(targets[0].type === 'attach' ? targets[0].name : '', null)
})

test('attach target for a sandbox-with-runtimes resolves its friendly name', () => {
    // The name lives on SandboxSummary, not the runtime; it must be joined in by
    // host id so the picker leads with "prod-box" instead of the sprite/host id.
    const targets = attachTargets(
        [runtime({ id: 'rt_cc', framework: 'claude-code', hostId: 'host_a' })],
        'codex',
        [sandbox({ id: 'host_a', name: 'prod-box' })]
    )
    assert.equal(targets.length, 1)
    assert.equal(targets[0].name, 'prod-box')
})

test('a sandbox already running the framework is reuse, never attach', () => {
    const runtimes = [
        runtime({ id: 'rt_cc', framework: 'claude-code', hostId: 'host_a' }),
        runtime({ id: 'rt_cx', framework: 'codex', hostId: 'host_a' })
    ]
    const all = computeSpriteTargets(runtimes, 'codex')
    assert.equal(all.length, 1)
    assert.equal(all[0].type, 'reuse')
    assert.equal(attachTargets(runtimes, 'codex').length, 0)
})

// Coding frameworks never touch the sprite's public port, so they cannot block a
// service framework. This case used to be filtered out entirely.
test('a service framework attaches to a sandbox running only coding frameworks', () => {
    const targets = attachTargets(
        [
            runtime({ id: 'rt_cc', framework: 'claude-code', hostId: 'host_a' }),
            runtime({ id: 'rt_cx', framework: 'codex', hostId: 'host_a' })
        ],
        'hermes'
    )
    assert.equal(targets.length, 1)
    assert.equal(targets[0].hostId, 'host_a')
})

// One sprite exposes one public port and all three service frameworks serve their
// gateway on it. The sandbox stays in the list as blocked — dropping it would
// leave the user wondering where their sandbox went.
test('a sandbox running a service framework blocks a second one, naming the occupant', () => {
    const runtimes = [
        runtime({ id: 'rt_oc', framework: 'openclaw', hostId: 'host_a' })
    ]
    assert.equal(attachTargets(runtimes, 'hermes').length, 0)
    const blocked = blockedTargets(runtimes, 'hermes')
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].hostId, 'host_a')
    assert.equal(blocked[0].reason, 'service-slot-taken')
    assert.equal(
        blocked[0].blockedBy,
        'openclaw',
        'the row must name the occupant or the user cannot act on it'
    )
})

test('a coding framework is unaffected by a service occupant', () => {
    assert.equal(
        attachTargets(
            [runtime({ id: 'rt_oc', framework: 'openclaw', hostId: 'host_a' })],
            'codex'
        ).length,
        1
    )
})

test('a stopped service instance releases the service slot', () => {
    assert.equal(
        attachTargets(
            [
                runtime({
                    id: 'rt_oc',
                    framework: 'openclaw',
                    hostId: 'host_a',
                    status: 'stopped'
                })
            ],
            'hermes'
        ).length,
        1
    )
})

// Four co-resident runtimes used to fill a sandbox and hide it from the picker.
test('a sandbox running four frameworks still accepts a fifth', () => {
    const runtimes = ['claude-code', 'codex', 'openclaw', 'narranexus'].map(
        (framework, i) =>
            runtime({
                id: `rt_${i}`,
                framework: framework as AgentRuntimeSummary['framework'],
                hostId: 'host_full',
                spriteId: `spr_${i}`
            })
    )
    const targets = attachTargets(runtimes, 'gemini-cli')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].runtimeCount, 4)
})

test('failed/stopped runtimes do not count toward capacity or presence', () => {
    const runtimes = [
        runtime({ id: 'rt_dead', framework: 'codex', status: 'failed' }),
        runtime({ id: 'rt_cc', framework: 'claude-code', status: 'ready' })
    ]
    // codex is only present as a failed runtime -> still attachable.
    const targets = attachTargets(runtimes, 'codex')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].runtimeCount, 1)
    assert.deepEqual(targets[0].frameworks, ['claude-code'])
})

test('non-ready matching runtime is neither reuse nor attach (pending)', () => {
    // codex pending on host_a: not ready (no reuse) and present (no attach).
    const runtimes = [
        runtime({ id: 'rt_cx', framework: 'codex', status: 'pending' })
    ]
    assert.equal(computeSpriteTargets(runtimes, 'codex').length, 0)
})

test('non-sprite runtimes are ignored', () => {
    const runtimes = [
        runtime({ id: 'rt_k8s', framework: 'claude-code', kind: 'k8s' }),
        runtime({ id: 'rt_dmn', framework: 'claude-code', kind: 'daemon' })
    ]
    assert.equal(computeSpriteTargets(runtimes, 'claude-code').length, 0)
})

test('a sandbox retained after its last agent is deleted remains an attach target', () => {
    // Deleting the last agent starts the empty-host reaper clock but deliberately
    // keeps the provisioned VM. It must remain reusable instead of forcing the
    // user to consume another quota slot.
    const targets = attachTargets([], 'codex', [
        sandbox({
            id: 'sbx_bare',
            name: 'my-bare-box',
            emptiedAt: '2026-07-29T15:53:33.000Z'
        })
    ])
    assert.equal(targets.length, 1)
    assert.equal(targets[0].hostId, 'sbx_bare')
    assert.equal(targets[0].name, 'my-bare-box')
    assert.equal(targets[0].runtimeCount, 0)
})

test('a sandbox with runtimes is not duplicated by the sandbox list', () => {
    const runtimes = [
        runtime({ id: 'rt_cc', framework: 'claude-code', hostId: 'sbx_x' })
    ]
    // sandbox list also includes sbx_x; codex attach should appear once.
    const targets = attachTargets(runtimes, 'codex', [sandbox({ id: 'sbx_x' })])
    assert.equal(targets.length, 1)
    assert.equal(targets[0].hostId, 'sbx_x')
})

test('a bare sandbox is an attach target for a service framework too', () => {
    const targets = attachTargets([], 'hermes', [sandbox({ id: 'sbx_bare' })])
    assert.equal(targets.length, 1)
    assert.equal(targets[0].hostId, 'sbx_bare')
})

test('reuse targets are listed before attach, and blocked ones last', () => {
    const targets = computeSpriteTargets(
        [
            runtime({ id: 'rt_h', framework: 'hermes', hostId: 'host_reuse' }),
            runtime({ id: 'rt_o', framework: 'openclaw', hostId: 'host_block' }),
            runtime({
                id: 'rt_c',
                framework: 'codex',
                hostId: 'host_attach'
            })
        ],
        'hermes'
    )
    assert.deepEqual(
        targets.map((t) => t.type),
        ['reuse', 'attach', 'blocked']
    )
})

test('occupancy lists the live frameworks per host without a capacity number', () => {
    const occupancy = spriteHostOccupancy([
        runtime({ id: 'rt_a', framework: 'codex', hostId: 'host_a' }),
        runtime({ id: 'rt_b', framework: 'claude-code', hostId: 'host_a' }),
        runtime({
            id: 'rt_c',
            framework: 'gemini-cli',
            hostId: 'host_a',
            status: 'failed'
        })
    ])
    assert.deepEqual(occupancy.get('host_a'), {
        frameworks: ['codex', 'claude-code'],
        count: 2
    })
})
