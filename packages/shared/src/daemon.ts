import type { AgentFramework } from './constants'
import type { RuntimeLocalCredentialFacts } from './runtime-local-credentials'

export type DaemonHostStatus = 'active' | 'offline' | 'revoked'

export type DaemonStartupMethod =
    | 'launchd-user'
    | 'launchd-system'
    | 'systemd-user'
    | 'systemd-system'
    | 'manual'

export type DaemonCodingFramework = Extract<
    AgentFramework,
    'claude-code' | 'codex' | 'gemini-cli'
>

export type DaemonDetectableFramework = Extract<
    AgentFramework,
    'claude-code' | 'codex' | 'gemini-cli' | 'openclaw' | 'hermes'
>

// Every framework a self-owned daemon can detect + run (capability fact:
// supportsRuntime(f, 'daemon')). MUST stay in lockstep with the daemon's
// detect.ts BINARY_FOR_FRAMEWORK. narranexus is sprites/k8s-only; dify/langflow/
// a2a are external endpoints — none belong on a daemon machine.
export const DAEMON_DETECTABLE_FRAMEWORKS: DaemonDetectableFramework[] = [
    'claude-code',
    'codex',
    'gemini-cli',
    'openclaw',
    'hermes'
]

export interface DetectedFramework {
    framework: DaemonDetectableFramework
    version: string | null
    path: string
}

export interface RegisterDaemonRequest {
    daemonUuid: string
    name: string
    hostname: string | null
    os: string
    arch: string
    cliVersion: string
    homeDir: string
    workspaceBaseDir: string
    skillsDir?: string
    detectedFrameworks: DetectedFramework[]
    terminalPty?: boolean
}

export interface RegisterDaemonResponse {
    daemonId: string
    runtimes: Array<{
        runtimeId: string
        framework: DetectedFramework['framework']
    }>
    wsUrl: string
}

export interface HeartbeatRequest {
    detectedFrameworks: DetectedFramework[]
    cliVersion: string
    startupMethod: DaemonStartupMethod
    terminalPty?: boolean
    clientFeatures?: string[]
}

export interface HeartbeatResponse {
    ok: true
    actions: Array<Record<string, unknown>>
}

export interface DaemonFrameworkModelCapability {
    framework: DaemonCodingFramework
    cliVersion: string | null
    ready?: boolean
    credentialReady?: boolean | null
    // Optional: daemons older than the credential-facts contract omit it, and
    // the API treats its absence as "cannot judge" rather than "not ready".
    credentialFacts?: RuntimeLocalCredentialFacts | null
    configReadable: boolean
    current: string | null
    models: string[]
    aliases?: string[]
    speeds?: string[]
    intelligence?: string[]
    lastCheckedAt: string
    error?: string | null
}

export interface DaemonModelInspectResponse {
    frameworks: DaemonFrameworkModelCapability[]
}

export interface AdminDaemonHostSummary extends DaemonHostSummary {
    userId: string
    userEmail: string | null
    tokenCount: number
}

export interface DaemonHostSummary {
    id: string
    name: string
    daemonUuid: string
    hostname: string | null
    os: string | null
    arch: string | null
    cliVersion: string | null
    needsUpgrade: boolean
    latestCliVersion: string | null
    updateAvailable: boolean
    canRemoteUpgrade: boolean
    canCrossChannelUpgrade: boolean
    startupMethod: DaemonStartupMethod | null
    homeDir: string | null
    workspaceBaseDir: string | null
    detectedFrameworks: DetectedFramework[]
    status: DaemonHostStatus
    online: boolean
    lastSeenAt: string | null
    createdAt: string
    agentCount: number
    runtimes: Array<{
        runtimeId: string
        framework: DetectedFramework['framework']
        name: string
    }>
}

export interface DaemonTokenSummary {
    id: string
    name: string
    daemonId: string | null
    lastUsedAt: string | null
    expiresAt: string | null
    revokedAt: string | null
    createdAt: string
}

export interface IssueDaemonTokenBody {
    name: string
    expiresInDays?: number
}

export interface IssueDaemonTokenResponse {
    token: string
    summary: DaemonTokenSummary
}

export interface UpgradeDaemonHostResponse {
    ok: boolean
    fromVersion: string | null
    toVersion: string | null
    restarting?: boolean
    // The daemon had live exec/pty sessions and deferred the update: it stops
    // admitting new sessions and restarts once the last one ends (or a drain
    // deadline passes). `activeSessions` is the count at defer time.
    deferred?: boolean
    activeSessions?: number
}

export type DaemonRpcMethod =
    | 'exec.start'
    | 'exec.resume'
    | 'exec.abort'
    | 'exec.input'
    | 'exec.eof'
    | 'turn.start'
    | 'model.inspect'
    | 'pty.open'
    | 'pty.input'
    | 'pty.resize'
    | 'pty.close'
    | 'fs.list'
    | 'fs.stat'
    | 'fs.read'
    | 'fs.write'
    | 'fs.mkdir'
    | 'fs.mv'
    | 'fs.rm'
    | 'workspace.ensure'
    | 'workspace.delete'
    | 'daemon.update'

export type DaemonStreamKind = 'stdout' | 'stderr' | 'pty.out' | 'fs.chunk'

export type DaemonInflightStreamStatus =
    | 'running'
    | 'completed'
    | 'aborted'
    | 'crashed'

export interface DaemonInflightStream {
    refId: string
    method: DaemonRpcMethod
    lastSeq: number
    status: DaemonInflightStreamStatus
}

export type DaemonWsFrame =
    | {
          type: 'hello'
          daemonUuid: string
          cliVersion: string
          clientFeatures?: string[]
          inflightStreams?: DaemonInflightStream[]
      }
    | {
          type: 'welcome'
          daemonId: string
          serverTime: string
          runtimeIds: string[]
          serverFeatures?: string[]
      }
    | { type: 'ping' }
    | { type: 'pong' }
    | {
          type: 'push'
          refId: string
          method: DaemonRpcMethod
          payload: Record<string, unknown>
      }
    | {
          type: 'ack'
          refId: string
          ok: boolean
          error?: string
          payload?: Record<string, unknown>
      }
    | {
          type: 'event'
          refId: string
          kind: DaemonStreamKind
          data: string
          seq?: number
      }
    | {
          type: 'cancel'
          refId: string
      }

// How stale `runtime_hosts.rpc_last_seen_at` may be before a daemon counts as
// offline. Shared because turn arbitration now depends on it: the adoption
// sweep skips a turn whose daemon is online (that daemon resumes it over the
// reverse WS), so "online" has to mean the same thing there as it does in the
// host API that renders the badge.
export const DAEMON_ONLINE_THRESHOLD_MS = 45_000

// How often the daemon actually re-runs the `<bin> --version` probes behind
// `detectedFrameworks`. The 15s heartbeat replays the cached result on the
// other 19 rounds, so this — not the heartbeat interval — is the true age
// bound on a reported inventory. Shared because the API stamps per-runtime
// freshness from it: refreshing on every heartbeat turned a 5-minute probe
// into a 15-second freshness claim (#629).
export const DAEMON_FRAMEWORK_DETECT_INTERVAL_MS = 5 * 60_000

// Cap on a single daemon WebSocket frame. fs.write puts the whole file,
// base64-encoded, in one RPC frame, so this is what bounds a daemon upload.
export const DAEMON_WS_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
// Room for the JSON envelope (method, id, absolute path) around the payload.
const DAEMON_RPC_ENVELOPE_HEADROOM_BYTES = 64 * 1024
// base64 costs 4 bytes per 3, so the raw file has to be this much smaller than
// the frame limit. Exposed so clients can refuse before uploading.
export const DAEMON_FS_WRITE_MAX_BYTES = Math.floor(
    ((DAEMON_WS_MAX_PAYLOAD_BYTES - DAEMON_RPC_ENVELOPE_HEADROOM_BYTES) * 3) / 4
)

// turn.start: the daemon runs a whole turn itself and appends every upstream
// frame to the exec buffer under the RPC's refId, one frame per line. The
// point is WHO holds the upstream connection: a client living in the API
// process dies with the API and takes the turn with it; a client living here
// survives any API restart, and the API recovers the turn by replaying the
// buffer (exec.resume), exactly as it does for claude/codex exec turns.
//
// hermes: the daemon spawns `hermes acp` and drives the JSON-RPC conversation
// as the CLIENT (ACP is client-driven — the earlier API-side client ended the
// turn by construction on every restart).
export interface DaemonHermesTurnPayload {
    framework: 'hermes'
    prompt: string
    cmd?: string[]
    env?: Record<string, string>
    dir?: string
    // ACP sessionId from an earlier turn; the daemon tries session/resume and
    // falls back to session/new, reporting the id it ended up with.
    sessionId?: string | null
    // Legacy single budget over session/prompt: one absolute deadline that the
    // streamed session/update notifications never reset, so a turn still
    // producing output was truncated (#556). Kept as the fallback for runners
    // that predate the split below, so an old daemon keeps exactly its old
    // behaviour instead of inheriting the much larger maxDurationMs.
    timeoutMs?: number
    handshakeTimeoutMs?: number
    // Split budgets for session/prompt only — the handshake keeps its own
    // short fixed budget. idle RESETS on every frame the child emits (stdout
    // or stderr), so an ACP conversation that is streaming never expires;
    // maxDuration is the only wall-clock cap.
    idleTimeoutMs?: number
    maxDurationMs?: number
}

// openclaw: the daemon POSTs the prepared /v1/chat/completions request to the
// agent's resident gateway and journals each SSE `data:` payload as one line.
// Closing that SSE socket CANCELS the gateway run — which is exactly why the
// socket must be held here and not in the API.
export interface DaemonOpenclawTurnPayload {
    framework: 'openclaw'
    url: string
    token?: string | null
    body: Record<string, unknown>
    // Legacy single budget: one absolute deadline over headers AND the whole
    // SSE read, which truncated turns that were still streaming (#513). Kept
    // as the fallback for runners that predate the split below, so an old
    // daemon keeps exactly its old behaviour instead of inheriting the much
    // larger maxDurationMs.
    timeoutMs?: number
    // Split budgets. Each is independent: headers is a connect deadline,
    // idle RESETS on every body chunk (so an active stream never expires),
    // and maxDuration is the only wall-clock cap.
    headersTimeoutMs?: number
    idleTimeoutMs?: number
    maxDurationMs?: number
}

export type DaemonTurnStartPayload =
    | DaemonHermesTurnPayload
    | DaemonOpenclawTurnPayload

// Ack payload of turn.start — and, because it is written as the stream's
// final, also what exec.resume returns for a finished turn stream. A string
// `stopReason` means the agent's session/prompt call RESOLVED: the positive
// completion evidence the API requires before it may emit a `done` terminal
// (a bare exec exit proved to license truncated answers).
export interface DaemonTurnFinalPayload {
    stopReason: string | null
    sessionId: string | null
    result?: Record<string, unknown>
}

export const DAEMON_FEATURE_EXEC_RESUME = 'exec.resume'
export const DAEMON_FEATURE_EXEC_STDIN = 'exec.stdin'
export const DAEMON_FEATURE_DAEMON_UPDATE = 'daemon.update'
// The daemon.update handler honours a `channel` override in the RPC payload,
// letting the platform install a build from the other channel's CDN (used for
// cross-channel upgrades in local/staging). Daemons without this still ignore
// the field and self-update from their own baked channel.
export const DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL = 'daemon.update.channel'
// The fs.write handler decodes `encoding: 'base64'` payloads into raw bytes
// instead of coercing the content to a UTF-8 string. Required for binary file
// attachments (images, PDFs) — daemons without this corrupt binary writes, so
// the platform refuses to send them binary attachments.
export const DAEMON_FEATURE_FS_WRITE_BINARY = 'fs.write.binary'
// daemon.update defers while exec/pty sessions are live instead of killing
// them: the ack carries `deferred`/`activeSessions` and the daemon restarts
// itself once drained. Daemons without this restart immediately.
export const DAEMON_FEATURE_DAEMON_UPDATE_DRAIN = 'daemon.update.drain'
// The daemon accepts turn.start for the named framework (see
// DaemonTurnStartPayload). The API must fall back to its own client when the
// capability is absent, so it gates the transport choice per daemon.
export const DAEMON_FEATURE_TURN_HERMES = 'turn.hermes'
export const DAEMON_FEATURE_TURN_OPENCLAW = 'turn.openclaw'
// The hello's inflightStreams field is authoritative when PRESENT (an empty
// list really means "no streams") and unknown when ABSENT (enumeration
// failed). Older daemons omit the field for both, so the server can only key
// convergence decisions off its absence when the client declares this.
export const DAEMON_FEATURE_HELLO_INFLIGHT = 'hello.inflight-authoritative'
// The fs containment allows the exact file ~/.claude.json (Claude Code's
// user-level config, a SIBLING of the ~/.claude root) for Manyfold-managed
// MCP config. The server must not attempt user-scope MCP reads/writes on a
// daemon without this — the older CLI refuses the path (#781).
export const DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG = 'fs.claude-user-config'
// The fs.write handler honours a `mode` field (octal string) by chmodding
// after the write. Config files carrying secrets (Composio MCP server keys)
// are only materialized onto daemons that declare this, so a plaintext key
// never lands world-readable (#781).
export const DAEMON_FEATURE_FS_WRITE_MODE = 'fs.write.mode'
export const DAEMON_CLIENT_FEATURES = [
    DAEMON_FEATURE_EXEC_RESUME,
    DAEMON_FEATURE_EXEC_STDIN,
    DAEMON_FEATURE_DAEMON_UPDATE,
    DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL,
    DAEMON_FEATURE_FS_WRITE_BINARY,
    DAEMON_FEATURE_DAEMON_UPDATE_DRAIN,
    DAEMON_FEATURE_TURN_HERMES,
    DAEMON_FEATURE_TURN_OPENCLAW,
    DAEMON_FEATURE_HELLO_INFLIGHT,
    DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG,
    DAEMON_FEATURE_FS_WRITE_MODE
]
