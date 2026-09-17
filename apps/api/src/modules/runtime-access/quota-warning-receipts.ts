import type { RuntimeAccessSummary } from '@manyfold/shared'

export const QUOTA_WARNING_DEDUPE_MS = 24 * 60 * 60 * 1000
export const QUOTA_WARNING_CODES = [
    'storage',
    'provisioned',
    'active_hours',
    'channels',
    'automations',
    'automation_runs',
    'api_requests'
] as const
export type UserQuotaWarningCode = (typeof QUOTA_WARNING_CODES)[number]

export type QuotaWarningSnapshot = Pick<
    RuntimeAccessSummary,
    | 'plan'
    | 'usagePeriod'
    | 'storageBytesTotal'
    | 'statefulSandboxUsage'
    | 'statefulSandboxLimit'
    | 'activeHoursThisPeriod'
    | 'activeHoursLimit'
    | 'channelsUsed'
    | 'automationsUsed'
    | 'automationRunsThisPeriod'
    | 'apiRequestsThisPeriod'
>

export interface QuotaWarningCandidate {
    code: UserQuotaWarningCode
    usage: number
    limit: number
}

export const quotaWarningCandidates = (
    summary: QuotaWarningSnapshot
): QuotaWarningCandidate[] => {
    const out: QuotaWarningCandidate[] = []
    const meter = (
        code: UserQuotaWarningCode,
        usage: number,
        limit: number | null,
        threshold: number,
        oneSlotLeft = false
    ) => {
        if (limit === null || limit <= 0) return
        if (usage / limit >= threshold || (oneSlotLeft && limit - usage <= 1))
            out.push({ code, usage, limit })
    }
    const plan = summary.plan
    meter(
        'storage',
        summary.storageBytesTotal,
        plan.maxStorageGb * 1_000_000_000,
        0.95
    )
    meter(
        'provisioned',
        summary.statefulSandboxUsage,
        summary.statefulSandboxLimit,
        0.9
    )
    meter(
        'active_hours',
        summary.activeHoursThisPeriod ?? 0,
        summary.activeHoursLimit,
        0.8
    )
    // Count caps retain their one-slot-left warning; provisioned stays ratio-only.
    meter('channels', summary.channelsUsed, plan.maxChannels, 0.9, true)
    meter(
        'automations',
        summary.automationsUsed,
        plan.maxAutomations,
        0.9,
        true
    )
    meter(
        'automation_runs',
        summary.automationRunsThisPeriod,
        plan.maxAutomationRunsMonthly,
        0.8
    )
    meter(
        'api_requests',
        summary.apiRequestsThisPeriod,
        plan.monthlyApiRequestLimit,
        0.8
    )
    return out
}

export const quotaWarningPolicyKey = (
    snapshot: QuotaWarningSnapshot,
    limit: number
): string =>
    JSON.stringify([
        snapshot.plan.id,
        limit,
        snapshot.usagePeriod.start,
        snapshot.usagePeriod.end
    ])

export const quotaWarningWasDelivered = (
    lastAt: string | undefined,
    now: Date
): boolean =>
    Boolean(
        lastAt &&
        !(new Date(lastAt).getTime() < now.getTime() - QUOTA_WARNING_DEDUPE_MS)
    )
