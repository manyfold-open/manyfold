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
import type { RuntimeChoice } from '@/pages/AgentNew/v4/flowState'

// What picking this row costs in waiting, which is all step ② can know.
// Whether a sign-in follows depends on how the user pays, and that is step
// ③'s question: a row that promised "sign in once afterwards" was wrong for
// everyone about to pick Manyfold managed or a key, and one that promised "no
// sign-in needed" because the machine already ran agents was wrong whenever
// those agents' credentials had expired.
// Seen on staging [2026-10-08]: sandbox-002 read "instant · no sign-in
// needed" in step ② — it was asleep, and step ③ then listed both of its
// accounts as expired.
export type MachineWait =
    // Awake and ready for this framework.
    | { kind: 'instant' }
    // Ready, but asleep: it wakes before the agent can join.
    | { kind: 'wake' }
    // The framework is installed onto it when step ② is left.
    | { kind: 'install'; asleep: boolean }
    // A service framework, installed with the agent at step ④
    // (`installsAtCreate`).
    | { kind: 'install-at-create'; asleep: boolean }

const installWait = (
    framework: AgentFramework,
    asleep: boolean
): MachineWait =>
    frameworkCapability(framework).kind === 'service'
        ? { kind: 'install-at-create', asleep }
        : { kind: 'install', asleep }

export type MachineState =
    | 'ready'
    | 'needs-install'
    | 'service-slot-taken'
    | 'not-installable'
    // A machine that cannot take an agent right now: still starting (or still
    // installing this framework), failed to start, a sandbox in maintenance,
    // or your own computer while its daemon is not connected.
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
    wait: MachineWait
    // A sandbox holding nothing at all: flagged so the quota warning can point
    // at something deletable instead of only saying "full".
    idle: boolean
    blockedBy?: AgentFramework
    unavailableReason?: 'starting' | 'failed' | 'maintenance' | 'offline'
    disabled: boolean
}

export type NewMachineKind = 'sandbox' | 'ownComputer' | 'cloudComputer'

export interface NewMachineOption {
    kind: NewMachineKind
    disabled: boolean
    // Quota read-out for the sandbox row: "2 of 5 used".
    used?: number
    limit?: number
}

const sleeping = (sandbox: SandboxSummary | undefined): boolean =>
    sandbox?.powerState === 'suspended' || sandbox?.powerState === 'stopped'

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
        const sandbox = sandboxes.find((s) => s.id === target.hostId)
        const asleep = sleeping(sandbox)
        if (target.type === 'reuse') {
            const runtime = target.runtime
            // A sandbox the provider's health check found broken takes no new
            // agent until it is out of maintenance; it stays listed, saying so.
            const inMaintenance = sandbox?.status === 'maintenance'
            rows.push({
                id: hostKey(target.hostId),
                title: sandbox?.name ?? runtime.hostName ?? runtime.name,
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
                wait: asleep ? { kind: 'wake' } : { kind: 'instant' },
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
            const status = sandbox?.status
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
                wait: installWait(framework, asleep),
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
            wait: { kind: 'instant' },
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
                wait: { kind: 'instant' },
                idle: false,
                disabled: true
            })
            continue
        }
        // Joining needs the daemon connected — it creates the workspace on
        // that machine — so an offline computer is listed with the way to
        // bring it back rather than offered and refused at create.
        rows.push({
            id: hostKey(host.id),
            title: host.name,
            state: host.online ? 'ready' : 'unavailable',
            runtimeId: runtime.id,
            sandboxId: null,
            podHostId: null,
            hostKind: 'daemon',
            ownComputer: true,
            agentsCount: runtime.agentsCount,
            wait: { kind: 'instant' },
            idle: false,
            ...(host.online ? {} : { unavailableReason: 'offline' as const }),
            disabled: !host.online
        })
    }
    // A cloud computer (ADR-0035) runs whatever is installed on it: a runtime
    // for this framework is joined, a ready one without it gets it installed
    // (a service framework at create, with its provider), and the rest stay
    // listed with the reason they cannot. It never sleeps.
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
                wait: { kind: 'instant' },
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
            wait: installWait(framework, false),
            ...(unavailableReason !== undefined ? { unavailableReason } : {}),
            disabled: !podInstallable || unavailableReason !== undefined
        })
    }
    return rows
}

export const buildNewMachineOptions = (args: {
    framework: AgentFramework
    access: RuntimeAccessSummary | null
}): NewMachineOption[] => {
    const { framework, access } = args
    // Until the quota is known the row cannot honestly be offered: a build
    // started over a full quota is refused by the server two minutes later.
    const remaining =
        access === null ? 0 : (access.statefulSandboxRemaining ?? null)
    const options: NewMachineOption[] = [
        {
            kind: 'sandbox',
            disabled: remaining !== null && remaining <= 0,
            used: access?.statefulSandboxUsage,
            limit: access?.statefulSandboxLimit
        },
        {
            kind: 'ownComputer',
            // Not every framework runs on a daemon host. Ask the capability
            // matrix rather than restating it, so the row follows the
            // backend if that changes.
            disabled: !supportsRuntime(framework, 'daemon')
        }
    ]
    // A cloud computer that is not enabled for this account stays listed with
    // that reason — a disappearing option teaches the user nothing.
    options.push({
        kind: 'cloudComputer',
        disabled: access?.cloudComputerEnabled !== true
    })
    return options
}

// The answer step ② gives for a row that needs nothing done to it now: a
// runtime that already exists, or a machine a service framework will be
// installed onto at create. Null when leaving the step on this row builds or
// installs something first.
export const choiceWithoutWork = (
    row: MachineOption,
    framework: AgentFramework
): RuntimeChoice | null => {
    if (row.runtimeId !== null)
        return {
            kind: 'runtime',
            runtimeId: row.runtimeId,
            sandboxId: row.sandboxId,
            hostKind: row.hostKind,
            hostLabel: row.title,
            ownComputer: row.ownComputer
        }
    if (frameworkCapability(framework).kind !== 'service') return null
    if (row.podHostId !== null)
        return {
            kind: 'runtime',
            runtimeId: null,
            sandboxId: null,
            podHostId: row.podHostId,
            hostKind: 'k8s',
            hostLabel: row.title,
            ownComputer: false
        }
    if (row.sandboxId !== null)
        return {
            kind: 'runtime',
            runtimeId: null,
            sandboxId: row.sandboxId,
            hostKind: 'sprites',
            hostLabel: row.title,
            ownComputer: false
        }
    return null
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
