import type { AgentCreateEvent } from '@manyfold/shared'
import { HttpException } from '@nestjs/common'
import { describeHttpException } from '@/common/filters/http-exception.filter'

// What a client is told about a failure: its class, a message with secrets
// redacted, and the code, status and details of the HTTP error it would have
// been. Imports no service: the framework adapters use it, and the
// orchestrator loads them through its own imports, so anything here that
// reached the orchestrator would close a require cycle and leave Nest a
// constructor parameter undefined at boot.

export const classifyError = (err: unknown): string => {
    const resp = (err as { response?: unknown })?.response
    if (resp && typeof resp === 'object' && 'errorClass' in resp)
        return String((resp as { errorClass: unknown }).errorClass)
    const name = (err as { name?: string })?.name
    const code = (err as { code?: string })?.code
    if (code) return String(code)
    if (name) return String(name)
    return 'unknown'
}

export const sanitizeMessage = (err: unknown): string => {
    const raw = (err as Error)?.message ?? 'unknown error'
    const resp = (err as { response?: unknown })?.response
    const msg =
        resp && typeof resp === 'object' && 'message' in resp
            ? String((resp as { message: unknown }).message)
            : raw
    return msg
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
}

type ErrorEvent = Extract<AgentCreateEvent, { type: 'error' }>

// The code, status and details the same failure would carry as a plain HTTP
// response, so a client can act on RUNTIME_LIMIT_REACHED and the like
// instead of parsing the message.
export const errorEventFields = (
    err: unknown
): Pick<ErrorEvent, 'code' | 'status' | 'details'> => {
    if (!(err instanceof HttpException))
        return { code: 'internal_error', status: 500 }
    const { code, status, details } = describeHttpException(err)
    return details === undefined ? { code, status } : { code, status, details }
}
