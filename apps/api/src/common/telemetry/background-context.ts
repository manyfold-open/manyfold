import {
    context,
    ROOT_CONTEXT,
    SpanStatusCode,
    trace,
    type Attributes
} from '@opentelemetry/api'
import {
    getCurrentScope,
    getIsolationScope,
    withIsolationScope,
    withScope
} from '@sentry/node'

// Fork both scopes on every invocation: clearing a shared root or retaining
// the caller's current scope would leak data between tasks and requests.
export const inBackgroundContext =
    <Args extends unknown[], Result>(
        callback: (...args: Args) => Result
    ): ((...args: Args) => Result) =>
    (...args) =>
        context.with(ROOT_CONTEXT, () =>
            withIsolationScope((isolation) => {
                isolation.clear()
                return withScope((scope) => {
                    scope.clear()
                    return callback(...args)
                })
            })
        )

// A chat continuation owns the initiating request's identity, but neither
// its mutable scopes nor the HTTP span that ends when the response is sent.
export const inRequestContinuation = <Result extends Promise<unknown>>(
    callback: () => Result,
    attributes: Attributes = {}
): Result => {
    const isolation = getIsolationScope().clone()
    const scope = getCurrentScope().clone()
    let result!: Result
    context.with(ROOT_CONTEXT, () =>
        withIsolationScope(isolation, () =>
            withScope(scope, () => {
                // NodeSDK owns sampling. Sentry.startNewTrace installs an
                // unsampled remote parent, which its default sampler drops.
                const span = trace
                    .getTracer('manyfold.chat')
                    .startSpan(
                        scope.getScopeData().transactionName || 'chat.turn',
                        { root: true, attributes },
                        trace.deleteSpan(context.active())
                    )
                const finish = (failed = false): void => {
                    try {
                        if (failed)
                            span.setStatus({ code: SpanStatusCode.ERROR })
                        span.end()
                    } catch {
                        // Exporter failures must not change the task result.
                    }
                }
                context.with(trace.setSpan(context.active(), span), () => {
                    try {
                        result = callback()
                        void result.then(
                            () => finish(),
                            () => finish(true)
                        )
                    } catch (error) {
                        finish(true)
                        throw error
                    }
                })
            })
        )
    )
    // Keep the adapter's own promise: Sentry's fallback scope stack wraps
    // returned promises and would postpone the caller's terminal cleanup.
    return result
}
