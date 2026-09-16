import test from 'node:test'
import assert from 'node:assert/strict'
import type {
    AgentRuntimeSummary,
    DaemonHostSummary,
    RuntimeAccessSummary,
    SandboxSummary,
    UserModelProviderSummary
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
    costFull,
    costShort,
    creatingPrimary,
    runtimeFull,
    runtimeShort
} from '../src/pages/AgentNew/v4/summaryLabels'
import {
    FRAMEWORK_GROUPS,
    canUseSubscription,
    hasWorkspace,
    installsAtCreate,
    runsOnOurMachine
} from '../src/pages/AgentNew/v4/frameworkCatalog'
import {
    managedChannelFor,
    serviceCreateBody,
    serviceModelFor,
    serviceRowVerdict,
    withServiceBinding
} from '../src/pages/AgentNew/v4/serviceModel'
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
        ...initialFlowState(),
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

// A service framework (OpenClaw / Hermes / NarraNexus) is installed at
// step ④, with the agent, because the install needs the provider step ③ has
// not asked yet. Seen on staging [2026-09-16]: installing OpenClaw at step ②
// answered 500, `cannot resolve base_url for openclaw provider ''`.
test('a service framework installs at create, and its rows owe no sign-in', () => {
    for (const fw of ['openclaw', 'hermes', 'narranexus'] as const)
        assert.equal(installsAtCreate(fw), true, fw)
    for (const fw of ['claude-code', 'codex', 'gemini-cli'] as const)
        assert.equal(installsAtCreate(fw), false, fw)
    const rows = buildMachineOptions({
        framework: 'openclaw',
        runtimes: [
            runtime({ id: 'r1', framework: 'openclaw', hostId: 'h1', agentsCount: 0 })
        ],
        sandboxes: [sandbox('h1', 'busy'), sandbox('h2', 'empty')],
        daemonHosts: []
    })
    assert.equal(rows.find((r) => r.id === 'sandbox:h2')?.signInCost, 'install-at-create')
    // Joining the instance that already runs costs nothing more — and never
    // a sign-in, which this kind of framework does not have.
    assert.equal(rows.find((r) => r.id === 'runtime:r1')?.signInCost, 'none')
    const fresh = (fw: 'openclaw' | 'claude-code') =>
        buildNewMachineOptions({ framework: fw, access: access({}) }).find(
            (o) => o.kind === 'sandbox'
        )?.signInCost
    assert.equal(fresh('openclaw'), 'install-at-create')
    assert.equal(fresh('claude-code'), 'after')
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
    lastTestModels: { openai_responses: ['gpt-5.2', 'gpt-5.4-mini', 'gpt-6'] }
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
    assert.equal(serviceModelFor('openclaw', netmind), 'anthropic/claude-haiku-4-5')
    assert.equal(serviceModelFor('openclaw', managedOpenAI), 'gpt-5.4-mini')
    assert.equal(serviceModelFor('openclaw', untested), null)
})

test('a row the API would refuse stays on screen and says why', () => {
    assert.equal(serviceRowVerdict('openclaw', managedGemini), 'incompatible')
    assert.equal(serviceRowVerdict('openclaw', managedAnthropic), 'incompatible')
    assert.equal(serviceRowVerdict('openclaw', untested), 'untested')
    assert.equal(serviceRowVerdict('openclaw', netmind), 'usable')
})

test('a step ③ answer carries its binding only for a framework installed at create', () => {
    const providers = [managedAnthropic, managedOpenAI, netmind]
    assert.deepEqual(withServiceBinding({ kind: 'platform' }, 'openclaw', providers), {
        kind: 'platform',
        providerId: 'm-openai',
        model: 'gpt-5.4-mini'
    })
    assert.deepEqual(
        withServiceBinding(
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
    // A coding CLI was installed at step ② and picks its model later.
    assert.deepEqual(withServiceBinding({ kind: 'platform' }, 'claude-code', providers), {
        kind: 'platform'
    })
    // NarraNexus takes no provider from us at all.
    assert.deepEqual(withServiceBinding({ kind: 'platform' }, 'narranexus', providers), {
        kind: 'platform'
    })
    assert.equal(withServiceBinding({ kind: 'platform' }, 'hermes', [managedAnthropic]), null)
})

test('the create request is the one v3 sends: install onto the sandbox and bind, in one POST', () => {
    assert.deepEqual(
        serviceCreateBody({
            framework: 'openclaw',
            sandboxId: 'sb-1',
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
            sandboxId: 'sb-1',
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
            framework: 'narranexus',
            sandboxId: 'sb-1',
            name: 'N',
            workspace: '/srv/n',
            cost: { kind: 'platform' }
        }),
        { name: 'N', framework: 'narranexus', runtime: 'sprites', sandboxId: 'sb-1', workspace: '/srv/n' }
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
