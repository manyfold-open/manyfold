import type { ChatFailureCause } from '@/common/telemetry/chat-failure-taxonomy'
import { MANAGED_CHANNEL_UNAVAILABLE_CODE } from '@/common/ports/managed-models.ports'
import {
    isDaemonNotDispatchedError,
    isDaemonOfflineTransportError
} from '@/modules/chat/chat-adapter'
import { SANDBOX_EXEC_UNAVAILABLE_CODE } from '@/modules/chat/sprite-exec-terminal'
import { UPSTREAM_RATE_LIMIT_SIGNATURE } from '@/modules/chat/upstream-rate-limit-signal'

// Durable codes first. The adapters own them, they are already a closed set,
// and they survive every vendor rewording. A code that names one cause wins;
// a specific code with no safe mapping stays unclassified. Only the broad
// legacy codes below carry the actual failure in a message.
const CAUSE_BY_CODE: Readonly<Record<string, ChatFailureCause>> = {
    // The breaker refused the turn because the managed pool is already known
    // empty (#660). Same cause as the upstream literal it was opened by, so a
    // fleet-wide exhaustion reads as one incident in Sentry rather than two —
    // the fast-fail turns are counted, not renamed.
    [MANAGED_CHANNEL_UNAVAILABLE_CODE]: 'account_pool_empty',
    // Same principle for the sandbox exec breaker (#730): the cause is the one
    // the `handshake failed: HTTP 5xx` literal below already maps to, so the
    // turns this spares are counted with the one that proved the endpoint dead
    // instead of opening a second incident beside it.
    [SANDBOX_EXEC_UNAVAILABLE_CODE]: 'exec_handshake_failed',
    turn_idle_timeout: 'inactivity_timeout',
    openclaw_no_response: 'inactivity_timeout',
    openclaw_stream_stall: 'inactivity_timeout',
    turn_max_duration: 'turn_duration_exceeded',
    openclaw_turn_timeout: 'turn_duration_exceeded',
    claude_resume_unsupported: 'unsupported_capability',
    codex_resume_unsupported: 'unsupported_capability',
    gemini_resume_unsupported: 'unsupported_capability',
    hermes_resume_unsupported: 'unsupported_capability',
    // A daemon whose mf CLI predates turn.hermes: the fix is an upgrade on
    // the daemon host, not a retry here.
    hermes_daemon_upgrade_required: 'unsupported_capability',
    openclaw_resume_unsupported: 'unsupported_capability',
    resume_unsupported: 'unsupported_capability',
    dify_session_not_found: 'stale_resume_ref',
    dify_no_body: 'empty_response',
    langflow_no_body: 'empty_response',
    dify_http_400: 'invalid_request',
    langflow_http_400: 'invalid_request',
    dify_http_401: 'auth_invalid',
    langflow_http_401: 'auth_invalid',
    // The provider rejected what WE sent: an empty user message is a bad
    // request, not a model that answered with nothing.
    empty_message: 'invalid_request'
}

const MESSAGE_FALLBACK_CODES: ReadonlySet<string> = new Set([
    'adapter_error',
    'dify_upstream_failed',
    'gemini_error',
    'hermes_daemon_acp_failed',
    'hermes_acp_failed',
    // The fatal stderr line on the interactive path carries the upstream
    // auth/pool/balance text that used to arrive as `hermes_upstream`.
    'hermes_acp_event',
    'langflow_error'
])

const isBroadMessageCode = (code: string): boolean =>
    MESSAGE_FALLBACK_CODES.has(code) ||
    /_(?:exec_failed|result_error|upstream)$/.test(code)

// Matched against a lowercased message, so one failure groups identically
// however a vendor capitalises it, and anchored on phrases rather than words
// because a false positive here files an incident under someone else's name.
// The order is load-bearing wherever a real message carries two signals; each
// such pair is called out below.
const CAUSE_BY_MESSAGE: readonly (readonly [RegExp, ChatFailureCause])[] = [
    // #660: the gateway answers `503 No available Gemini accounts: no
    // available accounts` before it has picked an upstream account at all.
    // That is an empty managed pool — refill it — not a key or a balance
    // problem on any one account, so it is decided before both.
    [/no available[a-z ]{0,24}accounts?\b/, 'account_pool_empty'],
    // #313 shipped one incident in two spellings on the same day:
    // `Failed to authenticate. API Error: 403 Insufficient account balance`
    // through claude, and `{"code":"INSUFFICIENT_BALANCE"}` through codex.
    // Balance is matched BEFORE auth precisely because the first also says
    // "authenticate", and paging an on-call about credentials when the account
    // is simply out of money is the failure this taxonomy exists to stop.
    [
        /insufficient[ _-]?(?:account[ _-]?)?(?:balance|credit|funds)/,
        'balance_exhausted'
    ],
    // Not "quota exceeded": a rate limit is a different incident with a
    // different fix, and folding it in here would page the wrong person. Since
    // #803 it has its own cause, immediately below.
    [/balance is too low|out of credits?\b/, 'balance_exhausted'],
    // #803: the structured HTTP 429 / RESOURCE_EXHAUSTED envelope. Ranked above
    // the auth and request anchors, which match sentences: a throttled turn's
    // terminal carries the tail of a whole retry ladder, so prose from one
    // attempt must not outrank the status the request was actually refused
    // with. Ranked below the pool and balance anchors for the reasons they give.
    [UPSTREAM_RATE_LIMIT_SIGNATURE, 'rate_limited'],
    [
        /invalid[ _-]?api[ _-]?key|incorrect api key|invalid_api_key/,
        'auth_invalid'
    ],
    [
        /api key[^\n]{0,32}(?:invalid|expired|revoked|missing)|invalid[ _-]?(?:credentials?|token)/,
        'auth_invalid'
    ],
    [
        /failed to authenticate|authentication (?:failed|error)|\bunauthorized\b/,
        'auth_invalid'
    ],
    // packages/sprites preserves the real HTTP status in this exact literal.
    // The Sprites client itself types 401/403 as auth; a 400 rejected our
    // upgrade request; only 5xx is the transient handshake incident.
    [/execspritestream handshake failed: http (?:401|403)\b/, 'auth_invalid'],
    [/execspritestream handshake failed: http 400\b/, 'invalid_request'],
    [
        /execspritestream handshake failed: http 5\d\d\b/,
        'exec_handshake_failed'
    ],
    // The resume ref outlived the runtime's copy of the session. Both the raw
    // runtime lines and the hint the adapters rewrite them into are anchored,
    // because which one survives to telemetry depends on the adapter.
    [
        /could not be resolved by the runtime|error resuming session/,
        'stale_resume_ref'
    ],
    [
        /invalid session identifier|no previous sessions found for this project/,
        'stale_resume_ref'
    ],
    [
        /no rollout found for thread|failed to read thread|thread\/resume failed/,
        'stale_resume_ref'
    ],
    [
        /\bnot[ _-]?implemented\b|does not support|is not supported\b/,
        'unsupported_capability'
    ],
    [
        /produced no adapter events for|produced no output for \d|went silent for/,
        'inactivity_timeout'
    ],
    [
        /still streaming (?:after|when)|max duration budget/,
        'turn_duration_exceeded'
    ],
    // Dify/Langflow no-body errors are mapped by code above. This covers other
    // broad adapters whose upstream returns 200 and nothing to say, while
    // deliberately excluding "empty message" (our request-side rejection).
    [
        /empty (?:response|completion|content)|response (?:was|is) empty|returned an empty|contained no content/,
        'empty_response'
    ],
    // Last: "invalid" and "bad" are common enough that anything more specific
    // above deserves to win first.
    [
        /\binvalid[ _-]?request\b|\bbad request\b|invalid_request_error|\binvalid[ _-]?argument\b|malformed (?:request|json|body|payload)/,
        'invalid_request'
    ]
]

// The closed cause behind a Chat terminal, or null when nothing in the
// evidence identifies it. Null is a real answer: it keeps the event on
// Sentry's default grouping instead of pouring every unrecognised failure into
// one bucket, which is the bug being fixed.
//
// Takes only the durable code and the message; returns only a member of the
// taxonomy. The message is read here and never travels any further — no caller
// tags, persists or fingerprints the raw detail.
export const classifyChatFailureCause = (signal: {
    errorCode?: string | null
    message?: string | null
}): ChatFailureCause | null => {
    const coded = signal.errorCode ? CAUSE_BY_CODE[signal.errorCode] : undefined
    if (coded) return coded

    if (signal.errorCode && !isBroadMessageCode(signal.errorCode)) return null

    const message = (signal.message ?? '').toLowerCase()
    if (!message) return null
    for (const [anchor, cause] of CAUSE_BY_MESSAGE)
        if (anchor.test(message)) return cause
    // chat-adapter already owns what "the daemon transport is gone" means, and
    // it is the half of that decision that terminalizes rather than suspends.
    // Two lists of the same literals would drift, so this asks it.
    if (
        isDaemonOfflineTransportError(message) ||
        isDaemonNotDispatchedError(message)
    )
        return 'daemon_offline'
    return null
}
