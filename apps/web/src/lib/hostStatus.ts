import type {
    AgentRuntime,
    RuntimeAvailability,
    RuntimeHostPowerState,
    RuntimeHostStatus
} from '@manyfold/shared'
import { t } from '@manyfold/i18n'
import type { TagTone } from '@/components/Tag'

// The four independent host facts of ADR-0037 — lifecycle, power, daemon
// presence and the derived availability — rendered the same way everywhere.
// Tones follow DESIGN.md §10.6: a sleeping machine is quiet, not a fault.

const POWER_TONE: Record<RuntimeHostPowerState, TagTone> = {
    running: 'success',
    suspended: 'warning',
    stopped: 'idle',
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

export const powerStateTone = (state: RuntimeHostPowerState | null): TagTone =>
    POWER_TONE[state ?? 'unknown']

export const powerStateLabel = (state: RuntimeHostPowerState | null): string =>
    t(`web.hostStatus.power.${state ?? 'unknown'}`)

export const availabilityTone = (availability: RuntimeAvailability): TagTone =>
    AVAILABILITY_TONE[availability]

export const availabilityLabel = (availability: RuntimeAvailability): string =>
    t(`web.hostStatus.availability.${availability}`)

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
