import type { RuntimeAccessSummary } from '@manyfold/shared'

interface ResourceUsageRow {
    labelKey: string
    used: number | null
    limit: number | null
    unit: 'count' | 'hours' | 'bytes'
}

export const resourceUsageRows = (
    access: RuntimeAccessSummary
): ResourceUsageRow[] => [
    {
        labelKey: 'web.planAndBilling.quotaAgents',
        used: access.statefulSandboxUsage,
        limit: access.statefulSandboxLimit,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaConcurrent',
        used: access.activeSandboxUsage,
        limit: access.plan.maxConcurrentActive,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaStorage',
        used: access.storageBytesTotal,
        limit: access.plan.maxStorageGb * 1_000_000_000,
        unit: 'bytes'
    },
    {
        labelKey: 'web.planAndBilling.quotaActiveHours',
        used: access.activeHoursThisPeriod,
        limit: access.activeHoursLimit,
        unit: 'hours'
    },
    {
        labelKey: 'web.planAndBilling.quotaAlwaysOnlineRuntimes',
        used: access.alwaysOnlineRuntimesUsed,
        limit: access.alwaysOnlineRuntimeLimit,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaAlwaysOnlineAgents',
        used: access.alwaysOnlineAgentsUsed,
        limit: access.alwaysOnlineAgentsLimit,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaChannels',
        used: access.channelsUsed,
        limit: access.plan.maxChannels,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaAutomations',
        used: access.automationsUsed,
        limit: access.plan.maxAutomations,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaAutomationRuns',
        used: access.automationRunsThisPeriod,
        limit: access.plan.maxAutomationRunsMonthly,
        unit: 'count'
    },
    {
        labelKey: 'web.planAndBilling.quotaApiRequests',
        used: access.apiRequestsThisPeriod,
        limit: access.plan.monthlyApiRequestLimit,
        unit: 'count'
    }
]
