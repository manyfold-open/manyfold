import test from 'node:test'
import assert from 'node:assert/strict'
import {
    listFrameworks,
    providerBindingFor,
    providerRowVerdict
} from '@manyfold/shared'
import type {
    AgentCredentialsView,
    AgentRuntimeSummary,
    DaemonHostSummary,
    PodHostSummary,
    RuntimeAccessSummary,
    SandboxSummary,
    UserModelProviderSummary
} from '@manyfold/shared'
import {
    advanceBlockedKey,
    answeredSteps,
    initialFlowState,
    nextStep,
    previousStep,
    sameRuntime,
    withFramework,
    withRuntime,
    withSuggestedName,
    withTypedName
} from '../src/pages/AgentNew/v4/flowState'
import { enterAdvances } from '../src/pages/AgentNew/v4/components/enterKey'
import {
    canStandOn,
    furthestStep,
    hostIdOfRow,
    readUrl,
    writeUrl
} from '../src/pages/AgentNew/v4/urlState'
import { machineBillingFrom } from '../src/pages/AgentNew/v4/machineBilling'
import type { RuntimeChoice } from '../src/pages/AgentNew/v4/flowState'
import {
    costFull,
    costShort,
    createBudgetSeconds,
    createWaitLabel,
    newMachineWaitLabel,
    waitLabel,
    creatingPrimary,
    preparingPrimary,
    runtimeFull,
    runtimeShort
} from '../src/pages/AgentNew/v4/summaryLabels'
import {
    frameworkGroups,
    canUseSubscription,
    firstServiceAgent,
    hasWorkspace,
    installMinutes,
    installsAtCreate,
    needsRemoteRef,
    runsOnOurMachine
} from '../src/pages/AgentNew/v4/frameworkCatalog'
import {
    externalCreateBody,
    fixedCostFor,
    joinBindingFor,
    managedChannelFor,
    serviceCreateBody,
    withBinding
} from '../src/pages/AgentNew/v4/providerBinding'
import {
    buildMachineOptions,
    buildNewMachineOptions,
    choiceWithoutWork,
    sandboxLeftFailed,
    sandboxToRetry
} from '../src/pages/AgentNew/v4/machineOptions'
import { FIXTURE_FRAMEWORK } from './fixture-framework'

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
        availability: 'available',
        hostId: null,
        hostName: null,
        hostKind: 'hosted',
        hostStatus: 'ready',
        providerId: null,
        providerKind: 'sprites',
        providerName: null,
        providerRefLabel: null,
        powerState: 'running',
        daemonOnline: true,
        daemonCliVersion: null,
        mountPath: '/',
        endpointUrl: null,
        controlUiEnabled: false,
        dashboardEnabled: false,
        dashboardState: null,
        currentPhase: null,
        failureReason: null,
        lastBootstrappedAt: null,
        createdAt: '',
        updatedAt: '',
        agentsCount: 0,
        serviceStatus: 'unknown',
        serviceStatusAt: null,
        ...over
    }) as AgentRuntimeSummary

const sandbox = (id: string, name: string): SandboxSummary =>
    ({ id, name, agentsCount: 0 }) as SandboxSummary

const daemon = (id: string, name: string): DaemonHostSummary =>
    ({ id, name }) as DaemonHostSummary

const podHost = (
    over: Partial<PodHostSummary> & Pick<PodHostSummary, 'id'>
): PodHostSummary =>
    ({
        name: 'computer-001',
        status: 'ready',
        runtimes: [],
        agentsCount: 0,
        ...over
    }) as PodHostSummary

const access = (over: Partial<RuntimeAccessSummary>): RuntimeAccessSummary =>
    ({
        statefulSandboxLimit: 5,
        statefulSandboxUsage: 2,
        statefulSandboxRemaining: 3,
        cloudComputerEnabled: false,
        ...over
    }) as RuntimeAccessSummary

test('every type sits in exactly one of two groups, by where it runs', () => {
    const groups = frameworkGroups()
    assert.equal(groups.length, 2)
    const entries = groups.flatMap((g) => g.entries)
    assert.deepEqual(
        entries.map((entry) => entry.framework).sort(),
        [...listFrameworks()].sort()
    )
    // An edition's framework follows the coding CLIs.
    assert.equal(groups[0].entries[5].framework, FIXTURE_FRAMEWORK)
    // The group boundary IS the step ② fork: everything in the first group
    // asks about a machine, everything in the second about a service.
    for (const group of groups)
        for (const entry of group.entries)
            assert.equal(
                runsOnOurMachine(entry.framework),
                group.id === 'onMachine',
                entry.framework
            )
})

test('only the CLIs that carry their own sign-in advertise a subscription', () => {
    for (const entry of frameworkGroups().flatMap((g) => g.entries))
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
    for (const entry of frameworkGroups().flatMap((g) => g.entries))
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
        sandboxId: 'h1',
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

// Seen on staging [2026-10-08]: rows promised "instant · no sign-in needed"
// from the agent count alone, on a sandbox that was asleep and whose accounts
// had expired. A row now says what it costs in waiting, read from its power
// state; whether a sign-in follows is step ③'s to say.
test('a machine says what it costs in waiting, read from whether it is awake', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [
            runtime({ id: 'r1', hostId: 'h1', agentsCount: 3 }),
            runtime({ id: 'r2', hostId: 'h2', agentsCount: 0 })
        ],
        sandboxes: [
            sandbox('h1', 'dev-box'),
            { ...sandbox('h2', 'sandbox-a1b2'), powerState: 'stopped' }
        ],
        daemonHosts: [],
        podHosts: []
    })
    const working = rows.find((r) => r.title === 'dev-box')
    const prepared = rows.find((r) => r.title === 'sandbox-a1b2')
    assert.deepEqual(working?.wait, { kind: 'instant' })
    // The machine left behind by an abandoned run comes back as an ordinary
    // row — same shape as any other, no "last time" marker.
    assert.deepEqual(prepared?.wait, { kind: 'wake' })
    assert.equal(prepared?.disabled, false)
})

test('a sandbox without the CLI offers to install it, and flags an empty one', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [],
        sandboxes: [sandbox('h9', 'scratch')],
        daemonHosts: [],
        podHosts: []
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'needs-install')
    assert.deepEqual(rows[0].wait, { kind: 'install', asleep: false })
    assert.equal(rows[0].idle, true)
})

// A failed build leaves its sandbox behind, marked failed until the user
// deletes it, and the API answers "not reachable" to an install onto it — or
// onto one still being built. Both stay in the list and say why.
test('a sandbox that failed or is still building cannot be installed onto', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [],
        sandboxes: [
            { ...sandbox('h1', 'sandbox-001'), status: 'failed' },
            { ...sandbox('h2', 'sandbox-002'), status: 'provisioning' },
            { ...sandbox('h3', 'sandbox-003'), status: 'ready' }
        ],
        daemonHosts: [],
        podHosts: []
    })
    assert.deepEqual(
        rows.map((row) => [row.title, row.state, row.unavailableReason, row.disabled]),
        [
            ['sandbox-001', 'unavailable', 'failed', true],
            ['sandbox-002', 'unavailable', 'starting', true],
            ['sandbox-003', 'needs-install', undefined, false]
        ]
    )
})

// A sandbox in maintenance failed its provider's health check. Neither the
// framework already on it nor a fresh install can take a new agent until it
// is back, and the row says so rather than vanishing.
test('a sandbox in maintenance stays listed, unavailable, with its reason', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [
            runtime({
                id: 'rt1',
                hostId: 'h1',
                hostName: 'sandbox-001',
                availability: 'maintenance',
                hostStatus: 'maintenance'
            })
        ],
        sandboxes: [
            { ...sandbox('h1', 'sandbox-001'), status: 'maintenance' },
            { ...sandbox('h2', 'sandbox-002'), status: 'maintenance' }
        ],
        daemonHosts: [],
        podHosts: []
    })
    assert.deepEqual(
        rows.map((row) => [row.title, row.state, row.unavailableReason, row.disabled]),
        [
            ['sandbox-001', 'unavailable', 'maintenance', true],
            ['sandbox-002', 'unavailable', 'maintenance', true]
        ]
    )
})

test('your own computer is never installed onto, and says so in place', () => {
    const rows = buildMachineOptions({
        framework: 'gemini-cli',
        runtimes: [],
        sandboxes: [],
        daemonHosts: [daemon('d1', 'My MacBook')],
        podHosts: []
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
        daemonHosts: [],
        podHosts: []
    })
    const blocked = rows.find((r) => r.state === 'service-slot-taken')
    assert.ok(blocked, 'the blocked sandbox must not be hidden')
    assert.equal(blocked?.disabled, true)
    assert.equal(blocked?.blockedBy, 'hermes')
})

test('a cloud computer runs whatever is installed on it', () => {
    // ADR-0035: no framework is fixed at purchase. A host running this
    // framework is joined; a ready one without it gets it installed on pick.
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [],
        sandboxes: [],
        daemonHosts: [],
        podHosts: [
            podHost({
                id: 'pdh_1',
                name: 'computer-001',
                runtimes: [
                    runtime({
                        id: 'r1',
                        kind: 'k8s',
                        framework: 'claude-code',
                        hostId: 'pdh_1',
                        agentsCount: 2
                    })
                ]
            }),
            podHost({
                id: 'pdh_2',
                name: 'computer-002',
                runtimes: [
                    runtime({
                        id: 'r2',
                        kind: 'k8s',
                        framework: 'codex',
                        hostId: 'pdh_2'
                    })
                ]
            })
        ]
    })
    // One row per machine (ADR-0037): the host key, whatever the row does.
    const joined = rows.find((r) => r.id === 'host:pdh_1')
    assert.equal(joined?.state, 'ready')
    assert.equal(joined?.runtimeId, 'r1')
    assert.equal(joined?.hostKind, 'k8s')
    assert.deepEqual(joined?.wait, { kind: 'instant' })
    const install = rows.find((r) => r.id === 'host:pdh_2')
    assert.equal(install?.state, 'needs-install')
    assert.equal(install?.podHostId, 'pdh_2')
    assert.equal(install?.disabled, false)
})

test('a service framework installs onto a cloud computer at create', () => {
    const [row] = buildMachineOptions({
        framework: 'openclaw',
        runtimes: [],
        sandboxes: [],
        daemonHosts: [],
        podHosts: [podHost({ id: 'pdh_1' })]
    })
    assert.equal(row.state, 'needs-install')
    assert.equal(row.podHostId, 'pdh_1')
    assert.deepEqual(row.wait, { kind: 'install-at-create', asleep: false })
})

test('a cloud computer that cannot take the agent stays listed with its reason', () => {
    const [starting, failed] = buildMachineOptions({
        framework: 'codex',
        runtimes: [],
        sandboxes: [],
        daemonHosts: [],
        podHosts: [
            podHost({ id: 'pdh_1', status: 'provisioning' }),
            podHost({ id: 'pdh_2', status: 'failed' })
        ]
    })
    assert.equal(starting.state, 'unavailable')
    assert.equal(starting.unavailableReason, 'starting')
    assert.equal(starting.disabled, true)
    assert.equal(failed.unavailableReason, 'failed')
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

test('a framework that cannot use a daemon says so on that row', () => {
    const noDaemon = buildNewMachineOptions({
        framework: FIXTURE_FRAMEWORK,
        access: access({})
    })
    const claude = buildNewMachineOptions({
        framework: 'claude-code',
        access: access({})
    })
    assert.equal(
        noDaemon.find((o) => o.kind === 'ownComputer')?.disabled,
        true
    )
    assert.equal(
        claude.find((o) => o.kind === 'ownComputer')?.disabled,
        false
    )
})

const withStatus = (
    row: SandboxSummary,
    status: SandboxSummary['status']
): SandboxSummary => ({ ...row, status })

test('a failed build is the row that was not there before it and now reads failed', () => {
    const older = withStatus(sandbox('sbx_old', 'sandbox-001'), 'failed')
    const built = withStatus(sandbox('sbx_new', 'sandbox-002'), 'failed')
    // An older failure is not this build's to retry.
    assert.equal(
        sandboxLeftFailed(new Set(['sbx_old']), [older, built])?.id,
        'sbx_new'
    )
    // Refused before any row was made (a quota, an unreachable API): there is
    // nothing to retry, and the next press builds a new one.
    assert.equal(sandboxLeftFailed(new Set(['sbx_old']), [older]), null)
    assert.equal(
        sandboxLeftFailed(new Set(), [
            withStatus(sandbox('sbx_up', 'sandbox-003'), 'ready')
        ]),
        null
    )
})

test('a failed build is retried only while the list still shows it failed', () => {
    const failed = withStatus(sandbox('sbx_1', 'sandbox-001'), 'failed')
    assert.equal(sandboxToRetry([failed], 'sbx_1')?.name, 'sandbox-001')
    assert.equal(sandboxToRetry([failed], null), null)
    // Retried elsewhere and building, or deleted: build a new one instead.
    assert.equal(
        sandboxToRetry([withStatus(failed, 'provisioning')], 'sbx_1'),
        null
    )
    assert.equal(sandboxToRetry([], 'sbx_1'), null)
})

// The step bar and step ④'s confirmation list both summarise the same run.
// They are allowed to coexist only because they say it at different
// precisions — the bar names the thing, the list says what the thing means.
// Print the same string in both and the second one reads as a bug.
const tt = (
    key: string,
    params?: Record<string, string | number>
): string =>
    params === undefined
        ? key
        : `${key}(${Object.values(params).join(',')})`

test('the bar names the machine, the confirmation list says what kind it is', () => {
    const sandbox: RuntimeChoice = {
        kind: 'runtime',
        runtimeId: 'r1',
        sandboxId: 'h1',
        hostKind: 'sprites',
        hostLabel: 'sandbox-002',
        ownComputer: false
    }
    assert.equal(runtimeShort(sandbox), 'sandbox-002')
    assert.equal(
        runtimeFull(sandbox, tt),
        'sandbox-002 · web.agentNewV4.machine.sandbox'
    )
})

test('a connected service is named by endpoint, then by which app on it', () => {
    const dify: RuntimeChoice = {
        kind: 'external',
        providerId: 'p1',
        providerLabel: 'dify.mycorp.com',
        remoteRef: 'app-1',
        remoteLabel: 'Support assistant'
    }
    assert.equal(runtimeShort(dify), 'dify.mycorp.com')
    assert.equal(
        runtimeFull(dify, tt),
        'dify.mycorp.com · Support assistant'
    )
})

test('the bar identifies the account; the list says what paying with it means', () => {
    const account = {
        kind: 'runtime-local' as const,
        profileId: 'a1',
        label: 'jiaming@netmind.ai'
    }
    // Several accounts can be signed in on one machine, so the glanceable
    // line has to be the one that distinguishes them.
    assert.equal(costShort(account, tt), 'jiaming@netmind.ai')
    assert.equal(
        costFull(account, 'Claude', 'Dify', tt),
        'jiaming@netmind.ai · web.agentNewV4.cost.subscriptionOf(Claude)'
    )
})

test('no step summarises itself the same way twice', () => {
    const cases: { short: string; full: string }[] = [
        {
            short: costShort({ kind: 'platform' }, tt),
            full: costFull({ kind: 'platform' }, 'Claude', 'Dify', tt)
        },
        {
            short: costShort(
                { kind: 'provider', providerId: 'p', label: 'NetMind API' },
                tt
            ),
            full: costFull(
                { kind: 'provider', providerId: 'p', label: 'NetMind API' },
                'Claude',
                'Dify',
                tt
            )
        },
        {
            short: costShort({ kind: 'external' }, tt),
            full: costFull({ kind: 'external' }, 'Claude', 'Dify', tt)
        }
    ]
    for (const c of cases) assert.notEqual(c.short, c.full)
})

// Step ④ asks for two things and recaps three. The two it asks for come
// first: putting the recap of settled decisions between the question and the
// first input made the reader cross what they had already decided to reach
// what they had not — and left the last look at the choices as far from the
// Create button as the page allows.
test('the working directory is offered on every framework that has one', () => {
    assert.equal(hasWorkspace('claude-code'), true)
    assert.equal(hasWorkspace('codex'), true)
    // A sandbox takes a path too — leaving it empty is what asks the platform
    // to allocate one, which is not the same as having no field.
    assert.equal(hasWorkspace('openclaw'), true)
    // Hermes is calendar and mail; there is no project to point at.
    assert.equal(hasWorkspace('hermes'), false)
})

test('a working directory the API would reject blocks the button first', () => {
    const named = {
        ...withRuntime(withFramework(initialFlowState(), 'claude-code'), {
            kind: 'runtime',
            runtimeId: 'r1',
            sandboxId: 'h1',
            hostKind: 'sprites',
            hostLabel: 'dev-box',
            ownComputer: false
        }),
        cost: { kind: 'platform' } as const,
        step: 'name' as const,
        name: 'alert-firefly-5493'
    }
    assert.equal(advanceBlockedKey(named), null)
    assert.equal(
        advanceBlockedKey({ ...named, workspace: '  ' }),
        null,
        'empty asks for an allocated one, which is allowed'
    )
    assert.equal(advanceBlockedKey({ ...named, workspace: '/srv/work' }), null)
    assert.equal(
        advanceBlockedKey({ ...named, workspace: 'code/my-project' }),
        'web.agentNewV4.blocked.workspace'
    )
})

// The wait after "Create agent". One POST, no server events — so the button
// reports the two things that are actually known, and the cost line beside it
// is replaced rather than joined by a second block of text.
test('the count appears only once it is worth reading', () => {
    const cost = 'about a minute'
    assert.equal(creatingPrimary(0, 75, cost, tt).label, 'web.agentNewV4.primary.creating')
    assert.equal(creatingPrimary(1, 75, cost, tt).label, 'web.agentNewV4.primary.creating')
    assert.equal(
        creatingPrimary(2, 75, cost, tt).label,
        'web.agentNewV4.primary.creating · 2s'
    )
    assert.equal(
        creatingPrimary(23, 75, cost, tt).label,
        'web.agentNewV4.primary.creating · 23s'
    )
})

test('overrunning replaces the cost line rather than adding a second one', () => {
    const cost = 'about a minute · this machine has to wake up first'
    // Inside the budget the line the user read before pressing stays exactly
    // as it was — no appearing text, no layout shift, and the seconds in the
    // button keep their yardstick.
    assert.equal(creatingPrimary(23, 75, cost, tt).fine, cost)
    assert.equal(creatingPrimary(75, 75, cost, tt).fine, cost)
    // Past it, the same slot says something different. Because that line had
    // been constant, changing it is the signal.
    assert.equal(creatingPrimary(76, 75, cost, tt).fine, 'web.agentNewV4.primary.tookLonger')
})

// The wait after "Build one and install …" at step ②. It is two requests, the
// build and then the install, so the label can name the one in flight; the
// count and the cost line keep the create's rules across both.
test('step ② names the request in flight and counts across both', () => {
    const cost = 'about 2 minutes · sign in once afterwards · 0 of 5 used'
    assert.equal(
        preparingPrimary('build', 'Pi', 1, 150, cost, tt).label,
        'web.agentNewV4.primary.building'
    )
    assert.equal(
        preparingPrimary('build', 'Pi', 12, 150, cost, tt).label,
        'web.agentNewV4.primary.building · 12s'
    )
    // The install picks up the build's count: one wait, a new verb.
    assert.equal(
        preparingPrimary('install', 'Pi', 13, 150, cost, tt).label,
        'web.agentNewV4.primary.installing(Pi) · 13s'
    )
    assert.equal(preparingPrimary('install', 'Pi', 150, 150, cost, tt).fine, cost)
    // A build that fails leaves its machine behind, marked failed, so the
    // overrun line cannot borrow the create's "nothing half-made".
    assert.equal(
        preparingPrimary('install', 'Pi', 151, 150, cost, tt).fine,
        'web.agentNewV4.primary.longerThanUsual'
    )
})

// A service framework (OpenClaw, Hermes, an edition's) is installed at
// step ④, with the agent, because the install needs the provider step ③ has
// not asked yet. Seen on staging [2026-09-16]: installing OpenClaw at step ②
// answered 500, `cannot resolve base_url for openclaw provider ''`.
test('a service framework installs at create', () => {
    for (const fw of ['openclaw', 'hermes', FIXTURE_FRAMEWORK])
        assert.equal(installsAtCreate(fw), true, fw)
    for (const fw of ['claude-code', 'codex', 'gemini-cli', 'pi'] as const)
        assert.equal(installsAtCreate(fw), false, fw)
    const rows = buildMachineOptions({
        framework: 'openclaw',
        runtimes: [
            runtime({ id: 'r1', framework: 'openclaw', hostId: 'h1', agentsCount: 0 })
        ],
        sandboxes: [sandbox('h1', 'busy'), sandbox('h2', 'empty')],
        daemonHosts: [],
        podHosts: []
    })
    assert.deepEqual(rows.find((r) => r.id === 'host:h2')?.wait, {
        kind: 'install-at-create',
        asleep: false
    })
    // Joining the instance that already runs costs nothing more.
    assert.deepEqual(rows.find((r) => r.id === 'host:h1')?.wait, { kind: 'instant' })
})

const providerRow = (
    over: Partial<UserModelProviderSummary> &
        Pick<UserModelProviderSummary, 'id' | 'providerName'>
): UserModelProviderSummary =>
    ({
        inferenceProtocol: null,
        builtInId: null,
        externalAccountId: null,
        apiKeyMasked: '',
        baseUrl: null,
        modelsListUrl: null,
        source: 'byo',
        managedService: null,
        managedKeyId: null,
        managedBrand: null,
        lastTestedAt: null,
        lastTestStatus: 'ok',
        lastTestMessage: null,
        lastTestModels: null,
        enabledModels: null,
        createdAt: '',
        updatedAt: '',
        ...over
    }) as UserModelProviderSummary

// Measured on staging [2026-09-16]: the shape of one account's provider list —
// a managed channel per vendor, plus a NetMind key that speaks four protocols.
const managedAnthropic = providerRow({
    id: 'm-anthropic',
    providerName: 'Managed Anthropic',
    source: 'managed',
    inferenceProtocol: 'anthropic_messages',
    managedBrand: 'anthropic',
    lastTestModels: { anthropic_messages: ['claude-fable-5', 'claude-haiku-4-5-20251001'] }
})
const managedOpenAI = providerRow({
    id: 'm-openai',
    providerName: 'Managed OpenAI',
    source: 'managed',
    inferenceProtocol: 'openai_responses',
    managedBrand: 'openai',
    lastTestModels: { openai_responses: ['gpt-5.2', 'gpt-5.4-mini', 'gpt-6', 'gpt-6-sol'] }
})
const managedGemini = providerRow({
    id: 'm-gemini',
    providerName: 'Managed Gemini',
    source: 'managed',
    inferenceProtocol: 'google_generate_content',
    managedBrand: 'google',
    lastTestModels: { google_generate_content: ['gemini-2.5-flash'] }
})
const netmind = providerRow({
    id: 'k-netmind',
    providerName: 'NetMind API',
    builtInId: 'netmind',
    lastTestModels: {
        anthropic_messages: [
            'netmind/smart-model-claude-based',
            'anthropic/claude-sonnet-5',
            'anthropic/claude-haiku-4-5'
        ],
        openai_responses: ['openai/gpt-5.4-mini']
    }
})
const untested = providerRow({ id: 'k-fresh', providerName: 'Fresh key', builtInId: 'netmind' })

test('the managed row resolves to a channel the API will accept for this framework', () => {
    // Managed Anthropic is closed to OpenClaw and Hermes, Managed Gemini
    // speaks a protocol they cannot; OpenAI is what is left — the same
    // verdict `isManagedProtocolAllowedForFramework` and the resolver give.
    assert.equal(
        managedChannelFor('openclaw', [managedAnthropic, managedGemini, managedOpenAI])?.id,
        'm-openai'
    )
    assert.equal(managedChannelFor('hermes', [managedAnthropic, managedGemini]), null)
    // A channel an admin switched off is not offered to new agents.
    assert.equal(managedChannelFor('openclaw', [{ ...managedOpenAI, channelDisabled: true }]), null)
})

test('the model is the economical default on the protocol the API will resolve to', () => {
    // A built-in that speaks several protocols is resolved to the first in
    // the resolver's own order — anthropic_messages before the OpenAI pair —
    // so the model has to come from THAT list, not from the longest one.
    assert.equal(providerBindingFor('openclaw', netmind)?.model, 'anthropic/claude-haiku-4-5')
    assert.equal(providerBindingFor('openclaw', managedOpenAI)?.model, 'gpt-5.4-mini')
    assert.equal(providerBindingFor('openclaw', untested), null)
})

test('a row the API would refuse stays on screen and says why', () => {
    assert.equal(providerRowVerdict('openclaw', managedGemini), 'incompatible')
    assert.equal(providerRowVerdict('openclaw', managedAnthropic), 'incompatible')
    assert.equal(providerRowVerdict('openclaw', untested), 'untested')
    assert.equal(providerRowVerdict('openclaw', netmind), 'usable')
    // A coding CLI speaks one protocol (pi three), so the same rows read
    // differently for it — and a key never tested still names no model.
    assert.equal(providerRowVerdict('claude-code', managedOpenAI), 'incompatible')
    assert.equal(providerRowVerdict('claude-code', managedAnthropic), 'usable')
    assert.equal(providerRowVerdict('gemini-cli', managedGemini), 'usable')
    assert.equal(providerRowVerdict('codex', untested), 'untested')
    assert.equal(providerRowVerdict('pi', managedGemini), 'usable')
})

test('a step ③ answer carries its binding for a framework installed at create or a coding CLI', () => {
    const providers = [managedAnthropic, managedOpenAI, netmind]
    assert.deepEqual(withBinding({ kind: 'platform' }, 'openclaw', providers), {
        kind: 'platform',
        providerId: 'm-openai',
        model: 'gpt-5.4-mini'
    })
    assert.deepEqual(
        withBinding(
            { kind: 'provider', providerId: 'k-netmind', label: 'NetMind API' },
            'openclaw',
            providers
        ),
        {
            kind: 'provider',
            providerId: 'k-netmind',
            label: 'NetMind API',
            model: 'anthropic/claude-haiku-4-5'
        }
    )
    // A coding CLI joins its runtime with no provider and is bound right
    // after, so its answer names the channel too: the managed row resolves to
    // the one channel Claude Code speaks.
    const claude = withBinding({ kind: 'platform' }, 'claude-code', providers)
    assert.equal(claude?.kind, 'platform')
    assert.equal(claude?.kind === 'platform' ? claude.providerId : null, 'm-anthropic')
    // A sign-in on the machine is not bound to anything here.
    assert.deepEqual(
        withBinding({ kind: 'runtime-local', profileId: 'p1', label: 'me' }, 'codex', providers),
        { kind: 'runtime-local', profileId: 'p1', label: 'me' }
    )
    // A framework whose runtime manages its providers takes none from us.
    assert.deepEqual(withBinding({ kind: 'platform' }, FIXTURE_FRAMEWORK, providers), {
        kind: 'platform'
    })
    assert.equal(withBinding({ kind: 'platform' }, 'hermes', [managedAnthropic]), null)
    assert.equal(withBinding({ kind: 'platform' }, 'codex', [managedAnthropic]), null)
})

// POST /agent-runtimes/:id/agents takes no provider, and a daemon agent that
// is never told otherwise runs on the machine's own sign-in — so a coding
// agent is bound by the two requests its own settings would send.
test('a joined coding agent is bound by its credentials, then its platform model settings', () => {
    const providers = [managedAnthropic, managedOpenAI, managedGemini, netmind]
    const claude = joinBindingFor(
        'claude-code',
        { kind: 'platform', providerId: 'm-anthropic', model: 'x' },
        providers
    )
    assert.deepEqual(claude?.credentials, {
        claudeCodeCredentials: { providerId: 'm-anthropic' }
    })
    assert.equal(claude?.modelConfig?.modelConfigSource, 'platform')
    assert.equal(claude?.modelConfig?.modelConfig?.framework, 'claude-code')
    const codex = joinBindingFor(
        'codex',
        { kind: 'provider', providerId: 'm-openai', label: 'OpenAI' },
        providers
    )
    assert.deepEqual(codex?.credentials, { codexCredentials: { providerId: 'm-openai' } })
    assert.equal(codex?.modelConfig?.modelConfig?.framework, 'codex')
    assert.equal(
        codex?.modelConfig?.modelConfig?.model,
        providerBindingFor('codex', managedOpenAI)?.model
    )
    // Gemini CLI keeps its own default; only the source is written down.
    assert.deepEqual(
        joinBindingFor('gemini-cli', { kind: 'platform', providerId: 'm-gemini' }, providers),
        {
            credentials: { geminiCliCredentials: { providerId: 'm-gemini' } },
            modelConfig: { modelConfigSource: 'platform' }
        }
    )
    // pi carries the vendor and model in the credential; only the source is
    // written down.
    assert.deepEqual(
        joinBindingFor(
            'pi',
            {
                kind: 'provider',
                providerId: 'k-netmind',
                label: 'NetMind API',
                model: 'anthropic/claude-haiku-4-5'
            },
            providers
        ),
        {
            credentials: {
                piCredentials: {
                    providerId: 'k-netmind',
                    provider: 'anthropic',
                    model: 'anthropic/claude-haiku-4-5'
                }
            },
            modelConfig: { modelConfigSource: 'platform' }
        }
    )
    assert.equal(
        joinBindingFor('codex', { kind: 'runtime-local', profileId: 'p1', label: 'me' }, providers),
        null
    )
    assert.equal(joinBindingFor('openclaw', { kind: 'platform', providerId: 'm-openai' }, providers), null)
})

test('the create request is the one v3 sends: install onto the sandbox and bind, in one POST', () => {
    assert.deepEqual(
        serviceCreateBody({
            framework: 'openclaw',
            target: { sandboxId: 'sb-1' },
            name: ' Bot ',
            workspace: '',
            cost: { kind: 'platform', providerId: 'm-openai', model: 'gpt-5.4-mini' }
        }),
        {
            name: 'Bot',
            framework: 'openclaw',
            runtime: 'sprites',
            sandboxId: 'sb-1',
            openclawCredentials: { providerId: 'm-openai', primaryModelName: 'gpt-5.4-mini' }
        }
    )
    assert.deepEqual(
        serviceCreateBody({
            framework: 'hermes',
            target: { sandboxId: 'sb-1' },
            name: 'H',
            workspace: '',
            cost: {
                kind: 'provider',
                providerId: 'k-netmind',
                label: 'NetMind',
                model: 'anthropic/claude-haiku-4-5'
            }
        }).hermesCredentials,
        { primaryProviderId: 'k-netmind', primaryModelName: 'anthropic/claude-haiku-4-5' }
    )
    assert.deepEqual(
        serviceCreateBody({
            framework: FIXTURE_FRAMEWORK,
            target: { sandboxId: 'sb-1' },
            name: 'N',
            workspace: '/srv/n',
            cost: { kind: 'platform' }
        }),
        { name: 'N', framework: FIXTURE_FRAMEWORK, runtime: 'sprites', sandboxId: 'sb-1', workspace: '/srv/n' }
    )
    // Onto a cloud computer, the same request names the host instead.
    assert.deepEqual(
        serviceCreateBody({
            framework: 'openclaw',
            target: { podHostId: 'pdh_1' },
            name: 'Bot',
            workspace: '',
            cost: { kind: 'platform', providerId: 'm-openai', model: 'gpt-5.4-mini' }
        }),
        {
            name: 'Bot',
            framework: 'openclaw',
            runtime: 'k8s',
            podHostId: 'pdh_1',
            openclawCredentials: { providerId: 'm-openai', primaryModelName: 'gpt-5.4-mini' }
        }
    )
})

test('step ④ names the model the install will be given, and only then', () => {
    const bound = { kind: 'platform', providerId: 'm-openai', model: 'gpt-5.4-mini' } as const
    assert.equal(
        costFull(bound, 'Claude', 'Dify', tt),
        'web.agentNewV4.cost.managed · web.agentNewV4.cost.managedDetail · gpt-5.4-mini'
    )
    // The bar stays at identity: which account, not which model.
    assert.equal(costShort(bound, tt), 'web.agentNewV4.cost.managed')
    // Joining an instance inherits its model; none is claimed.
    assert.equal(
        costFull({ kind: 'platform' }, 'Claude', 'Dify', tt),
        'web.agentNewV4.cost.managed · web.agentNewV4.cost.managedDetail'
    )
})

// Seen on staging [2026-10-08]: Claude Code to step ④, back to ①, Hermes —
// and the bar still offered ③ and ④, where a Create button over an empty
// summary did nothing when pressed.
test('a step counts as answered only while every step before it is', () => {
    const machine: RuntimeChoice = {
        kind: 'runtime',
        runtimeId: 'r1',
        sandboxId: 'h1',
        hostKind: 'sprites',
        hostLabel: 'dev-box',
        ownComputer: false
    }
    const done = {
        ...withRuntime(withFramework(initialFlowState(), 'claude-code'), machine),
        cost: { kind: 'platform' } as const,
        name: 'alert-firefly-5493',
        step: 'name' as const
    }
    assert.deepEqual([...answeredSteps(done)], ['type', 'runtime', 'cost', 'name'])
    const switched = withFramework(done, 'hermes')
    // The name survives a type change, but nothing past ① is answered any
    // more, so nothing past ① may be jumped to.
    assert.equal(switched.name, 'alert-firefly-5493')
    assert.deepEqual([...answeredSteps(switched)], ['type'])
})

test('step ④ refuses to create while an earlier answer is missing', () => {
    const orphan = {
        ...withFramework(initialFlowState(), 'hermes'),
        step: 'name' as const,
        name: 'alert-firefly-5493'
    }
    assert.equal(advanceBlockedKey(orphan), 'web.agentNewV4.blocked.runtime')
    assert.equal(
        advanceBlockedKey({ ...orphan, framework: null }),
        'web.agentNewV4.blocked.type'
    )
})

test('leaving step ② on the machine already chosen keeps step ③', () => {
    const a: RuntimeChoice = {
        kind: 'runtime',
        runtimeId: 'r1',
        sandboxId: 'h1',
        hostKind: 'sprites',
        hostLabel: 'dev-box',
        ownComputer: false
    }
    const b: RuntimeChoice = { ...a, runtimeId: 'r2', sandboxId: 'h2' }
    const answered = {
        ...withRuntime(withFramework(initialFlowState(), 'claude-code'), a),
        cost: { kind: 'platform' } as const
    }
    assert.ok(sameRuntime(a, { ...a }))
    assert.deepEqual(withRuntime(answered, { ...a }).cost, { kind: 'platform' })
    assert.equal(sameRuntime(a, b), false)
    assert.equal(withRuntime(answered, b).cost, null)
    const dify: RuntimeChoice = {
        kind: 'external',
        providerId: 'p1',
        providerLabel: 'dify.mycorp.com',
        remoteRef: '',
        remoteLabel: ''
    }
    assert.equal(sameRuntime(a, dify), false)
    assert.ok(sameRuntime(dify, { ...dify }))
})

// Seen on staging [2026-10-08]: Enter on Back moved the flow forward.
test('Enter moves the flow on only from a text field or the picked row', () => {
    const el = (
        tagName: string,
        over: { type?: string; role?: string; ariaChecked?: string } = {}
    ) => ({
        tagName,
        type: over.type,
        role: over.role ?? null,
        ariaChecked: over.ariaChecked ?? null
    })
    assert.ok(enterAdvances(el('INPUT', { type: 'text' })))
    assert.ok(enterAdvances(el('BUTTON', { role: 'radio', ariaChecked: 'true' })))
    // Back, Change, the bar's cells: Enter keeps its own meaning.
    assert.equal(enterAdvances(el('BUTTON')), false)
    assert.equal(enterAdvances(el('A')), false)
    // A row not yet picked: Enter picks it, it does not advance past it.
    assert.equal(
        enterAdvances(el('BUTTON', { role: 'radio', ariaChecked: 'false' })),
        false
    )
    assert.equal(enterAdvances(el('INPUT', { type: 'checkbox' })), false)
    assert.equal(enterAdvances(el('TEXTAREA')), false)
})

// Seen on staging [2026-10-08]: each of these asked "who pays" and then
// ignored the answer.
test('step ③ is answered and passed over where there is nothing to choose', () => {
    const fresh: RuntimeChoice = {
        kind: 'runtime',
        runtimeId: null,
        sandboxId: 'h1',
        hostKind: 'sprites',
        hostLabel: 'sandbox-006',
        ownComputer: false
    }
    const joined: RuntimeChoice = { ...fresh, runtimeId: 'r9', hostLabel: 'sandbox-002' }
    const service: RuntimeChoice = {
        kind: 'external',
        providerId: 'p1',
        providerLabel: 'dify.mycorp.com',
        remoteRef: '',
        remoteLabel: ''
    }
    assert.deepEqual(fixedCostFor('dify', service), { kind: 'external' })
    // A framework given its models in its own UI takes none at create,
    // whether it is installed now or already runs there.
    assert.deepEqual(fixedCostFor(FIXTURE_FRAMEWORK, fresh), { kind: 'runtime-ui' })
    assert.deepEqual(fixedCostFor(FIXTURE_FRAMEWORK, joined), { kind: 'runtime-ui' })
    // Joining an instance inherits its provider; installing one is a choice.
    assert.deepEqual(fixedCostFor('openclaw', joined), {
        kind: 'inherited',
        label: null,
        machine: 'sandbox-002'
    })
    assert.equal(fixedCostFor('openclaw', fresh), null)
    assert.equal(fixedCostFor('hermes', fresh), null)
    // A coding CLI always has something to choose.
    assert.equal(fixedCostFor('claude-code', joined), null)
})

test('a connected service is created with the binding v1 and v3 send', () => {
    assert.deepEqual(
        externalCreateBody({ framework: 'dify', providerId: 'p1', remoteRef: '', name: ' support ' }),
        { name: 'support', framework: 'dify', runtime: 'external', difyBinding: { providerId: 'p1' } }
    )
    assert.deepEqual(
        externalCreateBody({ framework: 'langflow', providerId: 'p2', remoteRef: ' flow-1 ', name: 'lf' }),
        {
            name: 'lf',
            framework: 'langflow',
            runtime: 'external',
            langflowBinding: { providerId: 'p2', flowId: 'flow-1' }
        }
    )
    assert.deepEqual(
        externalCreateBody({ framework: 'a2a', providerId: 'p3', remoteRef: '', name: 'peer' }),
        { name: 'peer', framework: 'a2a', runtime: 'external', a2aBinding: { providerId: 'p3' } }
    )
    // Only Langflow names something on the service; A2A was being asked for
    // a "Dify app ID".
    assert.ok(needsRemoteRef('langflow'))
    assert.equal(needsRemoteRef('dify'), false)
    assert.equal(needsRemoteRef('a2a'), false)
    const bare: RuntimeChoice = {
        kind: 'external',
        providerId: 'p1',
        providerLabel: 'dify.mycorp.com',
        remoteRef: '',
        remoteLabel: ''
    }
    assert.equal(runtimeFull(bare, tt), 'dify.mycorp.com')
})

test('the machine\'s current payer is read from its credential view', () => {
    const view = (over: Partial<AgentCredentialsView>): AgentCredentialsView =>
        ({
            framework: 'claude-code',
            provider: 'anthropic',
            apiKeyMasked: 'sk-…abcd',
            baseUrl: null,
            savedProvider: null,
            extras: {},
            updatedAt: '',
            ...over
        }) as AgentCredentialsView
    const managed = providerRow({ id: 'm1', providerName: 'Managed Anthropic', source: 'managed' })
    const netmind = providerRow({ id: 'p1', providerName: 'NetMind API' })
    const rows = [managed, netmind]
    assert.deepEqual(
        machineBillingFrom(view({ savedProvider: { id: 'm1', providerName: 'Managed Anthropic' } }), rows),
        { kind: 'managed' }
    )
    assert.deepEqual(
        machineBillingFrom(view({ savedProvider: { id: 'p1', providerName: 'NetMind API' } }), rows),
        { kind: 'provider', providerId: 'p1', label: 'NetMind API' }
    )
    // A pasted key that matches no saved row is still a payer to keep.
    assert.deepEqual(machineBillingFrom(view({}), rows), { kind: 'key' })
    // Nothing stored, a daemon's own sign-in, or a framework with its own
    // UI: there is no account-level payer to keep.
    assert.equal(machineBillingFrom(view({ apiKeyMasked: null }), rows), null)
    assert.equal(machineBillingFrom(view({ localManaged: true }), rows), null)
    assert.equal(machineBillingFrom(view({ unsupported: true }), rows), null)
})

test('keeping the machine\'s payer binds nothing after the join', () => {
    const kept = { kind: 'inherited', label: 'NetMind API', machine: 'sandbox-002' } as const
    assert.equal(joinBindingFor('claude-code', kept, []), null)
    assert.equal(withBinding(kept, 'claude-code', []), kept)
    assert.equal(costShort(kept, tt), 'NetMind API')
    assert.equal(
        costFull(kept, 'Claude', 'Claude Code', tt),
        'NetMind API · web.agentNewV4.cost.inheritedFull(sandbox-002)'
    )
    const unread = { kind: 'inherited', label: null, machine: 'sandbox-002' } as const
    assert.equal(costShort(unread, tt), 'web.agentNewV4.cost.inheritedShort(sandbox-002)')
    assert.equal(costFull(unread, 'Claude', 'OpenClaw', tt), 'web.agentNewV4.cost.inheritedFull(sandbox-002)')
    const own = { kind: 'runtime-ui' } as const
    assert.notEqual(costShort(own, tt, 'NarraNexus'), costFull(own, '', 'NarraNexus', tt))
})

test('step ② and step ④ word the same wait the same way', () => {
    const two = [1, 2] as const
    assert.equal(waitLabel({ kind: 'instant' }, 'Codex', two, tt), 'web.agentNewV4.wait.instant')
    assert.equal(waitLabel({ kind: 'wake' }, 'Codex', two, tt), 'web.agentNewV4.wait.wake')
    assert.equal(
        waitLabel({ kind: 'install', asleep: true }, 'Codex', [5, 7], tt),
        'web.agentNewV4.wait.install(Codex,5,7) · web.agentNewV4.wait.wakesFirst'
    )
    assert.equal(
        waitLabel({ kind: 'install-at-create', asleep: false }, 'OpenClaw', two, tt),
        'web.agentNewV4.wait.installAtCreate(OpenClaw)'
    )
    // Nothing about signing in: that is step ③'s, once the payer is known.
    for (const kind of ['sandbox', 'ownComputer', 'cloudComputer'] as const)
        assert.doesNotMatch(newMachineWaitLabel(kind, 'Codex', false, tt), /signIn/)
    assert.equal(
        createWaitLabel({ installing: true, asleep: false, cli: 'NarraNexus', minutes: [5, 7] }, tt),
        'web.agentNewV4.wait.createInstall(NarraNexus,5,7)'
    )
    assert.equal(
        createWaitLabel({ installing: false, asleep: true, cli: 'Codex', minutes: two }, tt),
        'web.agentNewV4.primary.createFineAsleep'
    )
    // The overrun line waits as long as the promise, plus a wake.
    assert.equal(createBudgetSeconds({ installing: true, asleep: true, minutes: [5, 7] }), 510)
    assert.equal(createBudgetSeconds({ installing: false, asleep: false, minutes: two }), 15)
})

test('an install takes the time its framework says, one to two minutes by default', () => {
    assert.deepEqual(installMinutes('openclaw'), [1, 2])
    assert.deepEqual(installMinutes(FIXTURE_FRAMEWORK), [1, 2])
})

test('your own computer that is offline is listed with how to bring it back', () => {
    const rows = buildMachineOptions({
        framework: 'claude-code',
        runtimes: [runtime({ id: 'r1', kind: 'daemon', hostId: 'd1', agentsCount: 1 })],
        sandboxes: [],
        daemonHosts: [{ ...daemon('d1', 'laptop'), online: false }],
        podHosts: []
    })
    assert.equal(rows[0].state, 'unavailable')
    assert.equal(rows[0].unavailableReason, 'offline')
    assert.equal(rows[0].disabled, true)
})

test('a new sandbox is offered only once the quota says there is room', () => {
    const sandboxRow = (a: RuntimeAccessSummary | null) =>
        buildNewMachineOptions({ framework: 'codex', access: a }).find(
            (o) => o.kind === 'sandbox'
        )
    // Seen on staging [2026-10-08]: "4 of 3 used" — a build started then is
    // refused by the server minutes later.
    assert.equal(sandboxRow(access({ statefulSandboxUsage: 4, statefulSandboxLimit: 3, statefulSandboxRemaining: 0 }))?.disabled, true)
    assert.equal(sandboxRow(null)?.disabled, true)
    assert.equal(sandboxRow(access({}))?.disabled, false)
})

test('a service framework\'s first agent on a machine takes no workspace', () => {
    assert.equal(firstServiceAgent('openclaw', null, 0), true)
    assert.equal(firstServiceAgent('openclaw', 'r1', 0), true)
    assert.equal(firstServiceAgent('openclaw', 'r1', 2), false)
    assert.equal(firstServiceAgent('claude-code', null, 0), false)
})

// Seen on staging [2026-10-08]: Back left the flow, a reload started again at
// step ①, and "+ Create agent" beside a connected computer (`?hostId=`)
// opened the flow with nothing chosen.
test('the address bar keeps the step, the type and the machine', () => {
    const known = (value: string) => value === 'codex'
    const read = (query: string) => readUrl(new URLSearchParams(query), known)
    assert.deepEqual(read(''), { step: 'type', framework: null, host: null, service: null, ref: '' })
    assert.deepEqual(read('step=cost&framework=codex&host=sbx_1'), {
        step: 'cost',
        framework: 'codex',
        host: 'sbx_1',
        service: null,
        ref: ''
    })
    // What the connected-computer link sends.
    assert.equal(read('hostId=dmn_1').host, 'dmn_1')
    // Anything the flow cannot check is dropped, not trusted.
    assert.equal(read('framework=unknown').framework, null)
    assert.equal(read('step=elsewhere').step, 'type')
    // The first step and empty answers leave no trace.
    assert.equal(writeUrl(read('')).toString(), '')
    assert.equal(
        writeUrl(read('step=cost&framework=codex&host=sbx_1')).toString(),
        'step=cost&framework=codex&host=sbx_1'
    )
    assert.equal(hostIdOfRow('host:sbx_1'), 'sbx_1')
    assert.equal(hostIdOfRow('new:sandbox'), null)
})

test('Back and Forward land only on a step whose earlier answers still hold', () => {
    const answered = new Set(['type', 'runtime'] as const)
    assert.equal(furthestStep(answered), 'cost')
    assert.ok(canStandOn('cost', answered))
    assert.ok(canStandOn('type', answered))
    assert.equal(canStandOn('name', answered), false)
    assert.equal(furthestStep(new Set()), 'type')
})

test('a machine that needs nothing done to it is rejoined without work', () => {
    const [ready] = buildMachineOptions({
        framework: 'codex',
        runtimes: [runtime({ id: 'r1', framework: 'codex', hostId: 'h1', agentsCount: 1 })],
        sandboxes: [sandbox('h1', 'dev-box')],
        daemonHosts: [],
        podHosts: []
    })
    assert.equal(choiceWithoutWork(ready, 'codex')?.kind, 'runtime')
    const [bare] = buildMachineOptions({
        framework: 'codex',
        runtimes: [],
        sandboxes: [sandbox('h2', 'scratch')],
        daemonHosts: [],
        podHosts: []
    })
    // Codex would have to be installed first: that is work, so no answer.
    assert.equal(choiceWithoutWork(bare, 'codex'), null)
    const [service] = buildMachineOptions({
        framework: 'openclaw',
        runtimes: [],
        sandboxes: [sandbox('h2', 'scratch')],
        daemonHosts: [],
        podHosts: []
    })
    // A service framework installs at create, so the machine is the answer.
    assert.deepEqual(choiceWithoutWork(service, 'openclaw'), {
        kind: 'runtime',
        runtimeId: null,
        sandboxId: 'h2',
        hostKind: 'sprites',
        hostLabel: 'scratch',
        ownComputer: false
    })
})

// Seen on staging [2026-10-08]: after a type change emptied ② and ③, the bar
// still showed the name made up on the way to ④.
test('a made-up name goes with the answers it was made for; a typed one stays', () => {
    const a: RuntimeChoice = {
        kind: 'runtime',
        runtimeId: 'r1',
        sandboxId: 'h1',
        hostKind: 'sprites',
        hostLabel: 'dev-box',
        ownComputer: false
    }
    const b: RuntimeChoice = { ...a, runtimeId: 'r2', sandboxId: 'h2' }
    const atFour = withSuggestedName(
        {
            ...withRuntime(withFramework(initialFlowState(), 'claude-code'), a),
            cost: { kind: 'platform' } as const,
            step: 'name' as const
        },
        () => 'brave-otter-0001'
    )
    assert.equal(atFour.name, 'brave-otter-0001')
    assert.equal(atFour.nameAuto, true)
    // Only looking back keeps it: nothing it depends on changed.
    assert.equal(withRuntime(atFour, { ...a }).name, 'brave-otter-0001')
    // Another type, or another machine, drops it.
    assert.equal(withFramework(atFour, 'codex').name, '')
    assert.equal(withRuntime(atFour, b).name, '')
    // And a fresh one is offered on the way back to ④.
    assert.equal(
        withSuggestedName(withFramework(atFour, 'codex'), () => 'calm-heron-0002').name,
        'calm-heron-0002'
    )
    // A name the user typed is theirs, whatever changes before it.
    const typed = withTypedName(atFour, 'billing-bot')
    assert.equal(typed.nameAuto, false)
    assert.equal(withFramework(typed, 'codex').name, 'billing-bot')
    assert.equal(withRuntime(typed, b).name, 'billing-bot')
    // Keeping a typed name does not make it an answer: the bar shows it only
    // once the steps before it are answered again.
    assert.equal(answeredSteps(withFramework(typed, 'codex')).has('name'), false)
    // Emptying the field is typing too: it is not refilled behind the user.
    assert.equal(withTypedName(atFour, '').nameAuto, false)
})
