import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGED_CHANNEL_UNAVAILABLE_CODE } from '../src/common/ports/managed-models.ports'
import { chatFailureCauses } from '../src/common/telemetry/chat-failure-taxonomy'
import { classifyChatFailureCause } from '../src/modules/chat/chat-failure-cause'
import { classifyManagedChannelFailureSignal } from '../src/modules/chat/managed-channel-failure-signal'

// #786. Every positive message-fallback fixture below is a shape the adapters,
// the sprites client or a provider actually produce — they are the whole
// reason the classifier cannot just read a code. Adversarial fixtures separately
// prove that a specific durable code cannot be overridden by convenient prose.
//
// The classifier is pure, so this file is where the taxonomy is really proven;
// the service paths that feed it are covered in
// chat-stream-error-telemetry.test.ts and the grouping it feeds is covered in
// sentry-grouping.test.ts.

const cause = (errorCode: string | null, message: string): string | null =>
    classifyChatFailureCause({ errorCode, message })

// The exact sentence the fast-fail terminal persists, copied here so a reword
// of the user-facing text has to face the classification claims below.
const REFUSAL_MESSAGE =
    'Managed Antigravity has no upstream accounts available right now, so this message was not sent. Switch this agent to another model channel to keep working, or try again after the channel recovers.'

test('a balance exhaustion is a balance exhaustion in either vendor spelling', () => {
    // #313, claude-code through the NetMind gateway. Note "authenticate": the
    // one word that made this look like a credentials incident for a day.
    assert.equal(
        cause(
            'claude_result_error',
            'Failed to authenticate. API Error: 403 Insufficient account balance'
        ),
        'balance_exhausted'
    )
    // #313 again, same incident, codex's wording on the same afternoon.
    assert.equal(
        cause(
            'codex_exec_failed',
            'codex exited 1: unexpected status 403 Forbidden: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}, url: https://3avtktubfdf842bfx2fk.netmind.xyz/responses'
        ),
        'balance_exhausted'
    )
})

// The ordering claim above, stated on its own so it fails alone if the anchor
// list is ever reordered: an auth anchor placed first would swallow the
// message and page an on-call about credentials that are perfectly valid.
test('balance beats auth when a message claims both', () => {
    assert.equal(
        cause(
            'claude_result_error',
            'Failed to authenticate. API Error: 403 Insufficient account balance'
        ),
        'balance_exhausted'
    )
    assert.equal(
        cause(
            'hermes_upstream',
            '401 Unauthorized: {"error":"invalid api key"}'
        ),
        'auth_invalid'
    )
})

test('an empty managed account pool is not a balance or a key problem', () => {
    // #660: the gateway has no account to pick at all.
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 1: 503 No available Gemini accounts: no available accounts'
        ),
        'account_pool_empty'
    )
    // And it stays the pool's incident even when the pool says why it is empty.
    assert.equal(
        cause(
            'gemini_exec_failed',
            '503 No available Gemini accounts: no available accounts with sufficient balance'
        ),
        'account_pool_empty'
    )
})

// #803. A throttled generation is its own incident: it clears by waiting, the
// fix is nobody's key and nobody's wallet, and before it had a name every one
// of these landed in the unclassified bucket the fingerprint exists to drain.
test('a structured upstream throttle is its own incident', () => {
    // What gemini-cli prints when the provider refuses the generation, both
    // spellings: the status line the client raises and the envelope it quotes.
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 1: ApiError: got status: 429 Too Many Requests. {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}'
        ),
        'rate_limited'
    )
    // The per-attempt line its own retry ladder logs on the way to the exit.
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 1: attempt 3 failed with status 429, retrying in 8s'
        ),
        'rate_limited'
    )
    // And the RPC status on its own, which is the one spelling no gateway
    // rewrites, whatever it does to the sentence beside it.
    assert.equal(cause('adapter_error', 'RESOURCE_EXHAUSTED'), 'rate_limited')
})

// The cause is a Sentry grouping key, so it may only be derived from what a
// machine printed. Every line below is prose a vendor can reword under us, or a
// number that happens to be 429 — reading either as a throttle would file
// somebody else's failure under this name and page nobody about the real one.
test('vendor prose and stray numbers are not a throttle', () => {
    for (const message of [
        'Resource has been exhausted (e.g. check quota).',
        'quota exceeded for quota metric generate_requests_per_model',
        'you have exceeded your current quota, please check your plan',
        'rate limit exceeded',
        'gemini exited 1: error 1429 while reading manifest',
        'gemini exited 1: value out of range: 4294967295',
        'the turn took 429 seconds'
    ])
        assert.notEqual(cause('gemini_exec_failed', message), 'rate_limited')
})

// The precedence #803 has to hold on both sides. A throttled attempt is what a
// retry ladder is FULL of, so it must not outrank the two causes whose fix is
// an action somebody has to take — and it must outrank the sentence anchors,
// which a message carrying a whole ladder can easily also contain.
test('a throttle loses to an empty pool and a balance, and beats prose', () => {
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 1: attempt 1 failed with status 429\nattempt 2 failed with status 429\n{"error":{"code":503,"message":"No available Gemini accounts: no available accounts"}}'
        ),
        'account_pool_empty'
    )
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 1: got status: 429. Insufficient account balance'
        ),
        'balance_exhausted'
    )
    // "Please ensure your API key is valid" is boilerplate gemini appends to
    // half its failures; the status is what the request was actually refused
    // with.
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 1: got status: 429 Too Many Requests. Check that your API key is valid and the request is not malformed.'
        ),
        'rate_limited'
    )
})

test('a refused turn is filed under the exhaustion that refused it', () => {
    // The fast-fail terminal the breaker synthesizes, counted as the incident
    // it belongs to rather than as a second one — one open pool, one Sentry
    // group, however many turns arrive while it is open.
    assert.equal(
        cause(MANAGED_CHANNEL_UNAVAILABLE_CODE, REFUSAL_MESSAGE),
        'account_pool_empty'
    )
    // Carried by the durable code and never by our own prose. The refusal says
    // "no upstream accounts available" — deliberately not the gateway's word
    // order — so a breaker that only ever opens on this cause cannot be fed by
    // the terminals it produced itself.
    assert.equal(cause(null, REFUSAL_MESSAGE), null)
    assert.equal(cause('adapter_error', REFUSAL_MESSAGE), null)
})

test('the breaker producer requires the owned structured 503 envelope', () => {
    for (const message of [
        '{"error":{"code":503,"message":"No available Gemini accounts: no available accounts"}}'
    ])
        assert.equal(
            classifyManagedChannelFailureSignal({
                message
            }),
            'account_pool_empty'
        )

    for (const message of [
        'API Error: 503 {"error":{"message":"No available Antigravity accounts: no available accounts"}}',
        'unexpected status 503 Service Unavailable: {"error":{"message":"No available accounts: no available accounts"}}'
    ])
        assert.equal(
            classifyManagedChannelFailureSignal({ status: 503, message }),
            'account_pool_empty'
        )

    for (const message of [
        '503 No available Gemini accounts: no available accounts',
        'API Error: 503 Service Unavailable',
        'API Error: 503 {"error":{"message":"quota exceeded"}}',
        'API Error: 429 {"error":{"message":"No available accounts: no available accounts"}}',
        'API Error: 503 {"error":{"message":"No available accounts: insufficient balance"}}'
    ])
        assert.equal(
            classifyManagedChannelFailureSignal({
                message
            }),
            null
        )

    assert.equal(
        classifyManagedChannelFailureSignal({
            message: REFUSAL_MESSAGE
        }),
        null
    )
})

// The company an exhaustion keeps during an outage. Every line below is a
// different incident with a different fix — refilling the pool fixes none of
// them — and reading any of them as the pool's would trip a healthy channel
// for the whole fleet on one bad key, one throttled account or one bad minute
// at a gateway.
test('nothing but an empty pool reads as an empty pool', () => {
    const neighbours: readonly (readonly [string, string, string | null])[] = [
        // A 503 from in front of the pool: nothing in it says an account was
        // ever picked, so it identifies no cause at all.
        [
            'claude_result_error',
            'API Error: 503 {"error":{"message":"upstream connect error or disconnect/reset before headers"}}',
            null
        ],
        ['claude_result_error', 'API Error: 503 Service Unavailable', null],
        // Quota and rate limits are per-account and clear by waiting, so since
        // #803 they are their own incident — still not the pool's population,
        // and still not a balance, which is what the anchor order protects.
        [
            'gemini_exec_failed',
            'gemini exited 1: 429 {"error":{"message":"Resource has been exhausted (e.g. check quota)."}}',
            'rate_limited'
        ],
        [
            'codex_exec_failed',
            'codex exited 1: unexpected status 429 Too Many Requests: rate limit exceeded',
            'rate_limited'
        ],
        // Real causes that are somebody's key or somebody's wallet, not the
        // pool's population.
        [
            'hermes_upstream',
            '401 Unauthorized: {"error":"invalid api key"}',
            'auth_invalid'
        ],
        [
            'claude_result_error',
            'Failed to authenticate. API Error: 403 Insufficient account balance',
            'balance_exhausted'
        ],
        // Prose, which is most of what a bad afternoon actually produces.
        ['adapter_error', 'the model had trouble with your request', null],
        // The word "available" on its own is not the signal: the anchor needs
        // the gateway saying it has no ACCOUNTS.
        ['adapter_error', 'no available seats on your workspace plan', null]
    ]

    for (const [code, message, expected] of neighbours) {
        assert.equal(cause(code, message), expected, message)
        assert.notEqual(cause(code, message), 'account_pool_empty')
    }
})

test('a stale resume ref is one cause across the two runtimes that have one', () => {
    assert.equal(cause('dify_session_not_found', ''), 'stale_resume_ref')
    assert.equal(
        cause(
            'gemini_exec_failed',
            'gemini exited 42: the saved gemini session this chat was resuming could not be resolved by the runtime; its reference was dropped, so send the message again to start a fresh one'
        ),
        'stale_resume_ref'
    )
    assert.equal(
        cause(
            'gemini_exec_failed',
            'Error resuming session: Invalid session identifier'
        ),
        'stale_resume_ref'
    )
    assert.equal(
        cause(
            'codex_exec_failed',
            'codex exited 1: no rollout found for thread 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
        ),
        'stale_resume_ref'
    )
})

test('a dead daemon transport is one cause, read from chat-adapter itself', () => {
    assert.equal(
        cause('claude_exec_failed', 'claude_exec_failed: connection replaced'),
        'daemon_offline'
    )
    assert.equal(
        cause(
            'hermes_daemon_acp_failed',
            'daemon daemon-7f3a is offline; no active websocket'
        ),
        'daemon_offline'
    )
    assert.equal(
        cause('adapter_error', 'rpc broker shutting down'),
        'daemon_offline'
    )
})

test('a Sprite exec handshake follows its typed HTTP status', () => {
    // packages/sprites/src/exec-stream.ts. A 502 here means nothing ran; the
    // upstream never even saw the turn.
    assert.equal(
        cause(
            'claude_exec_failed',
            'execSpriteStream handshake failed: HTTP 502'
        ),
        'exec_handshake_failed'
    )
    assert.equal(
        cause(
            'codex_exec_failed',
            'execSpriteStream handshake failed: HTTP 500'
        ),
        'exec_handshake_failed'
    )
    assert.equal(
        cause(
            'claude_exec_failed',
            'execSpriteStream handshake failed: HTTP 401'
        ),
        'auth_invalid'
    )
    assert.equal(
        cause(
            'claude_exec_failed',
            'execSpriteStream handshake failed: HTTP 403'
        ),
        'auth_invalid'
    )
    assert.equal(
        cause(
            'claude_exec_failed',
            'execSpriteStream handshake failed: HTTP 400'
        ),
        'invalid_request'
    )
})

test('the budget codes carry their own identity and never need the prose', () => {
    assert.equal(cause('turn_idle_timeout', ''), 'inactivity_timeout')
    assert.equal(cause('openclaw_stream_stall', ''), 'inactivity_timeout')
    assert.equal(cause('turn_max_duration', ''), 'turn_duration_exceeded')
    assert.equal(cause('openclaw_turn_timeout', ''), 'turn_duration_exceeded')
    // A silent stream and a turn that ran too long are different incidents
    // with different fixes; folding them together would be a worse lie than
    // leaving them unclassified.
    assert.notEqual(
        cause('turn_idle_timeout', ''),
        cause('turn_max_duration', '')
    )
})

test('an idle stall is still an idle stall when only the message says so', () => {
    assert.equal(
        cause(
            'adapter_error',
            'hermes session/prompt produced no output for 120000ms'
        ),
        'inactivity_timeout'
    )
    assert.equal(
        cause(
            'adapter_error',
            'turn was still streaming after 900s (max duration budget 900s)'
        ),
        'turn_duration_exceeded'
    )
})

test('a capability the framework does not have is one cause across frameworks', () => {
    for (const code of [
        'claude_resume_unsupported',
        'codex_resume_unsupported',
        'gemini_resume_unsupported',
        'hermes_resume_unsupported',
        'openclaw_resume_unsupported',
        'resume_unsupported'
    ])
        assert.equal(cause(code, ''), 'unsupported_capability')
})

test('an upstream that answered with nothing is separated from one we sent nothing to', () => {
    assert.equal(cause('dify_no_body', ''), 'empty_response')
    assert.equal(cause('langflow_no_body', ''), 'empty_response')
    assert.equal(
        cause('claude_result_error', 'The model produced an empty response'),
        'empty_response'
    )
    // packages/external-providers rejects OUR request; that is a bad request,
    // and calling it an empty response would send an operator upstream chasing
    // a model that never got asked.
    assert.equal(
        cause('empty_message', 'Dify provider received empty message'),
        'invalid_request'
    )
    assert.equal(
        cause(
            'openclaw_upstream',
            '400 Bad Request: {"error":{"type":"invalid_request_error","message":"max_tokens is too large"}}'
        ),
        'invalid_request'
    )
})

test('typed provider HTTP codes classify without reading their response body', () => {
    for (const code of ['dify_http_401', 'langflow_http_401'])
        assert.equal(cause(code, 'upstream wording changed'), 'auth_invalid')
    for (const code of ['dify_http_400', 'langflow_http_400'])
        assert.equal(cause(code, 'upstream wording changed'), 'invalid_request')

    assert.equal(cause('dify_http_403', 'invalid api key'), null)
    assert.equal(cause('langflow_http_403', 'insufficient balance'), null)
    assert.equal(cause('dify_http_502', '502 Bad Gateway'), null)
    assert.equal(cause('langflow_http_502', 'invalid api key'), null)
})

test('a specific stable code cannot be overridden by an unrelated message anchor', () => {
    assert.equal(
        cause(
            'service_restarting',
            'invalid api key; insufficient account balance'
        ),
        null
    )
    assert.equal(
        cause(
            'external_converge_unavailable',
            'does not support this operation'
        ),
        null
    )
    assert.equal(cause('missing_binding', '400 Bad Request'), null)

    assert.equal(cause(null, '401 Unauthorized'), 'auth_invalid')
    assert.equal(cause(null, '403 Forbidden'), null)
    assert.equal(cause(null, '400 Bad Request'), 'invalid_request')
    assert.equal(cause(null, '502 Bad Gateway'), null)
})

// The property the fingerprint depends on, stated directly: the same incident
// must produce the same cause however the message is capitalised, whatever ids
// it carries, and whichever vendor phrased it.
test('case, dynamic ids and vendor wording do not change the cause', () => {
    const balance = 'Insufficient account balance'
    assert.equal(
        cause('claude_result_error', balance.toUpperCase()),
        'balance_exhausted'
    )
    assert.equal(
        cause('claude_result_error', balance.toLowerCase()),
        'balance_exhausted'
    )
    assert.equal(cause('claude_result_error', balance), 'balance_exhausted')

    const withRequestId = (id: string): string | null =>
        cause(
            'codex_exec_failed',
            `codex exited 1: unexpected status 403 Forbidden: {"code":"INSUFFICIENT_BALANCE"}, url: https://gw.netmind.xyz/responses, request_id: ${id}, cf-ray: ${id}-SJC`
        )
    assert.equal(withRequestId('req_01HZX9'), withRequestId('req_02QQ44'))
    assert.equal(withRequestId('req_01HZX9'), 'balance_exhausted')

    const stale = (thread: string): string | null =>
        cause(
            'codex_exec_failed',
            `codex exited 1: no rollout found for thread ${thread}`
        )
    assert.equal(stale('0199a1b2-c3d4'), stale('0199ffff-0000'))
})

// The bug being fixed is one bucket for everything. A classifier that answers
// for failures it does not recognise would rebuild that bucket under a new
// name, so an unknown message must return null and let Sentry group on the
// stack it always did.
test('an unrecognised failure stays unclassified', () => {
    assert.equal(cause('codex_exec_failed', 'codex exited 139: '), null)
    assert.equal(cause('claude_exec_failed', 'sprite exec exited 137'), null)
    assert.equal(
        cause('some_new_adapter_code', 'something nobody has seen'),
        null
    )
    assert.equal(cause(null, ''), null)
    assert.equal(classifyChatFailureCause({}), null)
})

test('the classifier only ever answers with a member of the closed taxonomy', () => {
    const messages = [
        'Failed to authenticate. API Error: 403 Insufficient account balance',
        '503 No available Gemini accounts: no available accounts',
        'execSpriteStream handshake failed: HTTP 502',
        'connection replaced',
        'Error resuming session: No previous sessions found for this project',
        'The model produced an empty response',
        '400 Bad Request',
        'this framework does not support resuming a session',
        'codex exited 139: '
    ]
    for (const message of messages) {
        const result = classifyChatFailureCause({ errorCode: null, message })
        if (result === null) continue
        assert.ok(
            (chatFailureCauses as readonly string[]).includes(result),
            `${result} is not in the taxonomy`
        )
    }
})
