import { runtimeAvailability } from '@manyfold/shared'
import type {
    AgentRuntime,
    RuntimeAvailability,
    RuntimeHostKind,
    RuntimeHostPowerState,
    RuntimeHostStatus
} from '@manyfold/shared'
import { t } from '@manyfold/i18n'
import type { TagTone } from '@/components/Tag'

// The four independent host facts of ADR-0037 — lifecycle, power, daemon
// presence and the derived availability — rendered the same way everywhere.
// Tones follow DESIGN.md §10.6: a sleeping machine is paused (warning) and an
// unplugged computer quiet (idle); neither is a fault.

const POWER_TONE: Record<RuntimeHostPowerState, TagTone> = {
    running: 'success',
    suspended: 'warning',
    // Cold is asleep too, only slower to wake: the same state to the user.
    stopped: 'warning',
    unknown: 'idle'
}

const AVAILABILITY_TONE: Record<RuntimeAvailability, TagTone> = {
    available: 'success',
    wakeable: 'warning',
    offline: 'idle',
    unavailable: 'error'
}

const LIFECYCLE_TONE: Record<RuntimeHostStatus, TagTone> = {
    provisioning: 'info',
    ready: 'success',
    failed: 'error',
    deleting: 'warning',
    retired: 'idle'
}

// The dot a tone draws.
export const TONE_DOT: Record<TagTone, string> = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    idle: 'bg-idle'
}

export interface MachineFacts {
    kind: RuntimeHostKind
    status: RuntimeHostStatus | null
    powerState: RuntimeHostPowerState | null
    daemonOnline: boolean | null
}

const readyAvailability = (machine: MachineFacts): RuntimeAvailability =>
    runtimeAvailability({
        runtime: { status: 'ready' },
        host: {
            kind: machine.kind,
            status: 'ready',
            powerState: machine.powerState
        },
        daemonOnline: machine.daemonOnline === true
    })

const hostedIn = (
    status: RuntimeHostStatus,
    powerState: RuntimeHostPowerState,
    daemonOnline: boolean
): MachineFacts => ({ kind: 'hosted', status, powerState, daemonOnline })

const isAsleep = (
    state: RuntimeHostPowerState | null
): state is 'suspended' | 'stopped' =>
    state === 'suspended' || state === 'stopped'

// One machine, one colour, wherever it is drawn: an agent's badge in the
// chat, a row or a card under Settings › Runtimes. A machine being built or
// taken down shows that; otherwise it reads what a ready runtime on it would.
// Seen on a local stack [2026-09-28]: one sleeping sandbox was blue in the
// chat and amber in Settings, and an unplugged computer grey in one and red
// in the other.
export const machineTone = (machine: MachineFacts): TagTone =>
    machine.status !== null && machine.status !== 'ready'
        ? LIFECYCLE_TONE[machine.status]
        : AVAILABILITY_TONE[readyAvailability(machine)]

// The words for that colour on the machine's own badge. A hosted machine says
// its power, except one that is up with no daemon connected, which cannot take
// a turn.
// Seen on a local stack [2026-09-28]: a sandbox the listing called running,
// its daemon cut off, read a green "Running" beside its amber dot.
export const machineLabel = (machine: MachineFacts): string => {
    if (machine.status !== null && machine.status !== 'ready')
        return hostLifecycleLabel(machine.status)
    if (machine.kind === 'local')
        return daemonPresenceLabel({ online: machine.daemonOnline === true })
    return readyAvailability(machine) === 'available'
        ? powerStateLabel('running')
        : isAsleep(machine.powerState)
          ? powerStateLabel(machine.powerState)
          : t('web.hostStatus.availability.notConnected')
}

// Every badge a sandbox can wear, in the order its "?" lists them: each one
// drawn by machineTone and machineLabel from a machine in that state, so the
// legend cannot say something the badge does not. A sandbox is never retired;
// only a self-owned computer is.
interface LegendRow {
    machine: MachineFacts
    meaning: string
}

const SANDBOX_LEGEND: readonly LegendRow[] = [
    { machine: hostedIn('ready', 'running', true), meaning: 'running' },
    { machine: hostedIn('ready', 'suspended', false), meaning: 'suspended' },
    { machine: hostedIn('ready', 'stopped', false), meaning: 'stopped' },
    { machine: hostedIn('ready', 'running', false), meaning: 'notConnected' },
    { machine: hostedIn('deleting', 'unknown', false), meaning: 'deleting' },
    {
        machine: hostedIn('provisioning', 'unknown', false),
        meaning: 'provisioning'
    },
    { machine: hostedIn('failed', 'unknown', false), meaning: 'failed' }
]

interface LegendEntry {
    tone: TagTone
    label: string
    meaning: string
}

export const sandboxStatusLegend = (): LegendEntry[] =>
    SANDBOX_LEGEND.map(({ machine, meaning }) => ({
        tone: machineTone(machine),
        label: machineLabel(machine),
        meaning: t(`web.hostStatus.sandboxLegend.${meaning}`)
    }))

export const powerStateTone = (state: RuntimeHostPowerState | null): TagTone =>
    POWER_TONE[state ?? 'unknown']

export const powerStateLabel = (state: RuntimeHostPowerState | null): string =>
    t(`web.hostStatus.power.${state ?? 'unknown'}`)

export const availabilityTone = (availability: RuntimeAvailability): TagTone =>
    AVAILABILITY_TONE[availability]

// `wakeable` is two machines: one asleep, and one up whose daemon is not
// connected (just woken, or woken by an exec that brings no daemon up). Only
// the first is asleep; the second is running, and counted as such.
export const availabilityLabel = (
    availability: RuntimeAvailability,
    powerState: RuntimeHostPowerState | null
): string =>
    availability === 'wakeable' && !isAsleep(powerState)
        ? t('web.hostStatus.availability.notConnected')
        : t(`web.hostStatus.availability.${availability}`)

export const hostLifecycleTone = (status: RuntimeHostStatus): TagTone =>
    LIFECYCLE_TONE[status]

export const hostLifecycleLabel = (status: RuntimeHostStatus): string =>
    t(`web.hostStatus.lifecycle.${status}`)

export const daemonPresenceLabel = (
    presence: { registered: boolean; online: boolean } | { online: boolean }
): string =>
    'registered' in presence && !presence.registered
        ? t('web.hostStatus.daemon.notRegistered')
        : presence.online
          ? t('web.hostStatus.daemon.online')
          : t('web.hostStatus.daemon.offline')

export const placementLabel = (placement: AgentRuntime): string =>
    t(`web.hostStatus.placement.${placement}`)

// The sidebar / picker key of a machine: one host is one machine (ADR-0037),
// so the key is the host id and nothing else.
export const hostKey = (hostId: string): string => `host:${hostId}`
