const FLUSH_STAGE_TIMEOUT_MS = 800

// The exit flush runs stages in delivery-importance order, so a stage that
// stalls on a dead endpoint must only be able to eat its own cap, never the
// budget of the stages queued behind it (#528). The cap bounds async waits
// only — a synchronous stall holds the event loop and cannot be preempted.
export const runFlushStage = async (
    run: () => Promise<void>,
    timeoutMs: number = FLUSH_STAGE_TIMEOUT_MS
): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    try {
        await Promise.race([
            run(),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs)
            })
        ])
    } catch {
    } finally {
        clearTimeout(timer)
    }
}