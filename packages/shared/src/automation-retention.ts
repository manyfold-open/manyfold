export interface AutomationRetentionSettings {
    retentionDays: number
}

export interface UpdateAutomationRetentionSettingsBody {
    retentionDays: number
}

// How long a deleted automation and its run history stay queryable in
// PostgreSQL before the background purge hard-deletes them (#588). The
// current value applies on the next sweep, including to rows tombstoned
// under a previous value.
export const DEFAULT_AUTOMATION_RETENTION_DAYS = 90
export const MAX_AUTOMATION_RETENTION_DAYS = 3650

export const DEFAULT_AUTOMATION_RETENTION: AutomationRetentionSettings = {
    retentionDays: DEFAULT_AUTOMATION_RETENTION_DAYS
}
