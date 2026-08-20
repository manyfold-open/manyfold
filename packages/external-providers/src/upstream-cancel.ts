// Dify and A2A both learn the id that names the upstream task from the response
// stream itself. Binding that read to the caller's abort signal made one signal
// kill both (#402): the abort tore the response body down, the abort handler
// found `taskId === null` and returned, and the already-accepted upstream task
// kept generating — and billing — with nothing left that could name it.
//
// The id harvest therefore gets its OWN bounded lifetime. On a caller abort the
// consumer's iteration ends immediately, so the local turn still terminalizes
// as cancelled_by_user without waiting; the upstream read continues detached
// until either the id arrives (upstream cancel is sent) or the window elapses,
// which is recorded as an explicit skip instead of being silently dropped.
const DEFAULT_HARVEST_MS = 5_000

// Read per invoke, not at module load: tests set the override after the ESM
// import graph is already evaluated.
const harvestWindowMs = (): number => {
    const raw = Number(
        process.env.MF_UPSTREAM_CANCEL_HARVEST_MS ?? DEFAULT_HARVEST_MS
    )
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HARVEST_MS
}

const ABORTED = Symbol('upstream-cancel-caller-aborted')

export interface UpstreamCancelOptions<T> {
    source: AsyncIterable<T>
    // Decides only when the CONSUMER stops seeing events. Never handed to the
    // upstream request or its body — that is exactly what lost the id.
    callerSignal: AbortSignal
    // Owns the request/body lifetime instead, so the harvest can outlive the
    // caller's abort by at most one window.
    upstream: AbortController
    // Whether an upstream task can already exist when this helper is built.
    // Dify wraps a response body that is already accepted, so it does. A2A's
    // stream is a lazy generator that only sends message/stream on the first
    // read, so it does not — and an abort before that read must not start one.
    upstreamStarted: boolean
    taskIdOf: (item: T) => string | null
    cancelUpstream: (taskId: string) => void
    skipped: (reason: string, windowMs: number) => void
}

export const withUpstreamCancel = <T>(
    opts: UpstreamCancelOptions<T>
): AsyncIterable<T> => {
    const iterator = opts.source[Symbol.asyncIterator]()
    let taskId: string | null = null
    let resolved = false
    let detached = false
    let upstreamLive = opts.upstreamStarted
    // Held in the closure, not inside the pump, because the abort listener has
    // to hand the very same in-flight read to the harvest: dropping it would
    // strand an unhandled rejection when the window later aborts the body.
    let pending: Promise<IteratorResult<T>> | null = null

    const sendCancel = (): void => {
        if (resolved || taskId === null) return
        resolved = true
        opts.cancelUpstream(taskId)
        opts.upstream.abort()
    }
    const skip = (reason: string, windowMs: number): void => {
        if (resolved) return
        resolved = true
        opts.skipped(reason, windowMs)
        opts.upstream.abort()
    }
    // Never awaited by the consumer: an aborted turn must terminalize now, and
    // the source is being torn down by the upstream abort anyway.
    const closeSource = (): void => {
        void Promise.resolve()
            .then(() => iterator.return?.())
            .catch(() => undefined)
    }
    // The consumer is gone, but the accepted upstream task is not — and only
    // this stream can still name it.
    const harvest = (inFlight: Promise<IteratorResult<T>> | null): void => {
        detached = true
        const windowMs = harvestWindowMs()
        const timer = setTimeout(
            () => skip('harvest_window_elapsed', windowMs),
            windowMs
        )
        if (typeof timer.unref === 'function') timer.unref()
        void (async () => {
            let failure: string | null = null
            try {
                let next = inFlight ?? iterator.next()
                while (!resolved) {
                    const step = await next
                    if (step.done === true) break
                    const id = opts.taskIdOf(step.value)
                    if (id !== null) {
                        taskId = id
                        break
                    }
                    next = iterator.next()
                }
            } catch {
                // The window elapsed and aborted the read, or the connection
                // dropped. Either way the skip below is the honest record.
                failure = 'upstream_read_failed'
            }
            clearTimeout(timer)
            if (taskId !== null) sendCancel()
            else skip(failure ?? 'stream_ended_without_task_id', windowMs)
            closeSource()
        })()
    }
    // Idempotent, and the single funnel for every abort outcome: it runs from
    // the listener rather than from the pump because the pump can be suspended
    // at a `yield` while the consumer awaits a session write or a checkpoint,
    // and may never ask for another event.
    const onCallerAbort = (): void => {
        if (resolved || detached) return
        if (taskId !== null) {
            sendCancel()
            return
        }
        if (!upstreamLive) {
            // Nothing was ever sent upstream: no task to name, cancel or record
            // as skipped — only a read that must never start one.
            resolved = true
            opts.upstream.abort()
            return
        }
        harvest(pending)
    }

    // One fresh promise per read rather than racing a single shared abort
    // promise: racing the same promise on every event would pile one reaction
    // record per event onto a signal that usually never fires.
    let wake: (() => void) | null = null
    const onAbort = (): void => {
        // Settle the in-flight read as ABORTED before cancelling: the cancel
        // tears the body down, and a read that rejects afterwards would surface
        // as a stream error instead of a clean end.
        wake?.()
        onCallerAbort()
    }
    opts.callerSignal.addEventListener('abort', onAbort, { once: true })
    const nextOrAbort = (
        inFlight: Promise<IteratorResult<T>>
    ): Promise<IteratorResult<T> | typeof ABORTED> =>
        new Promise((resolve, reject) => {
            wake = (): void => resolve(ABORTED)
            inFlight.then(resolve, reject)
        })

    const pump = async function* (): AsyncGenerator<T> {
        try {
            for (;;) {
                // An abort that landed before the listener was registered never
                // replays, so the already-aborted state is read here too.
                if (opts.callerSignal.aborted) {
                    onCallerAbort()
                    pending = null
                    return
                }
                upstreamLive = true
                pending = iterator.next()
                const step = await nextOrAbort(pending)
                if (step === ABORTED) {
                    onCallerAbort()
                    pending = null
                    return
                }
                pending = null
                if (step.done === true) return
                if (taskId === null) taskId = opts.taskIdOf(step.value)
                yield step.value
            }
        } finally {
            opts.callerSignal.removeEventListener('abort', onAbort)
            wake = null
            if (!detached) closeSource()
        }
    }
    return pump()
}
