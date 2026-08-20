export interface StandaloneRuntimeProbe {
    hasBun?: boolean
    execPath?: string
}

export const isBunStandalone = (
    probe: StandaloneRuntimeProbe = {}
): boolean => {
    const hasBun =
        probe.hasBun ??
        typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
    if (!hasBun) return false
    const execPath = probe.execPath ?? process.execPath
    const executable = execPath.split(/[\\/]/).pop() ?? ''
    return !/^bun(?:\.exe)?$/i.test(executable)
}
