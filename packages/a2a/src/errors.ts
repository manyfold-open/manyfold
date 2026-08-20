import type { JsonRpcErrorBody } from './types'

export const A2aErrorCode = {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    taskNotFound: -32001,
    taskNotCancelable: -32002,
    pushNotificationNotSupported: -32003,
    unsupportedOperation: -32004,
    contentTypeNotSupported: -32005,
    invalidAgentResponse: -32006,
    authenticatedExtendedCardNotConfigured: -32007
} as const

const CODE_MESSAGES: Record<number, string> = {
    [-32700]: 'Invalid JSON payload',
    [-32600]: 'Invalid JSON-RPC Request',
    [-32601]: 'Method not found',
    [-32602]: 'Invalid method parameters',
    [-32603]: 'Internal error',
    [-32001]: 'Task not found',
    [-32002]: 'Task cannot be canceled',
    [-32003]: 'Push Notification is not supported',
    [-32004]: 'This operation is not supported',
    [-32005]: 'Incompatible content types',
    [-32006]: 'Invalid agent response',
    [-32007]: 'Authenticated Extended Card not configured'
}

export const defaultMessageForCode = (code: number): string =>
    CODE_MESSAGES[code] ?? `A2A error ${code}`

export class A2aError extends Error {
    readonly code: number
    readonly data: unknown

    constructor(code: number, message?: string, data?: unknown) {
        super(message ?? defaultMessageForCode(code))
        this.name = 'A2aError'
        this.code = code
        this.data = data
    }

    static fromJsonRpc(error: JsonRpcErrorBody): A2aError {
        return new A2aError(error.code, error.message, error.data)
    }

    toJsonRpc(): JsonRpcErrorBody {
        const body: JsonRpcErrorBody = {
            code: this.code,
            message: this.message
        }
        if (this.data !== undefined) body.data = this.data
        return body
    }
}
