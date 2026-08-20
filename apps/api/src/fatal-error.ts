import { inspect } from 'node:util'

const ERROR_MESSAGE_MAX_CHARS = 2_048
const STACK_MAX_CHARS = 4_096

export interface FatalErrorDetail {
    errorClass: string
    errorMessage: string
    stack?: string
}

const truncated = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max)} [truncated]` : value

// Must never throw: it runs inside handleFatal after the re-entry guard is
// latched, where a throw (e.g. String() on a null-prototype rejection reason)
// leaves the process alive but blind to every further fatal (#483).
export const describeFatalError = (error: unknown): FatalErrorDetail => {
    try {
        if (error instanceof Error)
            return {
                errorClass: error.name || 'Error',
                errorMessage: truncated(
                    String(error.message),
                    ERROR_MESSAGE_MAX_CHARS
                ),
                ...(typeof error.stack === 'string'
                    ? { stack: truncated(error.stack, STACK_MAX_CHARS) }
                    : {})
            }
        return {
            errorClass: `NonError(${typeof error})`,
            errorMessage: truncated(
                inspect(error, { depth: 2 }),
                ERROR_MESSAGE_MAX_CHARS
            )
        }
    } catch {
        return {
            errorClass: 'UndescribableValue',
            errorMessage: '[value could not be described]'
        }
    }
}
