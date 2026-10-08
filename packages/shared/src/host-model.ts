import type { RuntimePlacement } from './constants'

// ADR-0037: one real machine is a Host, a Host has one daemon connection, and a
// Runtime is one framework on one Host. These are the derived facts every
// surface reads off those rows; none of them is stored.

// Who owns the machine. `local` is a computer the user registered with their
// own `mf daemon`; `hosted` is a machine the platform provisioned on a runtime
// provider and whose daemon the platform brings up.
export type RuntimeHostKind = 'local' | 'hosted'

export type RuntimeHostStatus =
    | 'provisioning'
    | 'ready'
    | 'failed'
    | 'deleting'
    | 'retired'
    | 'maintenance'

export type RuntimeHostPowerState =
    | 'running'
    | 'suspended'
    | 'stopped'
    | 'unknown'

// A provider health check's verdict on a hosted machine. Only `unhealthy`, a
// machine that failed to start, is a problem: it puts a ready host into
// maintenance and keeps one there. A sleeping machine answers `needs_repair`
// and a stopped one `repaired`; like `healthy`, both bring a host out.
// `unknown` is a status the provider answered that we don't recognise.
export type SandboxHealthVerdict =
    | 'healthy'
    | 'unhealthy'
    | 'needs_repair'
    | 'repaired'
    | 'unknown'

export type SandboxHealthCheckSource = 'manual' | 'failure' | 'recheck' | 'sweep'

export type RuntimeProviderKind = 'sprites' | 'k8s'

export const runtimeProviderKinds: readonly RuntimeProviderKind[] = [
    'sprites',
    'k8s'
]

export const runtimeProviderKindLabel = (kind: RuntimeProviderKind): string => {
    switch (kind) {
        case 'sprites':
            return 'sprites.dev'
        case 'k8s':
            return 'Kubernetes'
    }
}

export interface PlacementHost {
    kind: RuntimeHostKind
    providerKind: RuntimeProviderKind | null
}

// The product placement of a runtime — Self-owned computer, Stateful sandbox,
// Cloud computer or External API — derived from its host. This is the only
// source of the `RuntimePlacement` label; no row stores it. A provider kind
// added without a placement fails to compile here.
export const placementOf = (host: PlacementHost | null): RuntimePlacement => {
    if (!host) return 'external'
    if (host.kind === 'local') return 'daemon'
    switch (host.providerKind) {
        case 'k8s':
            return 'k8s'
        case 'sprites':
        case null:
            return 'sprites'
    }
}

export interface DaemonPresenceRow {
    rpcConnectedAt: Date | string | null
    lastSeenAt: Date | string | null
}

// A daemon counts as online while its last heartbeat is inside the presence
// window; there is no stored status and no sweep that flips one.
export const DAEMON_PRESENCE_WINDOW_MS = 45_000

const toMillis = (value: Date | string | null): number | null => {
    if (value === null) return null
    const ms = value instanceof Date ? value.getTime() : Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

export const daemonOnline = (
    daemon: DaemonPresenceRow | null | undefined,
    now: number = Date.now()
): boolean => {
    if (!daemon) return false
    const seen = toMillis(daemon.lastSeenAt)
    if (seen === null) return false
    return now - seen < DAEMON_PRESENCE_WINDOW_MS
}

export type RuntimeAvailability =
    // installed, host ready, the machine not suspended and its daemon online:
    // a turn can start now
    | 'available'
    // installed and host ready, but the machine is suspended or stopped (or
    // its daemon is simply not connected yet): a caller may wake it first
    | 'wakeable'
    // a local host whose daemon is offline: only the user can bring it back
    | 'offline'
    // not installed, failed, or the host is not in a usable lifecycle state
    | 'unavailable'
    // a hosted machine its provider's health check reported broken: nothing
    // wakes it until a re-check passes or an admin ends the maintenance
    | 'maintenance'

export interface AvailabilityRuntime {
    status: 'installing' | 'ready' | 'failed'
}

export interface AvailabilityHost {
    kind: RuntimeHostKind
    status: RuntimeHostStatus
    // A hosted machine's power as the status sync keeps it (the provider's
    // listing, overruled by a fresh daemon heartbeat); null where none is kept.
    powerState: RuntimeHostPowerState | null
}

// The single admission function (ADR-0037). chat, files, terminal, herdr and
// automations all ask this; nothing else re-derives "can this agent run".
export const runtimeAvailability = (args: {
    runtime: AvailabilityRuntime
    // null for an external-API runtime, which has no machine
    host: AvailabilityHost | null
    daemonOnline: boolean
}): RuntimeAvailability => {
    if (args.runtime.status !== 'ready') return 'unavailable'
    if (args.host === null) return 'available'
    if (args.host.status === 'maintenance') return 'maintenance'
    if (args.host.status !== 'ready') return 'unavailable'
    // A suspended or stopped VM holds a frozen daemon whose last heartbeat can
    // still sit inside the presence window. Read as `available`, that showed
    // a green agent the concurrent-sandbox count — keyed on the same power
    // state — had already let go of; nothing answers until it is woken.
    if (
        args.host.kind === 'hosted' &&
        (args.host.powerState === 'suspended' ||
            args.host.powerState === 'stopped')
    )
        return 'wakeable'
    if (args.daemonOnline) return 'available'
    return args.host.kind === 'hosted' ? 'wakeable' : 'offline'
}

export const isRuntimeUsable = (availability: RuntimeAvailability): boolean =>
    availability === 'available' || availability === 'wakeable'

export interface AvailabilityAgent {
    status: 'pending' | 'ready' | 'failed'
}

export const agentAvailability = (args: {
    agent: AvailabilityAgent
    runtime: AvailabilityRuntime
    host: AvailabilityHost | null
    daemonOnline: boolean
}): RuntimeAvailability =>
    args.agent.status === 'ready' ? runtimeAvailability(args) : 'unavailable'
