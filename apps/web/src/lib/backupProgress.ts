const DEFAULT_INTERVAL_MS = 2_500
const DEFAULT_TIMEOUT_MS = 10 * 60_000

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms)
    })

export interface WaitForSettledOptions {
    intervalMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}

// Backups and restores are created `running` and settle later, so anything that
// must not proceed until one is finished waits here. What it returns is the last
// state seen, not a verdict: still `running` means the deadline passed and
// `undefined` means the row is gone (a deleted backup). Both have to read as
// "did not succeed" at the call site — treating either as done is how a restore
// ends up racing the snapshot that was supposed to make it undoable.
export const waitForSettled = async <T extends { status: string }>(
    initial: T,
    read: () => Promise<T | undefined>,
    options: WaitForSettledOptions = {}
): Promise<T | undefined> => {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    const deadline = now() + timeoutMs
    let latest: T | undefined = initial
    while (latest?.status === 'running' && now() < deadline) {
        await sleep(intervalMs)
        latest = await read()
    }
    return latest
}
