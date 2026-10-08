import type {
    RuntimeAvailability,
    RuntimeHostPowerState,
    RuntimeHostStatus
} from '@manyfold/shared'
import { t } from '@manyfold/i18n'
import type { BadgeTone } from '@/ui'

// The independent host facts of ADR-0037 (lifecycle, power, daemon presence
// and the derived availability), rendered the same way on every admin page.

const AVAILABILITY_TONE: Record<RuntimeAvailability, BadgeTone> = {
    available: 'success',
    wakeable: 'warning',
    offline: 'neutral',
    unavailable: 'error',
    maintenance: 'warning'
}

const LIFECYCLE_TONE: Record<RuntimeHostStatus, BadgeTone> = {
    provisioning: 'warning',
    ready: 'success',
    failed: 'error',
    deleting: 'warning',
    retired: 'neutral',
    maintenance: 'warning'
}

export const availabilityTone = (
    availability: RuntimeAvailability
): BadgeTone => AVAILABILITY_TONE[availability]

export const lifecycleTone = (status: RuntimeHostStatus): BadgeTone =>
    LIFECYCLE_TONE[status]

export const powerLabel = (state: RuntimeHostPowerState | null): string =>
    t(`admin.hostStatus.power.${state ?? 'unknown'}`)

export const daemonLabel = (online: boolean | null): string =>
    online === null
        ? t('admin.hostStatus.daemon.notRegistered')
        : online
          ? t('admin.hostStatus.daemon.online')
          : t('admin.hostStatus.daemon.offline')
