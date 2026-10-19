import type {
    ProviderMachineSummary,
    RuntimeHostPowerState,
    RuntimeProviderCapabilities
} from '@manyfold/shared'
import { t } from '@manyfold/i18n'
import { ApiError } from '@manyfold/sdk'
import type { BadgeTone } from '@/ui'

// What a provider's inventory page decides without the network, kept apart
// from the pages so it can be tested.

export type TrackingFilter = 'all' | 'tracked' | 'untracked'

export interface MachineFilters {
    search: string
    tracking: TrackingFilter
    power: RuntimeHostPowerState | 'all'
}

export const filterMachines = (
    machines: ProviderMachineSummary[],
    filters: MachineFilters
): ProviderMachineSummary[] => {
    const needle = filters.search.trim().toLowerCase()
    return machines.filter((machine) => {
        if (filters.tracking === 'tracked' && !machine.host) return false
        if (filters.tracking === 'untracked' && machine.host) return false
        if (filters.power !== 'all' && machine.power !== filters.power)
            return false
        if (!needle) return true
        return [
            machine.name,
            machine.id,
            machine.host?.name,
            machine.host?.ownerEmail
        ].some((value) => value?.toLowerCase().includes(needle))
    })
}

export const tallyMachines = (
    machines: ProviderMachineSummary[]
): { total: number; tracked: number; untracked: number } => {
    const tracked = machines.filter((machine) => machine.host).length
    return {
        total: machines.length,
        tracked,
        untracked: machines.length - tracked
    }
}

const POWER_TONE: Record<RuntimeHostPowerState, BadgeTone> = {
    running: 'success',
    suspended: 'brand',
    stopped: 'neutral',
    unknown: 'neutral'
}

export const machinePowerTone = (power: RuntimeHostPowerState): BadgeTone =>
    POWER_TONE[power]

// An untracked machine that ran this recently may be another deployment's
// live sandbox on a shared account.
const RECENT_RUN_MS = 24 * 60 * 60_000

export const ranRecently = (
    machine: Pick<ProviderMachineSummary, 'power' | 'lastRunningAt'>,
    now = Date.now()
): boolean => {
    if (machine.power === 'running') return true
    if (!machine.lastRunningAt) return false
    const at = Date.parse(machine.lastRunningAt)
    return Number.isFinite(at) && now - at < RECENT_RUN_MS
}

interface MachineActionState {
    restart: boolean
    upgrade: boolean
    delete: boolean
    // A sandbox still being made or torn down: restart and upgrade wait.
    hostBusy: boolean
    // Agents on its sandbox, which a delete waits for.
    agents: number
}

export const machineActions = (
    machine: Pick<ProviderMachineSummary, 'host'>,
    capabilities: RuntimeProviderCapabilities
): MachineActionState => {
    const hostBusy =
        machine.host !== null &&
        (machine.host.status === 'provisioning' ||
            machine.host.status === 'deleting')
    const agents = machine.host?.agentsCount ?? 0
    return {
        restart: capabilities.restartMachine && !hostBusy,
        upgrade: capabilities.upgradeMachine && !hostBusy,
        delete: capabilities.inventory && agents === 0,
        hostBusy,
        agents
    }
}

// An inventory call's failure in words an admin can act on.
export const machineErrorMessage = (err: unknown): string => {
    if (!(err instanceof ApiError))
        return err instanceof Error ? err.message : String(err)
    const said = err.serverMessage ?? err.message
    switch (err.code) {
        case 'PROVIDER_RATE_LIMITED':
            return t('admin.runtimeProviders.machine.errors.rateLimited')
        case 'PROVIDER_AUTH_FAILED':
            return t('admin.runtimeProviders.machine.errors.authFailed')
        case 'PROVIDER_UNAVAILABLE':
            return t('admin.runtimeProviders.machine.errors.unavailable', {
                message: said
            })
        case 'PROVIDER_MACHINE_NOT_FOUND':
            return t('admin.runtimeProviders.machine.errors.notFound')
        case 'PROVIDER_MACHINE_ACTION_UNSUPPORTED':
            return t('admin.runtimeProviders.machine.errors.unsupported')
        case 'PROVIDER_MACHINE_ACTION_REFUSED':
            return t('admin.runtimeProviders.machine.errors.refused', {
                message: said
            })
        case 'PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED':
            return t('admin.runtimeProviders.machine.upgrade.storageRequired', {
                message: said
            })
        case 'PROVIDER_MACHINE_HOST_BUSY':
            return t('admin.runtimeProviders.machine.errors.hostBusy')
        case 'HOST_NOT_EMPTY':
            return t('admin.runtimeProviders.machine.errors.hostNotEmpty')
        case 'RUNTIME_PROVIDER_INVENTORY_UNSUPPORTED':
            return t('admin.runtimeProviders.inventory.unsupported')
        default:
            return said
    }
}

const ACTION_LABELS: Record<string, string> = {
    'runtime_provider.machine.restarted':
        'admin.runtimeProviders.machine.history.restarted',
    'runtime_provider.machine.upgrade.started':
        'admin.runtimeProviders.machine.history.upgradeStarted',
    'runtime_provider.machine.upgrade.succeeded':
        'admin.runtimeProviders.machine.history.upgradeSucceeded',
    'runtime_provider.machine.upgrade.skipped':
        'admin.runtimeProviders.machine.history.upgradeSkipped',
    'runtime_provider.machine.upgrade.failed':
        'admin.runtimeProviders.machine.history.upgradeFailed',
    'runtime_provider.machine.deleted':
        'admin.runtimeProviders.machine.history.deleted'
}

export const machineActionLabel = (action: string): string =>
    ACTION_LABELS[action] ? t(ACTION_LABELS[action]) : action

// What an audit row adds to its action: the versions an upgrade went between,
// or the reason one failed or was skipped.
export const machineActionDetail = (meta: Record<string, unknown>): string => {
    const text = (key: string): string | null =>
        typeof meta[key] === 'string' && meta[key] !== ''
            ? (meta[key] as string)
            : null
    const from = text('fromVersion')
    const to = text('targetVersion') ?? text('requestedVersion')
    const parts: string[] = []
    if (from && to && from !== to) parts.push(`${from} → ${to}`)
    else if (from) parts.push(from)
    if (meta.allowStorageMigration === true)
        parts.push(t('admin.runtimeProviders.machine.history.storageMigration'))
    if (meta.via === 'host_lifecycle')
        parts.push(t('admin.runtimeProviders.machine.history.withSandbox'))
    const reason = text('reason')
    if (reason) parts.push(reason)
    return parts.join(' · ')
}

// A provider's progress step (`starting_machine`) as words.
export const stepLabel = (step: string): string => step.replace(/_/g, ' ')
