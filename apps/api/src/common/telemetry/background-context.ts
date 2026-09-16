import { context, ROOT_CONTEXT } from '@opentelemetry/api'
import {
    getCurrentScope,
    getIsolationScope,
    startNewTrace,
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
export const inRequestContinuation = <Result>(
    callback: () => Result
): Result => {
    const isolation = getIsolationScope().clone()
    const scope = getCurrentScope().clone()
    return context.with(ROOT_CONTEXT, () =>
        withIsolationScope(isolation, () =>
            withScope(scope, () => startNewTrace(callback))
        )
    )
}
