declare const __MF_CLI_VERSION__: string
declare const __MF_CLI_COMMIT__: string
declare const __MF_CLI_BUILD_TIME__: string

export const MF_CLI_VERSION: string =
    typeof __MF_CLI_VERSION__ !== 'undefined' ? __MF_CLI_VERSION__ : '0.0.0-dev'

// Empty in a source build: only the release workflows know the commit they
// built from. Consumers treat '' as "unknown", never as a real identity.
export const MF_CLI_COMMIT: string =
    typeof __MF_CLI_COMMIT__ !== 'undefined' ? __MF_CLI_COMMIT__ : ''

export const MF_CLI_BUILD_TIME: string =
    typeof __MF_CLI_BUILD_TIME__ !== 'undefined' ? __MF_CLI_BUILD_TIME__ : ''
