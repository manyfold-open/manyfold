import type { TFn } from '@/lib/i18n'
import type { CostChoice, RuntimeChoice } from '@/pages/AgentNew/v4/flowState'

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
    // Which service, and which app on it — the endpoint alone does not say
    // which of a user's Dify apps this agent is bound to.
    return `${runtime.providerLabel} · ${runtime.remoteLabel}`
}

export const costShort = (cost: CostChoice | null, t: TFn): string => {
    if (cost === null) return ''
    // The email, not "your Claude account": several accounts can be signed in
    // on one machine, and the bar is the place that has to say which.
    if (cost.kind === 'runtime-local') return cost.label
    if (cost.kind === 'provider') return cost.label
    if (cost.kind === 'platform') return t('web.agentNewV4.cost.managed')
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
        return `${cost.label} · ${t('web.agentNewV4.cost.ownKeyDetail')}`
    if (cost.kind === 'platform')
        return `${t('web.agentNewV4.cost.managed')} · ${t('web.agentNewV4.cost.managedDetail')}`
    return t('web.agentNewV4.cost.externalSummary', { service })
}

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
    t: TFn
): { label: string; fine: string } => {
    const creating = t('web.agentNewV4.primary.creating')
    return {
        // Below two seconds the count is noise: it would read "· 0s" and then
        // "· 1s" on a create that is already finishing.
        label:
            elapsedSeconds < 2
                ? creating
                : `${creating} · ${elapsedSeconds}s`,
        fine:
            elapsedSeconds > budgetSeconds
                ? t('web.agentNewV4.primary.tookLonger')
                : cost
    }
}
