import { dirname } from 'node:path'
import { runShellProbe } from './shell-probe'

export const augmentPathFromUserShell = async (
    log: (message: string) => Promise<void>,
    signal: AbortSignal
): Promise<void> => {
    const current = (process.env.PATH ?? '').split(':').filter(Boolean)
    // Keep the running runtime reachable even when the login shell fails.
    const additions = [dirname(process.execPath)]
    const shell = process.env.SHELL?.trim()
    if (shell) {
        const result = await runShellProbe(shell, 'printf %s "$PATH"', signal)
        if (result.status === 'ok')
            additions.unshift(
                ...result.output.trim().split(':').filter(Boolean)
            )
        else await log(`PATH probe ${result.status}; retaining current PATH`)
    }
    const merged = [...new Set([...additions, ...current])]
    process.env.PATH = merged.join(':')
    await log(
        `PATH augmented: before=${current.length} entries, after=${merged.length} entries`
    )
}
