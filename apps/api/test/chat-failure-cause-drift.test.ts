import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { classifyChatFailureCause } from '../src/modules/chat/chat-failure-cause'

// The classifier's blind spot is structural: a NEW error code minted on a chat
// terminal path lands in CAUSE_BY_CODE, in the broad set, or — silently — in
// the `code_unmapped` bucket where its message is never read. Nothing made
// that placement a decision until this file: every code literal minted under
// src/modules/chat or packages/external-providers/src must be mapped, broad,
// or excluded here with a reason. The same mechanism turned the §4.5 env
// aliases auditable (legacy-env-audit.test.ts); this is legacy-inventory §4.4.
//
// Membership is probed behaviorally through the public function instead of
// exporting the internal tables: a mapped code classifies with no message; a
// broad code lets a balance message through; an unmapped specific code
// refuses both (pinned adversarially in chat-failure-cause.test.ts).
const isMapped = (code: string): boolean =>
    classifyChatFailureCause({ errorCode: code, message: '' }) !== null
const isBroad = (code: string): boolean =>
    !isMapped(code) &&
    classifyChatFailureCause({
        errorCode: code,
        message: 'insufficient account balance'
    }) === 'balance_exhausted'

// Codes that deliberately have no durable mapping and must not gain one by
// accident. Grouped by why classification is not wanted; deleting a code from
// the sources requires deleting its row here (asserted below), and mapping one
// requires the same, so this list can only shrink or be consciously grown.
const CANCEL =
    'abort/cancel outcome — a user decision, not an incident to classify'
const HTTP_SURFACE =
    'HttpException body code on the share/history surface, not a chat terminal'
const RECOVERY =
    'session-recovery surface code; rides its own RPC flow, not chat.stream.error'
const PINNED_NULL =
    'deliberately null — a specific code prose must not override (adversarial test)'
const UNMAPPED =
    'no durable mapping today; a causeVia=code_unmapped count in telemetry is the signal to map it'
const EXCLUDED_CODES = new Map<string, string>([
    ['cancelled_by_user', CANCEL],
    ['hermes_aborted', CANCEL],
    ['hermes_daemon_aborted', CANCEL],
    ['openclaw_aborted', CANCEL],
    ['openclaw_daemon_aborted', CANCEL],
    ['chat_share_channel_session', HTTP_SURFACE],
    ['chat_share_empty_session', HTTP_SURFACE],
    ['chat_share_not_found', HTTP_SURFACE],
    ['conversation_not_found', HTTP_SURFACE],
    ['invalid_after', HTTP_SURFACE],
    ['recovery_no_session_ref', RECOVERY],
    ['recovery_empty', RECOVERY],
    ['recovery_unsupported_framework', RECOVERY],
    ['recovery_runtime_unavailable', RECOVERY],
    ['runtime_session_recovery_conflict', RECOVERY],
    ['runtime_session_ref_required', RECOVERY],
    ['runtime_session_empty', RECOVERY],
    ['runtime_session_mismatch', RECOVERY],
    ['rebuild_no_session_ref', RECOVERY],
    ['runtime_session_rebuild_not_recovered', RECOVERY],
    ['runtime_session_rebuild_conflict', RECOVERY],
    ['service_restarting', PINNED_NULL],
    ['missing_binding', PINNED_NULL],
    ['external_converge_unavailable', PINNED_NULL],
    ['sprite_exec_result_lost', UNMAPPED],
    ['external_provider_unavailable', UNMAPPED],
    ['external_provider_failed', UNMAPPED],
    ['external_converge_failed', UNMAPPED],
    ['provider_kind_mismatch', UNMAPPED],
    ['openclaw_daemon_exit_nonzero', UNMAPPED],
    ['openclaw_daemon_event_error', UNMAPPED],
    ['openclaw_network', UNMAPPED],
    ['server_restart', UNMAPPED],
    ['a2a_resolve_failed', UNMAPPED],
    ['a2a_stream_error', UNMAPPED],
    ['a2a_converge_no_ref', UNMAPPED],
    ['unsafe_provider_endpoint', UNMAPPED],
    ['dify_stream_error', UNMAPPED],
    ['dify_converge_no_ref', UNMAPPED],
    ['dify_upload_no_id', UNMAPPED],
    ['missing_flow_id', UNMAPPED],
    ['langflow_stream_error', UNMAPPED]
])

// `code:` template literals whose value is computed at runtime. Accounted by
// exact source text: the runtime domain is not expandable statically, so each
// entry records why its family is classified (or not) as a whole.
const DYNAMIC_CODE_SOURCES = new Map<string, string>([
    [
        '${this.framework}_not_ready',
        'readiness-timeout family; our own prose, unmapped like its per-framework members'
    ],
    [
        '${this.framework}_upstream_cancelled',
        'cancel family — a user decision, not an incident to classify'
    ],
    [
        'a2a_${err.code}',
        'passthrough of the upstream A2A error code; an open set that stays unmapped'
    ],
    [
        'a2a_${state}',
        'upstream A2A task state as a code; an open set that stays unmapped'
    ],
    [
        'dify_http_${res.status}',
        'typed per-status family: 400/401 are in CAUSE_BY_CODE, other statuses deliberately null (pinned in chat-failure-cause.test.ts)'
    ],
    [
        'dify_upload_http_${res.status}',
        'upload leg of the dify_http family; same per-status treatment'
    ],
    [
        'langflow_http_${res.status}',
        'typed per-status family: 400/401 are in CAUSE_BY_CODE, other statuses deliberately null (pinned in chat-failure-cause.test.ts)'
    ]
])

const walk = (dir: string, files: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, files)
        else if (full.endsWith('.ts')) files.push(full)
    }
    return files
}

const ROOTS = [
    path.resolve('src', 'modules', 'chat'),
    path.resolve('..', '..', 'packages', 'external-providers', 'src')
]

const LITERAL_PATTERNS = [
    // First char must be a letter: status-number tokens like
    // INSPECTED_POOL_EMPTY_CODE = '503' are comparisons, not minted codes.
    /\bcode: '([a-z][a-z0-9_]*)'/g,
    /\bcode = '([a-z][a-z0-9_]*)'/g,
    /_CODE = '([a-z][a-z0-9_]*)'/g
]
const DYNAMIC_PATTERN = /\bcode: `([^`]+)`/g

test('every chat terminal code literal is mapped, broad, or excluded with a reason', () => {
    const found = new Map<string, string>()
    const dynamicFound = new Map<string, string>()
    for (const root of ROOTS) {
        for (const file of walk(root)) {
            const text = readFileSync(file, 'utf8')
            for (const pattern of LITERAL_PATTERNS)
                for (const match of text.matchAll(pattern))
                    if (!found.has(match[1])) found.set(match[1], file)
            for (const match of text.matchAll(DYNAMIC_PATTERN))
                if (!dynamicFound.has(match[1]))
                    dynamicFound.set(match[1], file)
        }
    }

    const unaccounted = [...found.entries()].filter(
        ([code]) =>
            !isMapped(code) && !isBroad(code) && !EXCLUDED_CODES.has(code)
    )
    assert.deepEqual(
        unaccounted.map(([code, file]) => `${code} (${path.basename(file)})`),
        [],
        'a new terminal code must join CAUSE_BY_CODE, the broad set, or EXCLUDED_CODES (with a reason)'
    )

    assert.deepEqual(
        [...dynamicFound.keys()].sort(),
        [...DYNAMIC_CODE_SOURCES.keys()].sort(),
        'a new dynamic code template must be registered in DYNAMIC_CODE_SOURCES with a reason'
    )

    // Ratchet: exclusions may only describe codes that still exist and are
    // still unclassified — a mapped or deleted code must drop its row.
    for (const code of EXCLUDED_CODES.keys()) {
        assert.ok(
            found.has(code),
            `stale exclusion: ${code} is no longer minted anywhere`
        )
        assert.ok(
            !isMapped(code) && !isBroad(code),
            `stale exclusion: ${code} is now classified and must leave the list`
        )
    }
})
