const HOME_MARKER = /^(?:MF_HOME|NCA_HOME)=(.+)$/m

export const extractHomeDir = (stdout: string): string | undefined => {
    const match = stdout.match(HOME_MARKER)
    if (!match) return undefined
    const value = match[1].trim()
    return value && value.startsWith('/') ? value : undefined
}
