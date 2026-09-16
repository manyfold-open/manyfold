import { rename } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

interface RenameRuntime {
    platform: NodeJS.Platform
    renameFile: typeof rename
    now: () => number
    wait: (ms: number) => Promise<unknown>
}

const WINDOWS_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRY_BUDGET_MS = 1_000
const MAX_ATTEMPTS = 12

// Windows can deny replacement while another handle is open. Retry the same
// atomic rename, never unlink the target; persistent permission errors still
// fail closed. The deadline bounds retry scheduling, not an in-flight OS call.
export const renameWithWindowsRetry = async (
    source: string,
    destination: string,
    runtime: Partial<RenameRuntime> = {}
): Promise<void> => {
    const platform = runtime.platform ?? process.platform
    const renameFile = runtime.renameFile ?? rename
    const now = runtime.now ?? (() => performance.now())
    const wait = runtime.wait ?? sleep
    const deadline = now() + RETRY_BUDGET_MS
    for (let attempt = 1; ; attempt += 1) {
        try {
            await renameFile(source, destination)
            return
        } catch (error) {
            if (
                platform !== 'win32' ||
                !WINDOWS_RENAME_ERRORS.has(
                    (error as NodeJS.ErrnoException)?.code ?? ''
                ) ||
                attempt >= MAX_ATTEMPTS
            )
                throw error
            const remaining = deadline - now()
            if (remaining <= 0) throw error
            await wait(Math.min(10 * 2 ** (attempt - 1), 100, remaining))
            if (now() >= deadline) throw error
        }
    }
}
