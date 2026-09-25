import type { AgentFramework } from './constants'
import type { RuntimeLocalCredentialFacts } from './runtime-local-credentials'
import type { OpenclawTurnUsage } from './acp'

export type DaemonHostStatus = 'active' | 'offline' | 'revoked'

export type DaemonStartupMethod =
    | 'launchd-user'
    | 'launchd-system'
    | 'systemd-user'
    | 'systemd-system'
    | 'manual'
    // A pod host's boot loop (ADR-0035): nothing installs a unit, but the
    // container's main process restarts the daemon whenever it exits.
    | 'container'

export type DaemonCodingFramework = Extract<
    AgentFramework,
    'claude-code' | 'codex' | 'gemini-cli' | 'pi'
>

export type DaemonDetectableFramework = Extract<
    AgentFramework,
    'claude-code' | 'codex' | 'gemini-cli' | 'pi' | 'openclaw' | 'hermes'
>

// Every framework a self-owned daemon can detect + run (capability fact:
// supportsRuntime(f, 'daemon')). MUST stay in lockstep with the daemon's
// detect.ts BINARY_FOR_FRAMEWORK. dify/langflow/a2a are external endpoints —
// none belong on a daemon machine.
export const DAEMON_DETECTABLE_FRAMEWORKS: DaemonDetectableFramework[] = [
    'claude-code',
    'codex',
    'gemini-cli',
    'pi',
    'openclaw',
    'hermes'
]

export interface DetectedFramework {
    framework: DaemonDetectableFramework
    version: string | null
    path: string
    // openclaw only: the resident gateway the daemon DISCOVERED (never started)
    // from the host's own openclaw config. `reachable` is a loopback HTTP probe
    // at detection time, refreshed on the framework-detect interval rather than
    // per turn — since ADR-0027 O9 the API reads it as a pre-dispatch admission
    // fact, so a `false` refusal is deliberately RETRYABLE (the probe can be
    // minutes stale) while "no gateway configured" is not. null = the config
    // points at a remote gateway, which the daemon does not probe and the API
    // does not refuse. The gateway token is deliberately never reported.
    gateway?: DetectedOpenclawGateway
}

export interface DetectedOpenclawGateway {
    port: number | null
    reachable: boolean | null
    checkedAt: string
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
    // herdr's version on this machine (ADR-0031), null when not installed.
    herdrVersion?: string | null
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
    terminals?: DaemonOwnedTerminal[]
    herdrVersion?: string | null
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
    // A failed probe can omit facts; that response is not credential-ready.
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
    // This daemon's pty.open runs a supplied command as the shell's argv, so a
    // terminal on it can open straight into a framework TUI.
    canResumeInTerminal: boolean
    // herdr is installed on this machine and the daemon can open a chat
    // session's TUI in it (ADR-0031); false hides the handoff in the web.
    canOpenInHerdr: boolean
    // The frameworks it can start there (herdrFrameworksFor): a CLI from
    // before pi joined herdr hands over claude and codex only.
    herdrFrameworks: DaemonHerdrFramework[]
    // herdr's installed version, the newest herdr.dev publishes, and whether
    // the Update Center should offer the upgrade (ADR-0031).
    herdrVersion: string | null
    latestHerdrVersion: string | null
    herdrUpdateAvailable: boolean
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
    | 'turn.permission'
    | 'model.inspect'
    | 'account.inspect'
    | 'auth.list'
    | 'auth.create'
    | 'auth.inspect'
    | 'auth.logout'
    | 'auth.operation'
    | 'pty.open'
    | 'pty.input'
    | 'pty.resize'
    | 'pty.close'
    | 'terminal.herdr.open'
    | 'terminal.herdr.focus'
    | 'herdr.update'
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
    | 'service.upsert'
    | 'service.start'
    | 'service.stop'
    | 'service.delete'
    | 'service.list'

// `pty.attach` is the first event on a pty.open stream that carries a
// terminalId: its data says whether the daemon attached the stream to a
// terminal it already had (`attached`) or spawned one under that id.
export type DaemonStreamKind =
    | 'stdout'
    | 'stderr'
    | 'pty.out'
    | 'pty.attach'
    | 'fs.chunk'

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

// A service a pod host's daemon supervises (DAEMON_FEATURE_SERVICES). The env
// is kept apart from the spec on disk (mode 0600) because it carries the
// framework's credentials.
export interface DaemonServiceSpec {
    // [a-z0-9-], 1–40 characters: the file names derive from it.
    name: string
    command: string[]
    dir: string
    env: Record<string, string>
    // Where the service listens on the pod, and what answers when it is up.
    port?: number
    healthPath?: string
}

export type DaemonServiceState = 'running' | 'stopped' | 'restarting'

export interface DaemonServiceStatus {
    name: string
    state: DaemonServiceState
    pid: number | null
    startedAt: string | null
    restarts: number
    lastExit: string | null
    // null: no port or health path to ask.
    healthy: boolean | null
}

export interface DaemonClientProcess {
    instanceId: string
    pid: number
}

// What a restarted daemon made of the execs the previous one left running
// (ADR-0029 §4): sent once, in its first hello.
export interface DaemonExecRecoveryReport {
    adopted: number
    completed: number
    crashed: number
}

// Why a self-update on a manual install was undone (ADR-0029 §5): the
// daemon that runs after the rollback is the old binary again, and it
// carries this once so the platform learns what happened.
export interface DaemonUpdateRollbackReport {
    fromVersion: string
    toVersion: string
    reason: string
    at: string
}

// A terminal the daemon owns (ADR-0029 §6): opened with a terminalId, it
// outlives the stream that opened it. The daemon lists them in every hello
// and heartbeat; the API takes the list as proof of life for the terminal
// rows it holds and ends the rows the daemon no longer has.
export interface DaemonOwnedTerminal {
    terminalId: string
    attached: boolean
    startedAt: string
}

// The frameworks whose TUI a herdr pane can resume (ADR-0031): the ones with
// a resume-by-id form the browser terminal supports and an agent kind in
// herdr (herdr 0.9 has `claude`, `codex` and `pi`).
export type DaemonHerdrFramework = 'claude-code' | 'codex' | 'pi'

// terminal.herdr.open (ADR-0031): run a chat session's framework TUI in a
// herdr pane on the daemon's machine. The API composes command and env
// exactly as for pty.open (terminal identity, token, resume env); the daemon
// owns the herdr topology — a workspace per agent, a tab per session — and
// reports the pane it landed in.
export interface DaemonHerdrOpenPayload {
    terminalId: string
    framework: DaemonHerdrFramework
    command: string[]
    cwd?: string
    env: Record<string, string>
    // Human labels for herdr's tab and pane; the agent name becomes the
    // workspace label so herdr mirrors the web's agent → session shape.
    title: string
    agentName: string
    // The chat session the TUI resumes: the daemon tags the pane with it so
    // a later handoff of the same conversation takes over this tab instead
    // of adding another. Absent from APIs that predate it.
    chatSessionId?: string
    authSelection?: unknown
}

export interface DaemonHerdrOpenResult {
    paneId: string
    tabId: string
    workspaceId: string
    // herdr had a client attached and the pane was raised for it.
    focused: boolean
}

// herdr.update (ADR-0031): the daemon runs herdr's own updater and reports
// the version it left behind.
export interface DaemonHerdrUpdateResult {
    ok: boolean
    fromVersion: string | null
    toVersion: string | null
    error?: string
}

export interface UpgradeHerdrResponse {
    ok: boolean
    fromVersion: string | null
    toVersion: string | null
}

export type DaemonWsFrame =
    | {
          type: 'hello'
          daemonUuid: string
          cliVersion: string
          clientProcess?: DaemonClientProcess
          clientFeatures?: string[]
          inflightStreams?: DaemonInflightStream[]
          recovery?: DaemonExecRecoveryReport
          rollback?: DaemonUpdateRollbackReport
          // Present-but-empty and absent differ, as for inflightStreams: an
          // empty list proves the daemon owns no terminal, a missing one
          // means the enumeration failed.
          terminals?: DaemonOwnedTerminal[]
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

// Protocol baseline: stdin, split budgets, authoritative hello, secure file
// writes, credential facts and the dev update-channel spelling are required.
export const DAEMON_MIN_CLI_VERSION = '0.34.0'

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
    // Per-message model choice, applied via ACP session/set_model after the
    // session ensure. The wire id is a bare model id (hermes resolves the
    // provider; explicit `provider:model` also works). hermes persists the
    // session's model in its state.db, so env vars cannot move a resumed
    // session — set_model is the only reliable lever. Gated on
    // `turn.hermes.options`: an old daemon would silently ignore this field,
    // running the wrong model under a UI that claims otherwise.
    modelOverride?: string | null
    // true = the user explicitly picked this model, so a hermes build that
    // cannot switch (no session state, set_model unsupported) must FAIL the
    // turn rather than run something else. false/absent = reconcile-only: a
    // build that reports no session state skips the set silently, because the
    // target is just the agent's default.
    modelOverrideRequired?: boolean
    // Hermes edit-approval mode for this turn (see hermesPermissionModes in
    // chat.ts). dontAsk/absent = the pre-existing behavior: HERMES_YOLO_MODE=1
    // and auto-approved asks. The ask modes drop YOLO, best-effort
    // session/set_mode the matching hermes mode, and forward
    // session/request_permission upstream as permission_request frames for
    // the user to answer via the turn.permission RPC. Gated on
    // `turn.hermes.permissions`.
    permissionMode?: 'default' | 'acceptEdits' | 'dontAsk'
    // Deny-on-timeout deadline for an unanswered ask, ms. The daemon answers
    // with the request's own reject option when it expires.
    permissionTimeoutMs?: number
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
    // Absent on the gateway-http shape (every daemon predating the ACP cell
    // sends and reads it that way); 'acp' selects DaemonOpenclawAcpTurnPayload.
    transport?: 'gateway-http'
    url: string
    token?: string | null
    body: Record<string, unknown>
    // Split budgets. Each is independent: headers is a connect deadline,
    // idle RESETS on every body chunk (so an active stream never expires),
    // and maxDuration is the only wall-clock cap.
    headersTimeoutMs?: number
    idleTimeoutMs?: number
    maxDurationMs?: number
}

// openclaw over ACP on a BYOD daemon (ADR-0027): the daemon spawns `openclaw
// acp` against the host's OWN resident gateway — discovered from the user's
// openclaw config, never started, its token never seen by the API — and drives
// it as the ACP client exactly like a hermes turn. Continuity is the gateway
// session KEY (`_meta.sessionKey` on every session/new; the ACP sessionId is
// disposable, so there is no session/resume). The approval and model levers
// are gateway-side session fields the daemon patches in-box before the bridge
// starts, not ACP options.
export interface DaemonOpenclawAcpTurnPayload {
    framework: 'openclaw'
    transport: 'acp'
    prompt: string
    dir?: string
    sessionKey: string
    // `openclaw gateway call sessions.patch {key, ...}` before the bridge:
    // execAsk turns exec approval on for the ask mode, model applies a
    // per-message pick (`primary/<model>`). Absent = nothing patched.
    patch?: { execAsk?: string; model?: string }
    // openclaw permission mode (see openclawPermissionModes in chat.ts).
    // dontAsk/absent = the gateway's shipped tools.exec.ask stays off and asks
    // are auto-approved; default = session/request_permission is forwarded as
    // permission_request frames for the user to answer via turn.permission.
    permissionMode?: 'default' | 'dontAsk'
    permissionTimeoutMs?: number
    handshakeTimeoutMs?: number
    idleTimeoutMs?: number
    maxDurationMs?: number
}

export type DaemonTurnStartPayload =
    | DaemonHermesTurnPayload
    | DaemonOpenclawTurnPayload
    | DaemonOpenclawAcpTurnPayload

// Ack payload of turn.start — and, because it is written as the stream's
// final, also what exec.resume returns for a finished turn stream. A string
// `stopReason` means the agent's session/prompt call RESOLVED: the positive
// completion evidence the API requires before it may emit a `done` terminal
// (a bare exec exit proved to license truncated answers).
export interface DaemonTurnFinalPayload {
    stopReason: string | null
    sessionId: string | null
    result?: Record<string, unknown>
    // Session state hermes reported in its session/new|resume response —
    // model/mode ids as `provider:model` / mode id strings. Diagnostic
    // capture; absent on daemons that predate turn.hermes.options.
    models?: {
        currentModelId: string | null
        modelIds: string[]
    }
    modes?: {
        currentModeId: string | null
        modeIds: string[]
    }
    // openclaw ACP only: the turn's token usage read back from the gateway
    // transcript after the prompt (the ACP stream carries none), or why it
    // could not be attributed. Best-effort — its absence never fails a turn.
    usage?: OpenclawTurnUsage
    usageStatus?: string
}

export const DAEMON_FEATURE_EXEC_RESUME = 'exec.resume'
export const DAEMON_FEATURE_EXEC_STDIN = 'exec.stdin'
// The exec owner creates private temporary settings and cleans its owned process
// tree/resources before completing, including forced cancellation on Windows.
export const DAEMON_FEATURE_EXEC_RESOURCES = 'exec.resources.v1'
// The daemon can run execs without pipes and keep them across its own
// restart (ADR-0029 §4): `mf daemon stop --keep-execs` exists, and a
// restart adopts what the previous daemon left running. The platform's
// runner bring-up passes --keep-execs only to a daemon that says so.
export const DAEMON_FEATURE_EXEC_FILES = 'exec.files.v1'
// A daemon nobody supervises (`manual` startup) can still take
// daemon.update: it swaps the binary itself, hands its execs to a
// successor it starts, and rolls back if that successor never comes up
// (ADR-0029 §5). Computed at runtime — a standalone POSIX binary that is
// not the pod runner — so it is NOT in DAEMON_CLIENT_FEATURES.
export const DAEMON_FEATURE_MANUAL_UPDATE = 'daemon.update.manual'
export const DAEMON_FEATURE_DAEMON_UPDATE = 'daemon.update'
// The protocol baseline honours stable/dev channel overrides for updates.
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
// DaemonTurnStartPayload). `turn.openclaw` is the gateway-http shape, which
// only gateway-transport frameworks send now (openclaw chat is ACP-only since
// ADR-0027 O9); the API falls back to its own client when it is absent, so it
// gates the transport choice per daemon. For hermes it is an admission gate
// since ADR-0024 (chat is ACP-only): a daemon without it is refused with
// `hermes_daemon_upgrade_required`.
export const DAEMON_FEATURE_TURN_HERMES = 'turn.hermes'
export const DAEMON_FEATURE_TURN_OPENCLAW = 'turn.openclaw'
// turn.start accepts DaemonOpenclawAcpTurnPayload (framework openclaw,
// transport acp): the daemon drives `openclaw acp` against the host's own
// gateway, patches the session in-box for the ask mode / model pick, reads
// the usage back after the prompt, and answers turn.permission for its asks.
// Since ADR-0027 O9 this is the ONLY shape a daemon openclaw turn takes, so
// the capability is an admission gate like hermes's: a daemon without it is
// refused with `openclaw_daemon_upgrade_required`, and one whose heartbeat
// reports no reachable gateway with `openclaw_daemon_gateway_unavailable`.
// The `openclaw agent --local --json` spawn it used to fall back to is gone.
export const DAEMON_FEATURE_TURN_OPENCLAW_ACP = 'turn.openclaw.acp'
// The hello's inflightStreams field is authoritative when PRESENT (an empty
// list really means "no streams") and unknown when ABSENT (enumeration
// failed). This distinction is required by the protocol baseline.
export const DAEMON_FEATURE_HELLO_INFLIGHT = 'hello.inflight-authoritative'
// The fs containment allows the exact file ~/.claude.json (Claude Code's
// user-level config, a SIBLING of the ~/.claude root) for Manyfold-managed
// MCP config. Exact-path containment remains mandatory (#781).
export const DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG = 'fs.claude-user-config'
// The fs.write handler honours a `mode` field (octal string) by chmodding
// after the write. MCP materialization always requests 0600 so plaintext
// configuration keys never land world-readable (#781).
export const DAEMON_FEATURE_FS_WRITE_MODE = 'fs.write.mode'
export const DAEMON_FEATURE_FS_CONFIG_COMMIT = 'fs.write.config-commit'

export interface DaemonConfigCommit {
    generation: string
    revision: string
    expectedSha256: string | null
}
// The turn runners parse the split budgets (idleTimeoutMs / headersTimeoutMs /
// maxDurationMs) on DaemonTurnStartPayload. The single timeoutMs field is
// retired; this advertisement remains useful for fleet inspection.
export const DAEMON_FEATURE_TURN_BUDGETS = 'turn.budgets'
// The model.inspect response carries credentialFacts (see
// DaemonFrameworkModelCapability). Missing facts do not establish credential
// readiness; heartbeat advertisement is observable fleet metadata.
export const DAEMON_FEATURE_CREDENTIAL_FACTS = 'model.credential-facts'
// The hermes turn runner honours DaemonHermesTurnPayload.modelOverride
// (session/set_model before the prompt, failing the turn on error) and
// reports the session's models/modes state on the final. The API refuses to
// dispatch a turn carrying a model override to a daemon without this —
// silently dropping the user's explicit model choice would run the wrong
// model under a UI that claims otherwise.
export const DAEMON_FEATURE_TURN_HERMES_OPTIONS = 'turn.hermes.options'
// The hermes turn runner honours DaemonHermesTurnPayload.permissionMode
// (interactive session/request_permission, answered via the turn.permission
// RPC, deny-on-timeout) instead of unconditionally auto-approving under
// HERMES_YOLO_MODE. The API refuses to dispatch an ask-mode turn to a daemon
// without this — silently running YOLO under a UI that claims "ask" would be
// worse than refusing.
export const DAEMON_FEATURE_TURN_HERMES_PERMISSIONS = 'turn.hermes.permissions'
// The pty.open handler honours a `command` array by running it as the shell's
// argv (`shell -ilc '<cmd>; exec shell -il'`) instead of opening a bare login
// shell. The API refuses to send a terminal-resume command to a daemon without
// this: an older daemon ignores the field and opens a plain shell, which would
// leave the user staring at a prompt under a UI that said it was resuming
// their conversation.
export const DAEMON_FEATURE_PTY_COMMAND = 'pty.command'
// pty.open honours `terminalId` (ADR-0029 §6): the pty belongs to the daemon
// and the stream is one attachment to it — a cancel detaches instead of
// killing, a second pty.open with the same id attaches (the screen so far,
// then the live tail), pty.close honours `terminalId`, and the hello and
// heartbeat list the owned terminals so the API can hold their rows on the
// daemon's word instead of a tunnel lease. Without it the API opens pty
// streams the old way, one process per stream.
export const DAEMON_FEATURE_PTY_TERMINAL = 'pty.terminal.v1'
// The daemon can hand a chat session to herdr on its own machine (ADR-0031):
// `terminal.herdr.open` starts the framework TUI in a herdr pane named after
// the session, `terminal.herdr.focus` raises that pane, `pty.close` by
// terminalId closes it, and the hello/heartbeat inventory lists herdr-hosted
// terminals alongside owned ones. Computed at runtime: present only while
// the `herdr` binary is found on the machine, so the web can offer the
// handoff exactly where it can work.
export const DAEMON_FEATURE_HERDR_TERMINAL = 'terminal.herdr.v1'
// The daemon's herdr handoff (above) also starts pi. Advertised with it, by a
// CLI that knows pi's herdr kind.
export const DAEMON_FEATURE_HERDR_PI = 'terminal.herdr.pi.v1'

// What a host with these features can hand to herdr: nothing without the
// handoff, claude and codex with it, pi too when the CLI knows pi's kind.
export const herdrFrameworksFor = (
    clientFeatures: readonly string[]
): DaemonHerdrFramework[] =>
    clientFeatures.includes(DAEMON_FEATURE_HERDR_TERMINAL)
        ? [
              'claude-code',
              'codex',
              ...(clientFeatures.includes(DAEMON_FEATURE_HERDR_PI)
                  ? (['pi'] as const)
                  : [])
          ]
        : []

// The daemon answers `account.inspect` (who is signed in on this machine per
// coding CLI, plus the raw vendor usage response). The API must check this
// before calling: an older daemon answers `not_implemented`, which the runtime
// page has to render as "upgrade the CLI", not as a probe failure.
export const DAEMON_FEATURE_ACCOUNT_INSPECT = 'account.inspect'
// The daemon hosts runtime auth profiles (`auth.*` RPCs: list/create/inspect/
// logout/operation) and honours `pty.open`'s `authLogin` field, running the
// vendor sign-in inside that profile's own credential context. Management
// only: executing a turn under a profile is a separate capability, so a
// daemon that can list accounts is not assumed able to run with one.
export const DAEMON_FEATURE_AUTH_PROFILES = 'auth-profiles.v1'
// exec.start, pty.open and model.inspect honour `authSelection`
// (DaemonAuthContextRef): the process runs inside that profile's credential
// context. A daemon without this ignores the field and would run the native
// sign-in instead, so the API refuses a profile-bound execution to it rather
// than let the wrong account answer.
export const DAEMON_FEATURE_AUTH_CONTEXT = 'auth-context.v1'
// The daemon sends its WebSocket credential in Authorization, never the URL.
// Fleet coverage is the retirement gate for the API's query-token reader.
export const DAEMON_FEATURE_WS_AUTH_HEADER = 'ws.auth-header'
// auth.create accepts an `apiKey` for an api-key profile and injects it into
// that profile's executions. Older daemons would create the profile and drop
// the key, so the API refuses api-key creation without this.
export const DAEMON_FEATURE_AUTH_API_KEY = 'auth-api-key.v1'
// The daemon knows pi as a CLI with a sign-in of its own: `model.inspect` and
// `account.inspect` report pi's credential facts and the models `pi
// --list-models` offers, and the `auth.*` RPCs keep pi profiles (a view of
// ~/.pi/agent with its own auth.json). An older daemon reports nothing for
// pi, which reads as "not signed in" — the API asks for a CLI update instead.
export const DAEMON_FEATURE_PI_LOCAL = 'pi.runtime-local.v1'
// The `service.*` RPCs: the daemon keeps a service framework's long-running
// process up from a spec on the home volume (ADR-0035 §6), as a sprite's
// Services API does. Only a pod host's daemon (startup method 'container')
// offers it; nothing asks a user's own machine to run a service.
export const DAEMON_FEATURE_SERVICES = 'services.v1'
export const DAEMON_CLIENT_FEATURES = [
    DAEMON_FEATURE_EXEC_RESUME,
    DAEMON_FEATURE_EXEC_STDIN,
    DAEMON_FEATURE_EXEC_RESOURCES,
    DAEMON_FEATURE_EXEC_FILES,
    DAEMON_FEATURE_DAEMON_UPDATE,
    DAEMON_FEATURE_DAEMON_UPDATE_CHANNEL,
    DAEMON_FEATURE_FS_WRITE_BINARY,
    DAEMON_FEATURE_DAEMON_UPDATE_DRAIN,
    DAEMON_FEATURE_TURN_HERMES,
    DAEMON_FEATURE_TURN_OPENCLAW,
    DAEMON_FEATURE_HELLO_INFLIGHT,
    DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG,
    DAEMON_FEATURE_FS_WRITE_MODE,
    DAEMON_FEATURE_FS_CONFIG_COMMIT,
    DAEMON_FEATURE_TURN_BUDGETS,
    DAEMON_FEATURE_CREDENTIAL_FACTS,
    DAEMON_FEATURE_TURN_HERMES_OPTIONS,
    DAEMON_FEATURE_TURN_HERMES_PERMISSIONS,
    DAEMON_FEATURE_PTY_COMMAND,
    DAEMON_FEATURE_PTY_TERMINAL,
    DAEMON_FEATURE_ACCOUNT_INSPECT,
    DAEMON_FEATURE_TURN_OPENCLAW_ACP,
    DAEMON_FEATURE_AUTH_PROFILES,
    DAEMON_FEATURE_AUTH_CONTEXT,
    DAEMON_FEATURE_WS_AUTH_HEADER,
    DAEMON_FEATURE_AUTH_API_KEY,
    DAEMON_FEATURE_PI_LOCAL
]
