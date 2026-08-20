/**
 * Provider-neutral taxonomy for outbound send failures.
 *
 * Providers wrap platform errors they can positively identify into
 * `ChannelSendError`; everything else stays a plain Error and classifies as
 * 'unknown' (today's behavior: ladder backoff, dead-letter on exhaustion).
 *
 * 'sent-never-succeeds' kinds (forbidden / not_found / bad_format / too_long)
 * are permanent for that exact delivery: retrying burns the retry budget and
 * delays the dead-letter signal, so the bridge dead-letters them immediately.
 * 'rate_limited' carries the platform's own retry-after hint so the sweep can
 * wait exactly as long as asked instead of the generic ladder.
 */
export type ChannelSendErrorKind =
    | 'rate_limited'
    | 'forbidden'
    | 'not_found'
    | 'bad_format'
    | 'too_long'
    | 'transient'
    | 'unknown'

export class ChannelSendError extends Error {
    readonly kind: ChannelSendErrorKind
    readonly retryAfterMs: number | null

    constructor(
        kind: ChannelSendErrorKind,
        message: string,
        opts: { retryAfterMs?: number | null; cause?: unknown } = {}
    ) {
        super(message, opts.cause !== undefined ? { cause: opts.cause } : {})
        this.name = 'ChannelSendError'
        this.kind = kind
        this.retryAfterMs = opts.retryAfterMs ?? null
    }
}

export interface ClassifiedSendError {
    kind: ChannelSendErrorKind
    retryAfterMs: number | null
}

export const classifySendError = (err: unknown): ClassifiedSendError =>
    err instanceof ChannelSendError
        ? { kind: err.kind, retryAfterMs: err.retryAfterMs }
        : { kind: 'unknown', retryAfterMs: null }

export const isPermanentSendErrorKind = (
    kind: ChannelSendErrorKind
): boolean =>
    kind === 'forbidden' ||
    kind === 'not_found' ||
    kind === 'bad_format' ||
    kind === 'too_long'

const RATE_LIMIT_RETRY_MIN_MS = 1_000
const RATE_LIMIT_RETRY_MAX_MS = 15 * 60_000

// Retry delay for a non-permanent failure: the platform's retry-after hint
// (clamped so a hostile/buggy header cannot park a delivery for hours) wins
// over the position-indexed backoff ladder.
export const sendRetryDelayMs = (
    classified: ClassifiedSendError,
    attemptIndex: number,
    backoffLadderMs: readonly number[]
): number => {
    if (classified.kind === 'rate_limited' && classified.retryAfterMs !== null)
        return Math.min(
            Math.max(classified.retryAfterMs, RATE_LIMIT_RETRY_MIN_MS),
            RATE_LIMIT_RETRY_MAX_MS
        )
    return backoffLadderMs[
        Math.max(0, Math.min(attemptIndex, backoffLadderMs.length - 1))
    ]
}
