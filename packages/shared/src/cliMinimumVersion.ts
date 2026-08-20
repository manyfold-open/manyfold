export interface CliMinimumVersionSettings {
    minVersion: string | null
}

export interface UpdateCliMinimumVersionSettingsBody {
    minVersion: string | null
}

export const DEFAULT_CLI_MINIMUM_VERSION: CliMinimumVersionSettings = {
    minVersion: null
}
