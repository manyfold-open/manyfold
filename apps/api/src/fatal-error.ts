import { inspect } from 'node:util'
import { redactCredentialText } from './common/telemetry/redact-credentials'

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
                errorClass: redactCredentialText(error.name || 'Error'),
                errorMessage: truncated(
                    redactCredentialText(String(error.message)),
                    ERROR_MESSAGE_MAX_CHARS
                ),
                ...(typeof error.stack === 'string'
                    ? {
                          stack: truncated(
                              redactCredentialText(error.stack),
                              STACK_MAX_CHARS
                          )
                      }
                    : {})
            }
        return {
            errorClass: `NonError(${typeof error})`,
            errorMessage: truncated(
                redactCredentialText(inspect(error, { depth: 2 })),
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

// postgres.js raises every connection-level failure through Errors.connection,
// which sets code and errno to the same string. Such a rejection only means
// the queries on that connection are gone; the pool reconnects on the next
// query, so it must not take the process (and every live turn) down with it.
const RECOVERABLE_DB_CONNECTION_CODES = new Set([
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT'
])

export const recoverableDbConnectionCode = (reason: unknown): string | null => {
    if (!(reason instanceof Error)) return null
    const { code, errno } = reason as { code?: unknown; errno?: unknown }
    return typeof code === 'string' &&
        code === errno &&
        RECOVERABLE_DB_CONNECTION_CODES.has(code)
        ? code
        : null
}
