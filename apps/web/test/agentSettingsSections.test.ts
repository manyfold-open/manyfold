import test from 'node:test'
import assert from 'node:assert/strict'
import type { SdkAgent } from '@manyfold/sdk'
import { agentFramework, agentRuntime } from '@manyfold/shared'
import type { AgentSettingsSectionId } from '../src/lib/agentSettingsSections'
import {
    isAgentSettingsSection,
    sectionFromLegacyTab,
    sectionLabelKey,
    sectionPreconditionKey,
    sectionsFor,
    supportsSection
} from '../src/lib/agentSettingsSections'

let seq = 0
const makeAgent = (over: Partial<SdkAgent> = {}): SdkAgent => {
    seq += 1
    return {
        id: `agt_${seq}`,
        userId: 'usr_1',
        runtimeId: 'rt_1',
        daemonId: null,
        daemonNeedsUpgrade: false,
        name: `Agent ${seq}`,
        framework: 'claude-code',
        frameworkVersion: null,
        frameworkLatestVersion: null,
        frameworkUpgradeAvailable: false,
        frameworkVersionBlockedReason: null,
        cliVersion: null,
        cliLatestVersion: null,
        cliUpdateAvailable: false,
        runtime: 'sprites',
        status: 'running',
        spriteStatus: null,
        k8sPodPhase: null,
        accountSlug: null,
        clusterId: null,
        clusterName: null,
        spriteName: null,
        spriteId: null,
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
        internalId: 'int',
        model: null,
        extras: {},
        workspacePath: null,
        storageBytes: null,
        storageMeasuredAt: null,
        startedAt: null,
        lastActiveAt: null,
        lastMessageAt: null,
        lastBootstrappedAt: null,
        lastReconciledAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over
    }
}

test('a sandbox coding agent gets the full set of sections', () => {
    const ids = sectionsFor(makeAgent()).map((section) => section.id)
    assert.deepEqual(ids, [
        'overview',
        'model',
        'skills',
        'mcp',
        'context',
        'permissions',
        'connections',
        'environment',
        'storage',
        'channels',
        'a2a'
    ])
})

test('a daemon coding agent gains what the platform delivers (#781)', () => {
    // Env text and connection env ride every turn, context docs go over the
    // daemon exec channel and MCP config over its fs RPCs — a daemon coding
    // agent now carries the full section set.
    const agent = makeAgent({ runtime: 'daemon', daemonId: 'dmn_1' })
    const ids = sectionsFor(agent).map((section) => section.id)
    assert.deepEqual(ids, [
        'overview',
        'model',
        'skills',
        'mcp',
        'context',
        'permissions',
        'connections',
        'environment',
        'storage',
        'channels',
        'a2a'
    ])
})

test('a k8s agent still drops what nothing provisions into the pod', () => {
    const agent = makeAgent({ runtime: 'k8s' })
    assert.deepEqual(
        sectionsFor(agent).map((section) => section.id),
        [
            'overview',
            'model',
            'skills',
            'permissions',
            'storage',
            'channels',
            'a2a'
        ]
    )
    for (const id of ['environment', 'connections', 'context', 'mcp'] as const)
        assert.equal(supportsSection(agent, id), false, id)
})

test('a daemon openclaw agent has no per-turn env channel', () => {
    // Its turn payload carries no env field, so showing Environment would be a
    // lie; the precondition names openclaw rather than the runtime.
    const agent = makeAgent({
        runtime: 'daemon',
        daemonId: 'dmn_1',
        framework: 'openclaw'
    })
    assert.equal(supportsSection(agent, 'environment'), false)
    assert.equal(
        sectionPreconditionKey(agent, 'environment'),
        'web.agents.detail.environment.unavailableOpenclaw'
    )
    assert.equal(supportsSection(agent, 'connections'), false)
    assert.equal(
        sectionPreconditionKey(agent, 'connections'),
        'web.agents.detail.connections.unavailableFramework'
    )
})

test('a daemon hermes agent keeps environment but not connections', () => {
    const agent = makeAgent({
        runtime: 'daemon',
        daemonId: 'dmn_1',
        framework: 'hermes'
    })
    assert.equal(supportsSection(agent, 'environment'), true)
    assert.equal(supportsSection(agent, 'connections'), false)
})

test('a sandbox service agent explains connections and context instead of a blank pane', () => {
    // These panes used to mount and render null for service frameworks; the
    // gate now hides them with a framework-caused precondition.
    const agent = makeAgent({ framework: 'hermes' })
    assert.equal(supportsSection(agent, 'environment'), true)
    assert.equal(supportsSection(agent, 'connections'), false)
    assert.equal(
        sectionPreconditionKey(agent, 'connections'),
        'web.agents.detail.connections.unavailableFramework'
    )
    assert.equal(supportsSection(agent, 'context'), false)
    assert.equal(
        sectionPreconditionKey(agent, 'context'),
        'web.agents.detail.contextDoc.unavailableFramework'
    )
})

test('an external agent keeps only access and interfaces', () => {
    const agent = makeAgent({
        runtime: 'external',
        runtimeId: null,
        framework: 'dify'
    })
    assert.deepEqual(
        sectionsFor(agent).map((section) => section.id),
        ['overview', 'permissions', 'channels', 'a2a']
    )
})

test('collapsing never reorders what is left', () => {
    // The rail is one flat list, so the only thing collapsing can do is remove
    // entries — every shape must stay a subsequence of the full order.
    const full = sectionsFor(makeAgent()).map((section) => section.id)
    for (const agent of [
        makeAgent({ runtime: 'daemon', daemonId: 'dmn_1' }),
        makeAgent({ runtime: 'external', runtimeId: null, framework: 'dify' }),
        makeAgent({ runtimeId: null }),
        makeAgent({ framework: 'narranexus' })
    ]) {
        const ids = sectionsFor(agent).map((section) => section.id)
        assert.deepEqual(
            ids,
            full.filter((id) => ids.includes(id)),
            ids.join(',')
        )
    }
})

test('skills needs both a supporting framework and an attached runtime', () => {
    assert.equal(supportsSection(makeAgent({ runtimeId: null }), 'skills'), false)
    assert.equal(
        supportsSection(makeAgent({ framework: 'narranexus' }), 'skills'),
        false
    )
    assert.equal(supportsSection(makeAgent(), 'skills'), true)
})

test('legacy ?tab= values keep resolving, including folded-away ones', () => {
    assert.equal(sectionFromLegacyTab(null), 'overview')
    assert.equal(sectionFromLegacyTab('backups'), 'storage')
    assert.equal(sectionFromLegacyTab('configuration'), 'overview')
    assert.equal(sectionFromLegacyTab('runtime'), 'overview')
    assert.equal(sectionFromLegacyTab('model-provider'), 'model')
    assert.equal(sectionFromLegacyTab('channels'), 'channels')
    assert.equal(sectionFromLegacyTab('nonsense'), 'overview')
})

test('every current section id round-trips through the tab mapping', () => {
    for (const section of sectionsFor(makeAgent()))
        assert.equal(sectionFromLegacyTab(section.id), section.id)
})

test('isAgentSettingsSection rejects anything not in the list', () => {
    assert.equal(isAgentSettingsSection('overview'), true)
    assert.equal(isAgentSettingsSection('model-provider'), false)
    assert.equal(isAgentSettingsSection(undefined), false)
})

test('an unsupported section explains its precondition instead of 404ing', () => {
    const k8s = makeAgent({ runtime: 'k8s' })
    assert.equal(
        sectionPreconditionKey(k8s, 'environment'),
        'web.agents.detail.environment.unavailableRuntime'
    )
    assert.equal(
        sectionPreconditionKey(k8s, 'mcp'),
        'web.agents.detail.mcp.sandboxOnly'
    )
    const daemon = makeAgent({ runtime: 'daemon' })
    assert.equal(sectionPreconditionKey(daemon, 'environment'), null)
    assert.equal(sectionPreconditionKey(daemon, 'mcp'), null)
    assert.equal(
        sectionPreconditionKey(
            makeAgent({ runtime: 'daemon', framework: 'hermes' }),
            'mcp'
        ),
        'web.agents.detail.mcp.unsupported'
    )
    assert.equal(
        sectionPreconditionKey(makeAgent({ runtimeId: null }), 'skills'),
        'web.agents.detail.skills.needsRuntime'
    )
    // Supported sections have nothing to explain.
    assert.equal(sectionPreconditionKey(makeAgent(), 'environment'), null)
})

// The keys are the whole section union: `satisfies` makes a new id a type error
// here, so the matrix below cannot silently stop covering the product.
const ALL_SECTIONS = Object.keys({
    overview: true,
    model: true,
    skills: true,
    mcp: true,
    context: true,
    permissions: true,
    connections: true,
    environment: true,
    storage: true,
    channels: true,
    a2a: true
} satisfies Record<AgentSettingsSectionId, true>) as AgentSettingsSectionId[]

const RUNTIMES = Object.values(agentRuntime)
const FRAMEWORKS = Object.values(agentFramework)

// Every shape a URL can be asked about, not only the ones the API can mint. The
// guard is what stands between a hand-typed link and a live panel, so it has to
// hold for framework/runtime pairs the product never creates either.
const SHAPES = FRAMEWORKS.flatMap((framework) =>
    RUNTIMES.flatMap((runtime) =>
        [null, 'rt_1'].map((runtimeId) => ({
            label: `${framework}/${runtime}/${runtimeId ? 'attached' : 'detached'}`,
            agent: makeAgent({ framework, runtime, runtimeId })
        }))
    )
)

// Returning null for a section the rail hides is not "nothing to say" — the page
// reads null as "render the section", which puts a Create backup button in front
// of an agent that has no workspace to back up. External Model and Storage were
// each found that way, one report at a time; this closes the product instead.
test('every section the rail hides explains itself, on every shape', () => {
    for (const { label, agent } of SHAPES)
        for (const id of ALL_SECTIONS) {
            const key = sectionPreconditionKey(agent, id)
            if (supportsSection(agent, id))
                assert.equal(
                    key,
                    null,
                    `${label} shows ${id} but explains it away`
                )
            else assert.ok(key, `${label} hides ${id} with nothing to say`)
        }
})

// A matrix is only exhaustive while its axes are. The `satisfies` above makes a
// new section id a type error now that test/** is typechecked (#774); this is the
// half the type cannot see — SECTIONS is data, so an id can leave the rail while
// the union still names it. It reads the rail's output across every shape rather
// than one maximal agent's: a section gated to shapes that agent is not (k8s-only,
// codex-only) renders for a user while staying invisible to the matrix.
test('the matrix axes still cover the whole product', () => {
    for (const id of ALL_SECTIONS)
        assert.ok(
            sectionLabelKey(id),
            `${id} is not a section the rail renders`
        )
    const rendered = new Set(
        SHAPES.flatMap(({ agent }) =>
            sectionsFor(agent).map((section) => section.id)
        )
    )
    for (const id of rendered)
        assert.ok(ALL_SECTIONS.includes(id), `${id} is missing from the matrix`)
    assert.equal(rendered.size, ALL_SECTIONS.length)
    assert.equal(SHAPES.length, FRAMEWORKS.length * RUNTIMES.length * 2)
})

// The original report arrived through `?tab=backups`, not through the section
// URL, so the permanent aliases have to land inside the guard rather than beside
// it — including the unknown values that fall back to Overview.
test('every legacy ?tab= entry lands inside the guard, on every shape', () => {
    const tabs = [
        ...ALL_SECTIONS,
        'backups',
        'configuration',
        'runtime',
        'model-provider',
        'nonsense'
    ]
    for (const { label, agent } of SHAPES)
        for (const tab of tabs) {
            const id = sectionFromLegacyTab(tab)
            assert.ok(
                ALL_SECTIONS.includes(id),
                `?tab=${tab} resolves outside the matrix`
            )
            if (!supportsSection(agent, id))
                assert.ok(
                    sectionPreconditionKey(agent, id),
                    `${label} reaches ${id} via ?tab=${tab} with nothing to say`
                )
        }
})

test('a section the agent does have is still named by its own label', () => {
    const k8s = makeAgent({ runtime: 'k8s' })
    // The rail falls back to Overview for a section it hides, but the header
    // names what the pane is actually showing.
    assert.equal(
        sectionLabelKey('environment'),
        'web.agentSettings.sections.environment'
    )
    assert.equal(
        sectionsFor(k8s).some((entry) => entry.id === 'environment'),
        false
    )
})
