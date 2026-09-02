import test from 'node:test'
import assert from 'node:assert/strict'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    AgentSkillsGroup,
    DaemonHostSummary,
    FrameworkVersionCatalogEntry,
    InstalledSkillSummary,
    SandboxSummary
} from '@manyfold/shared'
import { MANYFOLD_CLI_USAGE_SKILL_ID } from '@manyfold/shared'
import {
    SKILL_INSTALL_BATCH_LIMIT,
    buildUpdateRows,
    countUpdates,
    displayStatus,
    emptyUpdateCenterInputs,
    filterRowsByKind,
    groupUpdateRows,
    kindParamOf,
    parseKindParam,
    planBatch,
    type UpdateCenterInputs,
    type UpdateRow
} from '../src/lib/updateCenter'

const label = (framework: AgentFramework): string => `Label:${framework}`

const groupLabels = {
    kind: (kind: string): string => `kind:${kind}`,
    status: (status: string): string => `status:${status}`,
    all: 'all'
}

const build = (over: Partial<UpdateCenterInputs> = {}): UpdateRow[] =>
    buildUpdateRows({ ...emptyUpdateCenterInputs, ...over }, label)

let seq = 0

const makeHost = (over: Partial<DaemonHostSummary> = {}): DaemonHostSummary => {
    seq += 1
    return {
        id: `dmn_${seq}`,
        name: `Machine ${seq}`,
        daemonUuid: `uuid-${seq}`,
        hostname: null,
        os: null,
        arch: null,
        cliVersion: '0.30.0',
        needsUpgrade: false,
        latestCliVersion: '0.31.0',
        updateAvailable: true,
        canRemoteUpgrade: true,
        canCrossChannelUpgrade: false,
        startupMethod: 'launchd-user',
        homeDir: null,
        workspaceBaseDir: null,
        detectedFrameworks: [],
        status: 'active',
        online: true,
        lastSeenAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        agentCount: 1,
        runtimes: [],
        ...over
    }
}

const makeSandbox = (over: Partial<SandboxSummary> = {}): SandboxSummary => {
    seq += 1
    return {
        id: `sbx_${seq}`,
        userId: 'usr_1',
        name: `sandbox-${seq}`,
        accountSlug: null,
        spriteName: `sprite-${seq}`,
        spriteStatus: 'running',
        terminalEnabled: true,
        agentsCount: 1,
        detectedFrameworks: [],
        cliVersion: '0.30.0',
        latestCliVersion: '0.31.0',
        cliUpdateAvailable: true,
        activeSecondsThisPeriod: 0,
        emptiedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...over
    }
}

const makeRuntime = (
    over: Partial<AgentRuntimeSummary> = {}
): AgentRuntimeSummary => {
    seq += 1
    return {
        id: `art_${seq}`,
        userId: 'usr_1',
        name: `runtime-${seq}`,
        framework: 'claude-code',
        frameworkVersion: '2.0.0',
        kind: 'sprites',
        status: 'ready',
        accountSlug: null,
        clusterId: null,
        clusterName: null,
        spriteName: `sprite-${seq}`,
        spriteId: null,
        hostId: null,
        mountPath: '/home',
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
        primaryAgentId: `agt_${seq}`,
        startedAt: null,
        lastBootstrappedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        agentsCount: 1,
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
    }
}

const catalogEntry = (
    over: Partial<FrameworkVersionCatalogEntry> = {}
): FrameworkVersionCatalogEntry => ({
    framework: 'claude-code',
    latest: '2.1.0',
    versions: ['2.1.0', '2.0.0'],
    source: 'npm',
    sourceRepo: null,
    fetchedAt: null,
    blocked: [],
    ...over
})

const makeSkill = (
    over: Partial<InstalledSkillSummary> = {}
): InstalledSkillSummary => {
    seq += 1
    return {
        id: `usk_${seq}`,
        skillId: `github:acme/skills@main:skills/one-${seq}`,
        agentId: 'agt_1',
        runtimeId: 'art_1',
        source: 'nca',
        readonly: false,
        name: `Skill ${seq}`,
        description: null,
        framework: 'claude-code',
        enabled: true,
        materializeStatus: 'installed',
        materializeError: null,
        installDir: '/skills',
        installedRevision: 'aaaaaaaaaaaa',
        installedVersion: null,
        latestRevision: 'bbbbbbbbbbbb',
        repoOwner: 'acme',
        repoName: 'skills',
        repoBranch: 'main',
        sourcePath: 'skills/one',
        readmeUrl: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...over
    }
}

const skillGroup = (
    agentId: string,
    agentName: string,
    skills: InstalledSkillSummary[]
): AgentSkillsGroup =>
    ({
        agent: {
            id: agentId,
            name: agentName,
            framework: 'claude-code',
            status: 'running',
            runtime: 'sprites',
            runtimeId: 'art_1',
            runtimeName: 'runtime',
            runtimeKind: 'sprites',
            runtimeStatus: 'ready'
        },
        skills
    }) as AgentSkillsGroup

test('a daemon host below the minimum version is required, not merely recommended', () => {
    const rows = build({
        daemonHosts: [
            makeHost({ name: 'Old', needsUpgrade: true, updateAvailable: false })
        ]
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'cli')
    assert.equal(rows[0].severity, 'required')
    assert.equal(rows[0].blocker, null)
    assert.equal(displayStatus(rows[0]), 'required')
    assert.deepEqual(rows[0].exec, {
        type: 'daemonCli',
        hostId: rows[0].id.replace('cli:daemon:', '')
    })
})

test('an up-to-date daemon host produces no row', () => {
    const rows = build({
        daemonHosts: [
            makeHost({ updateAvailable: false, needsUpgrade: false })
        ]
    })
    assert.deepEqual(rows, [])
})

test('a host the platform cannot upgrade remotely is manual and not executable', () => {
    const rows = build({
        daemonHosts: [makeHost({ canRemoteUpgrade: false })]
    })
    assert.equal(rows[0].blocker, 'manual')
    assert.equal(displayStatus(rows[0]), 'manual')
    assert.equal(rows[0].exec.type, 'none')
})

test('an offline host reports offline even when it is otherwise upgradeable', () => {
    // The API refuses an offline host before it looks at the startup method, so
    // reporting "manual" here would name a blocker that is not the real one.
    const rows = build({
        daemonHosts: [makeHost({ online: false, canRemoteUpgrade: false })]
    })
    assert.equal(rows[0].blocker, 'offline')
    assert.equal(displayStatus(rows[0]), 'offline')
})

test('a below-minimum host that only a human can update still reads as required', () => {
    // Otherwise the most urgent row in the table files itself under the
    // calmest heading and the user never learns the machine is broken today.
    const rows = build({
        daemonHosts: [makeHost({ needsUpgrade: true, canRemoteUpgrade: false })]
    })
    assert.equal(rows[0].severity, 'required')
    assert.equal(rows[0].blocker, 'manual')
    assert.equal(displayStatus(rows[0]), 'required')
    assert.deepEqual(
        groupUpdateRows(rows, 'status', groupLabels).map((g) => g.key),
        ['status:required']
    )
})

test('a sandbox with a stale CLI is executable', () => {
    const sandbox = makeSandbox({ name: 'box' })
    const rows = build({ sandboxes: [sandbox] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].targetLabel, 'box')
    assert.deepEqual(rows[0].exec, {
        type: 'sandboxCli',
        sandboxId: sandbox.id
    })
})

test('agents sharing a runtime yield one framework row, not one per agent', () => {
    const runtime = makeRuntime({ agentsCount: 3 })
    const rows = build({
        runtimes: [runtime],
        frameworkCatalog: [catalogEntry()]
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, `framework:${runtime.id}`)
    assert.deepEqual(rows[0].exec, {
        type: 'agentFramework',
        agentId: runtime.primaryAgentId,
        framework: 'claude-code',
        mode: 'npm',
        targetVersion: '2.1.0'
    })
})

test('a rebuild-mode framework is marked as such so the batch can order it last', () => {
    const rows = build({
        runtimes: [
            makeRuntime({ framework: 'hermes', frameworkVersion: '1.0.0' })
        ],
        frameworkCatalog: [
            catalogEntry({ framework: 'hermes', latest: '1.1.0' })
        ]
    })
    assert.equal(rows.length, 1)
    assert.equal(
        rows[0].exec.type === 'agentFramework' ? rows[0].exec.mode : null,
        'rebuild'
    )
})

test('a framework already on the latest version produces no row', () => {
    const rows = build({
        runtimes: [makeRuntime({ frameworkVersion: '2.1.0' })],
        frameworkCatalog: [catalogEntry()]
    })
    assert.deepEqual(rows, [])
})

test('an unparseable installed version never nags', () => {
    const rows = build({
        runtimes: [
            makeRuntime({ framework: 'hermes', frameworkVersion: 'main' })
        ],
        frameworkCatalog: [
            catalogEntry({ framework: 'hermes', latest: '1.1.0' })
        ]
    })
    assert.deepEqual(rows, [])
})

test('a framework with no catalog latest produces no row', () => {
    const rows = build({
        runtimes: [makeRuntime()],
        frameworkCatalog: [catalogEntry({ latest: null })]
    })
    assert.deepEqual(rows, [])
})

test('an unversioned framework is never offered an update', () => {
    const rows = build({
        runtimes: [
            makeRuntime({ framework: 'dify', frameworkVersion: '1.0.0' })
        ],
        frameworkCatalog: [catalogEntry()]
    })
    assert.deepEqual(rows, [])
})

test('a sprite runtime with no primary agent has no endpoint to address', () => {
    const runtime = makeRuntime({ primaryAgentId: null })
    const rows = build({
        runtimes: [runtime],
        frameworkCatalog: [catalogEntry()]
    })
    assert.equal(rows[0].blocker, 'noAgent')
    assert.deepEqual(rows[0].exec, {
        type: 'none',
        guideFramework: null,
        href: `/settings/runtimes/${runtime.id}`
    })
})

test("a framework on the user's own machine offers the command, not a mutation", () => {
    const rows = build({
        runtimes: [
            makeRuntime({
                kind: 'daemon',
                daemonId: 'dmn_x',
                daemonName: 'Ying MBP'
            })
        ],
        frameworkCatalog: [catalogEntry()]
    })
    assert.equal(rows[0].blocker, 'manual')
    assert.equal(rows[0].targetKind, 'daemon')
    assert.equal(rows[0].targetLabel, 'Ying MBP')
    assert.deepEqual(rows[0].exec, {
        type: 'none',
        guideFramework: 'claude-code',
        href: null
    })
})

test('a k8s runtime links to its runtime page instead of a shell command', () => {
    const runtime = makeRuntime({
        kind: 'k8s',
        clusterId: 'clu_1',
        clusterName: 'prod'
    })
    const rows = build({
        runtimes: [runtime],
        frameworkCatalog: [catalogEntry()]
    })
    assert.equal(rows[0].blocker, 'manual')
    assert.equal(rows[0].targetKey, 'k8s:clu_1')
    assert.deepEqual(rows[0].exec, {
        type: 'none',
        guideFramework: null,
        href: `/settings/runtimes/${runtime.id}`
    })
})

test('a blocked installed version raises the row to required and carries the reason', () => {
    const rows = build({
        runtimes: [
            makeRuntime({ framework: 'gemini-cli', frameworkVersion: '0.53.0' })
        ],
        frameworkCatalog: [
            catalogEntry({
                framework: 'gemini-cli',
                latest: '0.55.0',
                blocked: [
                    { min: '0.53.0', max: '0.54.0', reason: 'drops signatures' }
                ]
            })
        ]
    })
    assert.equal(rows[0].severity, 'required')
    assert.equal(rows[0].blockedReason, 'drops signatures')
})

test('a sprite framework row is labelled with the sandbox name, not the sprite id', () => {
    const sandbox = makeSandbox({
        name: 'workhorse',
        cliUpdateAvailable: false
    })
    const rows = build({
        sandboxes: [sandbox],
        runtimes: [makeRuntime({ hostId: sandbox.id })],
        frameworkCatalog: [catalogEntry()]
    })
    assert.equal(rows[0].targetLabel, 'workhorse')
    assert.equal(rows[0].targetKey, `sandbox:${sandbox.id}`)
})

test('the platform CLI-usage skill is its own kind, other skills are not', () => {
    const rows = build({
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [
                makeSkill({ skillId: MANYFOLD_CLI_USAGE_SKILL_ID }),
                makeSkill()
            ])
        ]
    })
    assert.deepEqual(
        rows.map((r) => r.kind),
        ['cliUsage', 'skill']
    )
    assert.equal(rows[0].id, `cliUsage:agt_1:${MANYFOLD_CLI_USAGE_SKILL_ID}`)
})

test('a skill at the same revision, readonly, still installing, or missing a revision is not an update', () => {
    const rows = build({
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [
                makeSkill({ latestRevision: 'aaaaaaaaaaaa' }),
                makeSkill({ readonly: true }),
                makeSkill({ materializeStatus: 'installing' }),
                makeSkill({ latestRevision: null }),
                makeSkill({ installedRevision: null })
            ])
        ]
    })
    assert.deepEqual(rows, [])
})

test('a skill compares revisions on both sides, even when it records a version', () => {
    // The catalog only knows the latest as a revision, so showing the recorded
    // version on the left would put an arrow between two different kinds of
    // thing and read as if 1.2.3 were being replaced by a commit hash.
    const rows = build({
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [
                makeSkill({ installedVersion: '1.2.3' }),
                makeSkill()
            ])
        ]
    })
    assert.deepEqual(
        rows.map((r) => [r.installedVersion, r.latestVersion]),
        [
            ['aaaaaaa', 'bbbbbbb'],
            ['aaaaaaa', 'bbbbbbb']
        ]
    )
})

test('the same skill stale on two agents is two rows, one per agent', () => {
    const skillId = 'github:acme/skills@main:skills/shared'
    const rows = build({
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [makeSkill({ skillId, agentId: 'agt_1' })]),
            skillGroup('agt_2', 'Beta', [makeSkill({ skillId, agentId: 'agt_2' })])
        ]
    })
    assert.equal(rows.length, 2)
    assert.deepEqual(
        rows.map((r) => r.targetLabel),
        ['Alpha', 'Beta']
    )
})

test('required rows sort first, then CLI before framework before skills', () => {
    const rows = build({
        daemonHosts: [makeHost({ name: 'zzz' })],
        runtimes: [makeRuntime()],
        frameworkCatalog: [catalogEntry()],
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [
                makeSkill({ skillId: MANYFOLD_CLI_USAGE_SKILL_ID }),
                makeSkill()
            ])
        ],
        sandboxes: [makeSandbox({ name: 'aaa', cliUpdateAvailable: true })]
    })
    assert.deepEqual(
        rows.map((r) => r.kind),
        ['cli', 'cli', 'framework', 'cliUsage', 'skill']
    )
    // Within one kind, the target name orders the rows.
    assert.deepEqual(
        rows.slice(0, 2).map((r) => r.targetLabel),
        ['aaa', 'zzz']
    )
})

test('countUpdates agrees with the rows the page renders', () => {
    const rows = build({
        daemonHosts: [makeHost(), makeHost({ canRemoteUpgrade: false })]
    })
    // A row nobody can execute is still an update the user should know about.
    assert.equal(countUpdates(rows), 2)
})

test('grouping by kind keeps the row order and labels each group', () => {
    const rows = build({
        daemonHosts: [makeHost()],
        runtimes: [makeRuntime()],
        frameworkCatalog: [catalogEntry()]
    })
    const groups = groupUpdateRows(rows, 'kind', groupLabels)
    assert.deepEqual(
        groups.map((g) => [g.key, g.label, g.rows.length]),
        [
            ['kind:cli', 'kind:cli', 1],
            ['kind:framework', 'kind:framework', 1]
        ]
    )
})

test('grouping by status follows severity order, not first appearance', () => {
    const rows = build({
        daemonHosts: [
            makeHost({ canRemoteUpgrade: false }),
            makeHost({ needsUpgrade: true })
        ]
    })
    const groups = groupUpdateRows(rows, 'status', groupLabels)
    assert.deepEqual(
        groups.map((g) => g.key),
        ['status:required', 'status:manual']
    )
})

test('grouping by target collapses every update on one machine', () => {
    const host = makeHost()
    const rows = build({
        daemonHosts: [host],
        runtimes: [
            makeRuntime({
                kind: 'daemon',
                daemonId: host.id,
                daemonName: host.name
            })
        ],
        frameworkCatalog: [catalogEntry()]
    })
    const groups = groupUpdateRows(rows, 'target', groupLabels)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].key, `target:daemon:${host.id}`)
    assert.equal(groups[0].rows.length, 2)
})

test('grouping by none is a single group, and no groups at all when empty', () => {
    const rows = build({ daemonHosts: [makeHost()] })
    assert.deepEqual(
        groupUpdateRows(rows, 'none', groupLabels).map((g) => g.key),
        ['all']
    )
    assert.deepEqual(groupUpdateRows([], 'none', groupLabels), [])
})

test('every kind survives a round trip through the url parameter', () => {
    for (const kind of ['cli', 'framework', 'cliUsage', 'skill'] as const)
        assert.equal(parseKindParam(kindParamOf(kind)), kind)
    assert.equal(parseKindParam(null), null)
    assert.equal(parseKindParam('nonsense'), null)
    // The camelCase kind must not double as its own url spelling, or a link
    // would work while the canonical one silently showed everything.
    assert.equal(parseKindParam('cliUsage'), null)
})

test('filtering by kind keeps only that kind, and null keeps everything', () => {
    const rows = build({
        daemonHosts: [makeHost()],
        skillGroups: [skillGroup('agt_1', 'Alpha', [makeSkill()])]
    })
    assert.deepEqual(
        filterRowsByKind(rows, 'skill').map((r) => r.kind),
        ['skill']
    )
    assert.equal(filterRowsByKind(rows, null).length, 2)
})

test('one skill stale on many agents becomes one request, not many', () => {
    const skillId = 'github:acme/skills@main:skills/shared'
    const rows = build({
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [makeSkill({ skillId, agentId: 'agt_1' })]),
            skillGroup('agt_2', 'Beta', [makeSkill({ skillId, agentId: 'agt_2' })])
        ]
    })
    const steps = planBatch(rows)
    assert.equal(steps.length, 1)
    assert.deepEqual(steps[0], {
        type: 'skillBatch',
        skillId,
        agentIds: ['agt_1', 'agt_2'],
        rowIds: rows.map((r) => r.id)
    })
})

test('a skill on more agents than the endpoint accepts is split into chunks', () => {
    const skillId = 'github:acme/skills@main:skills/shared'
    const count = SKILL_INSTALL_BATCH_LIMIT + 3
    const groups = Array.from({ length: count }, (_, i) =>
        skillGroup(`agt_${i}`, `Agent ${String(i).padStart(3, '0')}`, [
            makeSkill({ skillId, agentId: `agt_${i}` })
        ])
    )
    const steps = planBatch(build({ skillGroups: groups }))
    assert.equal(steps.length, 2)
    assert.deepEqual(
        steps.map((s) => (s.type === 'skillBatch' ? s.agentIds.length : -1)),
        [SKILL_INSTALL_BATCH_LIMIT, 3]
    )
})

test('different skills stay separate requests', () => {
    const rows = build({
        skillGroups: [
            skillGroup('agt_1', 'Alpha', [
                makeSkill({ skillId: 'a', agentId: 'agt_1' }),
                makeSkill({ skillId: 'b', agentId: 'agt_1' })
            ])
        ]
    })
    assert.equal(planBatch(rows).length, 2)
})

test('the plan runs the quick work first and the multi-minute rebuild last', () => {
    const rows = build({
        daemonHosts: [makeHost()],
        sandboxes: [makeSandbox()],
        runtimes: [
            makeRuntime({ framework: 'hermes', frameworkVersion: '1.0.0' }),
            makeRuntime()
        ],
        frameworkCatalog: [
            catalogEntry(),
            catalogEntry({ framework: 'hermes', latest: '1.1.0' })
        ],
        skillGroups: [skillGroup('agt_1', 'Alpha', [makeSkill()])]
    })
    assert.deepEqual(
        planBatch(rows).map((s) =>
            s.type === 'framework' ? `framework:${s.mode}` : s.type
        ),
        [
            'skillBatch',
            'sandboxCli',
            'daemonCli',
            'framework:npm',
            'framework:rebuild'
        ]
    )
})

test('rows the platform cannot drive are dropped from the plan, not failed', () => {
    const rows = build({
        daemonHosts: [
            makeHost({ canRemoteUpgrade: false }),
            makeHost({ online: false })
        ],
        runtimes: [makeRuntime({ primaryAgentId: null })],
        frameworkCatalog: [catalogEntry()]
    })
    assert.equal(rows.length, 3)
    assert.deepEqual(planBatch(rows), [])
})
