export const chatFailureCauses = [
    'balance_exhausted',
    'account_pool_empty',
    'rate_limited',
    'auth_invalid',
    'invalid_request',
    'stale_resume_ref',
    'resume_contention',
    'daemon_offline',
    'exec_handshake_failed',
    'empty_response',
    'inactivity_timeout',
    'turn_duration_exceeded',
    'unsupported_capability'
] as const

export type ChatFailureCause = (typeof chatFailureCauses)[number]

const causes: ReadonlySet<string> = new Set(chatFailureCauses)

export const isChatFailureCause = (value: unknown): value is ChatFailureCause =>
    typeof value === 'string' && causes.has(value)
