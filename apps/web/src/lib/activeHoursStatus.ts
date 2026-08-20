export type ActiveHoursStatus = 'unlimited' | 'ok' | 'low' | 'exhausted'

export interface ActiveHoursInfo {
    status: ActiveHoursStatus
    usedHours: number
    limitHours: number | null
    remainingHours: number | null
}

const LOW_RATIO = 0.2
const LOW_ABSOLUTE_HOURS = 1

// Thresholds mirror the enforcement service's own quota check (active-hours
// -enforcement.service.ts): remaining <= 0 means sandboxes are force-slept
// and blocked from new activity, so 'exhausted' must match that boundary.
export const activeHoursStatus = (
    usedHours: number | null,
    limitHours: number | null
): ActiveHoursInfo => {
    const used = usedHours ?? 0
    if (limitHours == null)
        return {
            status: 'unlimited',
            usedHours: used,
            limitHours: null,
            remainingHours: null
        }

    const remaining = Math.max(0, limitHours - used)
    if (remaining <= 0)
        return {
            status: 'exhausted',
            usedHours: used,
            limitHours,
            remainingHours: 0
        }

    const ratio = limitHours > 0 ? remaining / limitHours : 0
    const status =
        remaining <= LOW_ABSOLUTE_HOURS || ratio <= LOW_RATIO ? 'low' : 'ok'
    return { status, usedHours: used, limitHours, remainingHours: remaining }
}

export type Severity = 0 | 1 | 2

export const activeHoursSeverity = (status: ActiveHoursStatus): Severity =>
    status === 'exhausted' ? 2 : status === 'low' ? 1 : 0
