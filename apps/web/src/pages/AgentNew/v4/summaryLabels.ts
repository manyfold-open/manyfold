import type { TFn } from '@/lib/i18n'
import type { CostChoice, RuntimeChoice } from '@/pages/AgentNew/v4/flowState'
import type {
    MachineWait,
    NewMachineKind
} from '@/pages/AgentNew/v4/machineOptions'

// What picking a machine costs in waiting, worded once for step ②'s rows and
// its button, so the two cannot disagree — and with the same facts step ④
// states for the create (`createWaitLabel`), so the two steps cannot either.
export const waitLabel = (
    wait: MachineWait,
    cli: string,
    minutes: readonly [number, number],
    t: TFn
): string => {
    if (wait.kind === 'instant') return t('web.agentNewV4.wait.instant')
    if (wait.kind === 'wake') return t('web.agentNewV4.wait.wake')
    if (wait.kind === 'install-at-create')
        return t('web.agentNewV4.wait.installAtCreate', { cli })
    const install = t('web.agentNewV4.wait.install', {
        cli,
        min: String(minutes[0]),
        max: String(minutes[1])
    })
    return wait.asleep
        ? `${install} · ${t('web.agentNewV4.wait.wakesFirst')}`
        : install
}

export const newMachineWaitLabel = (
    kind: NewMachineKind,
    cli: string,
    installsAtCreate: boolean,
    t: TFn
): string =>
    kind === 'sandbox'
        ? installsAtCreate
            ? t('web.agentNewV4.wait.buildService', { cli })
            : t('web.agentNewV4.wait.build', { cli })
        : kind === 'ownComputer'
          ? t('web.agentNewV4.wait.connect')
          : t('web.agentNewV4.primary.leavesFlow')

// The create's own wait, beside step ④'s button: joining a machine that is
// awake is seconds, a sleeping one wakes first, and a service framework is
// installed by this very request.
export const createWaitLabel = (
    args: {
        installing: boolean
        asleep: boolean
        cli: string
        minutes: readonly [number, number]
    },
    t: TFn
): string => {
    if (!args.installing)
        return args.asleep
            ? t('web.agentNewV4.primary.createFineAsleep')
            : t('web.agentNewV4.primary.createFine')
    const install = t('web.agentNewV4.wait.createInstall', {
        cli: args.cli,
        min: String(args.minutes[0]),
        max: String(args.minutes[1])
    })
    return args.asleep
        ? `${install} · ${t('web.agentNewV4.wait.wakesFirst')}`
        : install
}

// How long the button waits before saying the create is taking longer than
// usual: the promise above, plus a minute for a wake, plus slack.
export const createBudgetSeconds = (args: {
    installing: boolean
    asleep: boolean
    minutes: readonly [number, number]
}): number =>
    (args.installing ? args.minutes[1] * 60 + 30 : 15) +
    (args.asleep ? 60 : 0)

// Step ② labels an existing machine by its kind, and step ④'s qualifier
// echoes the words the user just read there rather than inventing a second
// vocabulary for the same four machines — which is why the map lives here and
// not inside either step.
export const MACHINE_KIND_KEY = {
    sprites: 'web.agentNewV4.machine.sandbox',
    daemon: 'web.agentNewV4.machine.ownComputer',
    k8s: 'web.agentNewV4.machine.cloudComputer',
    external: 'web.agentNewV4.machine.sandbox'
} as const

// Two precisions of the same answer, written side by side so they cannot
// drift apart.
//
// SHORT is for the step bar: one truncating line per step, on screen the whole
// time, read at a glance — so it carries the identity and nothing else. Which
// machine. Which account.
//
// FULL is for step ④'s confirmation list, which is seen once, sits beside the
// Create button, and can afford the qualifier the bar had no room for: what
// kind of machine that is, what paying with that account actually means. The
// two summaries coexist on the last screen on purpose; printing the identical
// string twice would make the second one read as a mistake rather than as the
// closer look.

export const runtimeShort = (runtime: RuntimeChoice | null): string => {
    if (runtime === null) return ''
    if (runtime.kind === 'runtime') return runtime.hostLabel
    return runtime.providerLabel
}

export const runtimeFull = (
    runtime: RuntimeChoice | null,
    t: TFn
): string => {
    if (runtime === null) return ''
    if (runtime.kind === 'runtime')
        return `${runtime.hostLabel} · ${t(MACHINE_KIND_KEY[runtime.hostKind])}`
    // Which service, and which flow on it. Only Langflow names one: a Dify
    // key and an A2A card already address a single app.
    return runtime.remoteLabel === ''
        ? runtime.providerLabel
        : `${runtime.providerLabel} · ${runtime.remoteLabel}`
}

export const costShort = (
    cost: CostChoice | null,
    t: TFn,
    // The framework's display name, for a framework configured in its own UI.
    service = ''
): string => {
    if (cost === null) return ''
    // The email, not "your Claude account": several accounts can be signed in
    // on one machine, and the bar is the place that has to say which.
    if (cost.kind === 'runtime-local') return cost.label
    if (cost.kind === 'provider') return cost.label
    if (cost.kind === 'platform') return t('web.agentNewV4.cost.managed')
    if (cost.kind === 'inherited')
        return (
            cost.label ??
            t('web.agentNewV4.cost.inheritedShort', { machine: cost.machine })
        )
    if (cost.kind === 'runtime-ui')
        return t('web.agentNewV4.cost.runtimeUiShort', { service })
    return t('web.agentNewV4.cost.externalShort')
}

export const costFull = (
    cost: CostChoice | null,
    // The vendor behind the chosen CLI (Claude / ChatGPT / Google) for a
    // subscription, and the service name (Dify / Langflow / A2A) for an agent
    // that bills on the user's own side. Passed in rather than derived here:
    // both come from `frameworkMeta`, which imports .svg assets this module
    // must stay free of so it can be covered by the node:test suite.
    vendor: string,
    service: string,
    t: TFn
): string => {
    if (cost === null) return ''
    if (cost.kind === 'runtime-local')
        return `${cost.label} · ${t('web.agentNewV4.cost.subscriptionOf', { vendor })}`
    if (cost.kind === 'provider')
        return `${cost.label} · ${t('web.agentNewV4.cost.ownKeyDetail')}${modelSuffix(cost.model)}`
    if (cost.kind === 'platform')
        return `${t('web.agentNewV4.cost.managed')} · ${t('web.agentNewV4.cost.managedDetail')}${modelSuffix(cost.model)}`
    if (cost.kind === 'inherited') {
        const same = t('web.agentNewV4.cost.inheritedFull', {
            machine: cost.machine
        })
        return cost.label === null ? same : `${cost.label} · ${same}`
    }
    if (cost.kind === 'runtime-ui')
        return t('web.agentNewV4.cost.runtimeUiSummary', { service })
    return t('web.agentNewV4.cost.externalSummary', { service })
}

// The model a service framework will be installed with, when the install is
// part of the create. It is named here and nowhere earlier: step ③ asks who
// pays, and the model is a consequence of that answer, decided by the same
// rules the API applies. An agent that joins an existing instance inherits
// that instance's model instead, so no model is claimed for it.
const modelSuffix = (model: string | undefined): string =>
    model === undefined ? '' : ` · ${model}`

const waitingPrimary = (
    verb: string,
    overrun: string,
    elapsedSeconds: number,
    budgetSeconds: number,
    cost: string
): { label: string; fine: string } => ({
    // Below two seconds the count is noise: it would read "· 0s" and then
    // "· 1s" on a create that is already finishing.
    label: elapsedSeconds < 2 ? verb : `${verb} · ${elapsedSeconds}s`,
    fine: elapsedSeconds > budgetSeconds ? overrun : cost
})

// What the primary button says while a create is in flight.
//
// The request carries no progress of its own — one POST, and the server says
// nothing until it answers — so the only honest signals are that it is running
// and how long it has been. A progress bar here would be invented, and an
// invented one is worst exactly when it matters: it keeps moving while the
// thing is stuck.
//
// The cost line does not move. It says what this wait will cost BEFORE the
// press, stays put while the request runs, and is only REPLACED when the wait
// overruns — so nothing appears or disappears mid-wait, the one moving thing
// is the count inside the button, and the one text change is itself the news.
export const creatingPrimary = (
    elapsedSeconds: number,
    budgetSeconds: number,
    cost: string,
    t: TFn,
    // A create that installs the framework cannot promise that a failure
    // leaves nothing behind: the machine it installs onto stays.
    installing = false
): { label: string; fine: string } =>
    waitingPrimary(
        t('web.agentNewV4.primary.creating'),
        installing
            ? t('web.agentNewV4.primary.longerThanUsual')
            : t('web.agentNewV4.primary.tookLonger'),
        elapsedSeconds,
        budgetSeconds,
        cost
    )

export type PreparePhase = 'build' | 'install'

// What the primary button says while step ② builds the machine or installs
// the CLI onto it — the same contract as the create's. This wait is two
// requests rather than one, the build and then the install, so the label can
// name the one running without inventing anything; the count spans both,
// because the cost line promised one number for the pair. The overrun line
// drops the create's "a failure leaves nothing half-made": a build that fails
// leaves its machine behind, marked failed.
export const preparingPrimary = (
    phase: PreparePhase,
    cli: string,
    elapsedSeconds: number,
    budgetSeconds: number,
    cost: string,
    t: TFn
): { label: string; fine: string } =>
    waitingPrimary(
        phase === 'build'
            ? t('web.agentNewV4.primary.building')
            : t('web.agentNewV4.primary.installing', { cli }),
        t('web.agentNewV4.primary.longerThanUsual'),
        elapsedSeconds,
        budgetSeconds,
        cost
    )
