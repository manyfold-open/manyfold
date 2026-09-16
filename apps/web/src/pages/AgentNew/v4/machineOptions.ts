import { frameworkCapability, supportsRuntime } from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime,
    AgentRuntimeSummary,
    DaemonHostSummary,
    RuntimeAccessSummary,
    SandboxSummary
} from '@manyfold/shared'
import { computeSpriteTargets } from '@/lib/agentCreate/spriteTargets'

// What picking this row costs. Time alone is not the cost: a fresh sandbox is
// two minutes AND a sign-in, while reusing a machine that already runs agents
// is neither. Showing only the minutes lets the user believe a new machine is
// two minutes more expensive when it is really two minutes plus a trip to a
// vendor's website — so the hidden half is promoted to the moment of choice.
export type SignInCost =
    // Already proven working: this runtime runs agents today, so a new one
    // inherits whatever makes them work. We cannot know WHICH credential that
    // is without waking the machine (step ③ shows that, on purpose, without a
    // wake), but "nothing more to set up" is true either way.
    | 'none'
    // A runtime that exists but has never run an agent — a machine prepared in
    // an earlier, abandoned run of this flow. It reappears here as an ordinary
    // option, with no "last time" marker on it.
    | 'next-step'
    | 'after'
    // A daemon host signs in on the user's own computer, so it is already done
    // if they have ever signed in there.
    | 'already-if-signed-in'
    // A service framework (OpenClaw / Hermes / NarraNexus) never signs in —
    // it is handed its provider when installed, and in this flow that install
    // happens at step ④ with the agent (`installsAtCreate`). Its rows owe no
    // sign-in, so the cost column says what they owe instead.
    | 'install-at-create'

const forFramework = (
    framework: AgentFramework,
    cost: SignInCost
): SignInCost => {
    if (frameworkCapability(framework).kind !== 'service') return cost
    return cost === 'after' ? 'install-at-create' : 'none'
}

export type MachineState =
    | 'ready'
    | 'needs-install'
    | 'service-slot-taken'
    | 'not-installable'
    | 'framework-fixed'

export interface MachineOption {
    id: string
    title: string
    state: MachineState
    // Null until the framework is actually brought up on this machine — which
    // happens when the user picks the row, not when they leave the step.
    runtimeId: string | null
    sandboxId: string | null
    hostKind: AgentRuntime
    ownComputer: boolean
    agentsCount: number
    signInCost: SignInCost
    // A sandbox holding nothing at all: flagged so the quota warning can point
    // at something deletable instead of only saying "full".
    idle: boolean
    blockedBy?: AgentFramework
    disabled: boolean
}

export type NewMachineKind = 'sandbox' | 'ownComputer' | 'cloudComputer'

export interface NewMachineOption {
    kind: NewMachineKind
    disabled: boolean
    // Quota read-out for the sandbox row: "2 of 5 used".
    used?: number
    limit?: number
    signInCost: SignInCost
}

const daemonHasFramework = (
    runtimes: AgentRuntimeSummary[],
    hostId: string,
    framework: AgentFramework
): AgentRuntimeSummary | undefined =>
    runtimes.find(
        (r) =>
            r.kind === 'daemon' &&
            r.daemonId === hostId &&
            r.framework === framework &&
            r.status !== 'failed'
    )

// The machines the user already has, for the framework chosen in step ①.
// Rows the framework cannot join stay in the list and carry their reason —
// a user who cannot find their own machine assumes it was deleted.
export const buildMachineOptions = (args: {
    framework: AgentFramework
    runtimes: AgentRuntimeSummary[]
    sandboxes: SandboxSummary[]
    daemonHosts: DaemonHostSummary[]
}): MachineOption[] => {
    const { framework, runtimes, sandboxes, daemonHosts } = args
    const rows: MachineOption[] = []
    for (const target of computeSpriteTargets(runtimes, framework, sandboxes)) {
        if (target.type === 'reuse') {
            const runtime = target.runtime
            rows.push({
                id: 'runtime:' + runtime.id,
                title:
                    sandboxes.find((s) => s.id === target.hostId)?.name ??
                    runtime.spriteName ??
                    runtime.name,
                state: 'ready',
                runtimeId: runtime.id,
                sandboxId: target.hostId,
                hostKind: 'sprites',
                ownComputer: false,
                agentsCount: runtime.agentsCount,
                signInCost: runtime.agentsCount > 0 ? 'none' : 'next-step',
                idle: false,
                disabled: false
            })
            continue
        }
        if (target.type === 'attach') {
            rows.push({
                id: 'sandbox:' + target.hostId,
                title: target.name ?? target.spriteName ?? target.hostId,
                state: 'needs-install',
                runtimeId: null,
                sandboxId: target.hostId,
                hostKind: 'sprites',
                ownComputer: false,
                agentsCount: 0,
                signInCost: 'after',
                idle: target.runtimeCount === 0,
                disabled: false
            })
            continue
        }
        rows.push({
            id: 'sandbox:' + target.hostId,
            title: target.name ?? target.spriteName ?? target.hostId,
            state: 'service-slot-taken',
            runtimeId: null,
            sandboxId: target.hostId,
            hostKind: 'sprites',
            ownComputer: false,
            agentsCount: 0,
            signInCost: 'after',
            idle: false,
            blockedBy: target.blockedBy,
            disabled: true
        })
    }
    for (const host of daemonHosts) {
        const runtime = daemonHasFramework(runtimes, host.id, framework)
        // We never install onto someone's own computer — they do, and the
        // daemon notices within about five minutes. Saying that needs the
        // framework's name, which is exactly what asking for the type first
        // buys: "your computer does not have Gemini CLI" instead of a vague
        // "cannot install here".
        if (runtime === undefined) {
            rows.push({
                id: 'daemon:' + host.id,
                title: host.name,
                state: 'not-installable',
                runtimeId: null,
                sandboxId: null,
                hostKind: 'daemon',
                ownComputer: true,
                agentsCount: 0,
                signInCost: 'already-if-signed-in',
                idle: false,
                disabled: true
            })
            continue
        }
        rows.push({
            id: 'runtime:' + runtime.id,
            title: host.name,
            state: 'ready',
            runtimeId: runtime.id,
            sandboxId: null,
            hostKind: 'daemon',
            ownComputer: true,
            agentsCount: runtime.agentsCount,
            signInCost:
                runtime.agentsCount > 0 ? 'none' : 'already-if-signed-in',
            idle: false,
            disabled: false
        })
    }
    // A cloud computer takes its framework from the image chosen at purchase,
    // so one that holds a different framework can never host this agent. It
    // stays visible with that reason rather than vanishing.
    for (const runtime of runtimes) {
        if (runtime.kind !== 'k8s') continue
        if (runtime.framework === framework) {
            rows.push({
                id: 'runtime:' + runtime.id,
                title: runtime.clusterName ?? runtime.name,
                state: 'ready',
                runtimeId: runtime.id,
                sandboxId: null,
                hostKind: 'k8s',
                ownComputer: false,
                agentsCount: runtime.agentsCount,
                signInCost: runtime.agentsCount > 0 ? 'none' : 'next-step',
                idle: false,
                disabled: false
            })
            continue
        }
        rows.push({
            id: 'runtime:' + runtime.id,
            title: runtime.clusterName ?? runtime.name,
            state: 'framework-fixed',
            runtimeId: null,
            sandboxId: null,
            hostKind: 'k8s',
            ownComputer: false,
            agentsCount: runtime.agentsCount,
            signInCost: 'after',
            idle: false,
            blockedBy: runtime.framework,
            disabled: true
        })
    }
    return rows.map((row) => ({
        ...row,
        signInCost: forFramework(framework, row.signInCost)
    }))
}

export const buildNewMachineOptions = (args: {
    framework: AgentFramework
    access: RuntimeAccessSummary | null
}): NewMachineOption[] => {
    const { framework, access } = args
    const remaining = access?.statefulSandboxRemaining ?? null
    const options: NewMachineOption[] = [
        {
            kind: 'sandbox',
            disabled: remaining !== null && remaining <= 0,
            used: access?.statefulSandboxUsage,
            limit: access?.statefulSandboxLimit,
            signInCost: forFramework(framework, 'after')
        },
        {
            kind: 'ownComputer',
            // The capability matrix has exactly one forbidden cell today
            // (NarraNexus cannot run on a daemon host). Ask it rather than
            // restating it, so the row follows the backend if that changes.
            disabled: !supportsRuntime(framework, 'daemon'),
            signInCost: 'already-if-signed-in'
        }
    ]
    // A cloud computer that has not been bought reads as "needs a plan", not
    // as a missing row — a disappearing option teaches the user nothing.
    options.push({
        kind: 'cloudComputer',
        disabled: access?.cloudComputerEnabled !== true,
        signInCost: 'after'
    })
    return options
}
