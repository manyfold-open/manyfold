export type SpritesErrorCode =
    | 'auth'
    | 'quota'
    | 'not_found'
    | 'conflict'
    | 'transient'
    | 'permanent'

// Structured, machine-branchable failure detail that survives the generic
// 'transient' classification. `exec_session_gone` marks the one transient case
// callers can act on differently: the exec session was reaped after its process
// exited mid-detach, so no attach/retry can recover it — a caller may instead
// recover the result from the framework's on-disk session log.
export type SpritesFailureReason = 'exec_session_gone'
export type SpritesExecFailurePhase = 'pre_open' | 'post_open'

export class SpritesError extends Error {
    readonly code: SpritesErrorCode
    readonly status?: number
    readonly body?: unknown
    readonly reason?: SpritesFailureReason
    readonly execSessionId?: string
    readonly execPhase?: SpritesExecFailurePhase
    // How long sprites.dev asked the caller to wait, when it said.
    readonly retryAfterMs?: number

    constructor(
        code: SpritesErrorCode,
        message: string,
        status?: number,
        body?: unknown,
        extra?: {
            reason?: SpritesFailureReason
            execSessionId?: string
            execPhase?: SpritesExecFailurePhase
            retryAfterMs?: number
        }
    ) {
        super(message)
        this.name = 'SpritesError'
        this.code = code
        this.status = status
        this.body = body
        this.reason = extra?.reason
        this.execSessionId = extra?.execSessionId
        this.execPhase = extra?.execPhase
        this.retryAfterMs = extra?.retryAfterMs
    }

    get retryable(): boolean {
        return this.code === 'transient'
    }
}

export const classifyHttpStatus = (status: number): SpritesErrorCode => {
    if (status === 401 || status === 403) return 'auth'
    if (status === 404) return 'not_found'
    if (status === 409) return 'conflict'
    if (status === 402 || status === 429) return 'quota'
    if (status >= 500) return 'transient'
    return 'permanent'
}

// `Retry-After` in seconds or as an HTTP date; undefined when absent or
// unreadable.
export const retryAfterMs = (
    value: string | null | undefined,
    now = Date.now()
): number | undefined => {
    const after = value?.trim()
    if (!after) return undefined
    if (/^\d+$/.test(after)) return Number(after) * 1000
    const date = Date.parse(after)
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}
