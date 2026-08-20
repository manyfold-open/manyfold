declare const __MF_CLI_VERSION__: string

export const MF_CLI_VERSION: string =
    typeof __MF_CLI_VERSION__ !== 'undefined' ? __MF_CLI_VERSION__ : '0.0.0-dev'
