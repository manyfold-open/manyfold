import { frameworkCapability, supportsRuntime } from '@manyfold/shared'
import type {
    AgentFramework,
    RuntimePlacement,
    AgentRuntimeSummary,
    DaemonHostSummary,
    PodHostSummary,
    RuntimeAccessSummary,
    SandboxSummary
} from '@manyfold/shared'
import { computeSpriteTargets } from '@/lib/agentCreate/spriteTargets'
import { hostKey } from '@/lib/hostStatus'

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
    // A service framework such as OpenClaw or Hermes never signs in —
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
    // A machine that cannot take an agent right now: still starting (or still
    // installing this framework), failed to start, or a sandbox in maintenance.
    | 'unavailable'

// One row per machine (ADR-0037): `id` is the host key, whatever the row
// offers to do on it.
export interface MachineOption {
    id: string
    title: string
    state: MachineState
    // Null until the framework is actually brought up on this machine — which
    // happens when the user picks the row, not when they leave the step.
    runtimeId: string | null
    sandboxId: string | null
    // The cloud computer the row is, when the framework still has to be
    // installed on it.
    podHostId: string | null
    hostKind: RuntimePlacement
    ownComputer: boolean
    agentsCount: number
    signInCost: SignInCost
    // A sandbox holding nothing at all: flagged so the quota warning can point
    // at something deletable instead of only saying "full".
    idle: boolean
    blockedBy?: AgentFramework
    unavailableReason?: 'starting' | 'failed' | 'maintenance'
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
            r.hostId === hostId &&
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
    podHosts: PodHostSummary[]
}): MachineOption[] => {
    const { framework, runtimes, sandboxes, daemonHosts, podHosts } = args
    const rows: MachineOption[] = []
    for (const target of computeSpriteTargets(runtimes, framework, sandboxes)) {
        if (target.type === 'reuse') {
            const runtime = target.runtime
            // A sandbox the provider's health check found broken takes no new
            // agent until it is out of maintenance; it stays listed, saying so.
            const inMaintenance =
                sandboxes.find((s) => s.id === target.hostId)?.status ===
                'maintenance'
            rows.push({
                id: hostKey(target.hostId),
                title:
                    sandboxes.find((s) => s.id === target.hostId)?.name ??
                    runtime.hostName ??
                    runtime.name,
                state: inMaintenance ? 'unavailable' : 'ready',
                ...(inMaintenance
                    ? { unavailableReason: 'maintenance' as const }
                    : {}),
                runtimeId: runtime.id,
                sandboxId: target.hostId,
                podHostId: null,
                hostKind: 'sprites',
                ownComputer: false,
                agentsCount: runtime.agentsCount,
                signInCost: runtime.agentsCount > 0 ? 'none' : 'next-step',
                idle: false,
                disabled: inMaintenance
            })
            continue
        }
        if (target.type === 'attach') {
            // The attach targets include every sandbox, whatever its own
            // state. One whose build failed, or has not finished, cannot take
            // an install — the API answers "not reachable" — so it stays
            // listed with the reason, as a cloud computer in that state does.
            // Seen on a local stack [2026-09-27]: the sandbox left behind by
            // a failed build was offered as an empty machine to install onto.
            const status = sandboxes.find((s) => s.id === target.hostId)?.status
            const unavailableReason =
                status === 'failed'
                    ? 'failed'
                    : status === 'provisioning'
                      ? 'starting'
                      : status === 'maintenance'
                        ? 'maintenance'
                        : undefined
            rows.push({
                id: hostKey(target.hostId),
                title: target.name ?? target.hostId,
                state:
                    unavailableReason !== undefined
                        ? 'unavailable'
                        : 'needs-install',
                runtimeId: null,
                sandboxId: target.hostId,
                podHostId: null,
                hostKind: 'sprites',
                ownComputer: false,
                agentsCount: 0,
                signInCost: 'after',
                idle: target.runtimeCount === 0,
                ...(unavailableReason !== undefined
                    ? { unavailableReason }
                    : {}),
                disabled: unavailableReason !== undefined
            })
            continue
        }
        rows.push({
            id: hostKey(target.hostId),
            title: target.name ?? target.hostId,
            state: 'service-slot-taken',
            runtimeId: null,
            sandboxId: target.hostId,
            podHostId: null,
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
                id: hostKey(host.id),
                title: host.name,
                state: 'not-installable',
                runtimeId: null,
                sandboxId: null,
                podHostId: null,
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
            id: hostKey(host.id),
            title: host.name,
            state: 'ready',
            runtimeId: runtime.id,
            sandboxId: null,
            podHostId: null,
            hostKind: 'daemon',
            ownComputer: true,
            agentsCount: runtime.agentsCount,
            signInCost:
                runtime.agentsCount > 0 ? 'none' : 'already-if-signed-in',
            idle: false,
            disabled: false
        })
    }
    // A cloud computer (ADR-0035) runs whatever is installed on it: a runtime
    // for this framework is joined, a ready one without it gets it installed
    // (a service framework at create, with its provider), and the rest stay
    // listed with the reason they cannot.
    const podInstallable = supportsRuntime(framework, 'k8s')
    for (const host of podHosts) {
        const runtime = host.runtimes.find(
            (r) => r.framework === framework && r.status !== 'failed'
        )
        const row = {
            id: hostKey(host.id),
            title: host.name,
            sandboxId: null,
            hostKind: 'k8s' as const,
            ownComputer: false,
            idle: false
        }
        if (runtime?.status === 'ready') {
            rows.push({
                ...row,
                state: 'ready',
                runtimeId: runtime.id,
                podHostId: null,
                agentsCount: runtime.agentsCount,
                signInCost: runtime.agentsCount > 0 ? 'none' : 'next-step',
                disabled: false
            })
            continue
        }
        const unavailableReason =
            host.status === 'failed'
                ? 'failed'
                : host.status === 'provisioning' || runtime !== undefined
                  ? 'starting'
                  : undefined
        rows.push({
            ...row,
            state: !podInstallable
                ? 'not-installable'
                : unavailableReason !== undefined
                  ? 'unavailable'
                  : 'needs-install',
            runtimeId: null,
            podHostId: host.id,
            agentsCount: 0,
            signInCost: 'after',
            ...(unavailableReason !== undefined ? { unavailableReason } : {}),
            disabled: !podInstallable || unavailableReason !== undefined
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
            // Not every framework runs on a daemon host. Ask the capability
            // matrix rather than restating it, so the row follows the
            // backend if that changes.
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

// The sandbox a failed build in step ② left behind: the row that was not in
// the list before the build and now reads failed.
export const sandboxLeftFailed = (
    before: ReadonlySet<string>,
    after: readonly SandboxSummary[]
): SandboxSummary | null =>
    after.find((row) => !before.has(row.id) && row.status === 'failed') ??
    null

// That sandbox is built again in place only while the list still shows it
// failed: deleted or retried elsewhere, the next press builds a new one.
export const sandboxToRetry = (
    sandboxes: readonly SandboxSummary[],
    failedBuildId: string | null
): SandboxSummary | null =>
    failedBuildId === null
        ? null
        : (sandboxes.find(
              (row) => row.id === failedBuildId && row.status === 'failed'
          ) ?? null)
