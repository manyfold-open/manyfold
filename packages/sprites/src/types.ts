export interface Sprite {
    id: string
    name: string
    status: string
    url?: string
    created_at?: string
    updated_at?: string
    last_running_at?: string | null
    last_warming_at?: string | null
    environment_version?: string | null
    [key: string]: unknown
}

export type ServiceStatus =
    | 'stopped'
    | 'starting'
    | 'running'
    | 'stopping'
    | 'failed'

export interface ServiceState {
    name: string
    status: ServiceStatus
    pid?: number
    started_at?: string
    error?: string
    next_restart_at?: string
}

export interface ServiceDef {
    cmd: string
    args?: string[]
    env?: Record<string, string>
    dir?: string
    needs?: string[]
    http_port?: number
}

export interface ServiceObject extends ServiceDef {
    name: string
    state: ServiceState
}

export interface ServiceListResponse {
    services: ServiceObject[]
}

export interface ServiceMutationOptions {
    durationSec?: number
}

export interface ServiceStopOptions {
    timeoutSec?: number
}

export interface ListSpritesResponse {
    sprites: Sprite[]
    running: number
    warm: number
    cold: number
    running_limit?: number
    warm_limit?: number
    has_more?: boolean
    next_continuation_token?: string | null
}

export interface NetworkPolicyRule {
    domain: string
    action: 'allow' | 'deny'
    include?: string
}

export interface NetworkPolicy {
    rules: NetworkPolicyRule[]
}

export type ExecStdin = string | Buffer | AsyncIterable<Buffer>

export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other'

export interface FsEntry {
    name: string
    type: FsEntryType
    size: number
    mtime: number
    mode: string
}

export interface ExecOptions {
    cmd: string[]
    env?: Record<string, string>
    dir?: string
    stdin?: ExecStdin
    tty?: boolean
    rows?: number
    cols?: number
    timeoutMs?: number
    /**
     * Connection-liveness heartbeat. The sprite exec server never pings and emits
     * no data during a quiet command, but reliably answers a client ws.ping() with
     * a pong. When keepAliveMs is set we ping on that cadence; when livenessTimeoutMs
     * is set we arm a watchdog (reset by every inbound frame AND pong) that fails the
     * stream only if the peer goes fully silent that long. timeoutMs stays an absolute
     * backstop that is never reset. Both unset = pure wall-clock behavior.
     */
    keepAliveMs?: number
    livenessTimeoutMs?: number
    /**
     * Maps to the `max_run_after_disconnect` exec query param: how long the
     * sprite keeps the process alive after the WSS client disconnects (platform
     * default kills non-TTY processes after 10s). Setting it also opts in to a
     * best-effort REST kill on abort()/timeoutMs expiry, so intentional
     * terminations don't leave a detached process keeping the sprite awake
     * (billing) for the full window; transient disconnects never kill.
     */
    maxRunAfterDisconnectSeconds?: number
    /**
     * When true, bypass UTF-8 decoding of stdout/stderr and pass bytes through
     * as latin1 strings (each char = one byte). Callers convert back with
     * Buffer.from(chunk, 'latin1'). Required for binary payloads (file reads,
     * non-text HTTP bodies) because UTF-8 decoding replaces invalid bytes.
     */
    binary?: boolean
    /**
     * ExecResult buffer mode. 'full' (default) accumulates the whole
     * stdout/stderr into the result — one-shot execSprite/file-io callers read
     * output only from there. 'tail' keeps just a bounded tail for error
     * reporting: streaming consumers already read the full output from the
     * stdout/stderr iterators, and duplicating it in the result doubles memory
     * for the whole turn.
     */
    capture?: 'full' | 'tail'
    /**
     * Reconnect a dropped socket by attaching to the still-running session
     * (`?id=<session>`) instead of failing the stream. The attach replays the
     * full stdout history; the client skips the bytes it already consumed, so
     * output is byte-exact across the drop and the exit/result still arrives.
     * Only applies to non-TTY execs whose stdin EOF was fully sent; stderr
     * produced during the gap is lost (not in the platform scrollback).
     * Requires maxRunAfterDisconnectSeconds so the process survives the gap.
     */
    reattach?: { maxAttempts?: number }
    /**
     * Retry the INITIAL connect (before any connection has ever opened) on a
     * transient handshake status or transport error, with bounded backoff.
     * Opt-in because a retry replays the exec URL: the platform does not
     * guarantee a failed upgrade never started the command, so a retry may
     * run it twice. Only enable for commands that are safe to replay.
     * Once a connection has opened, `reattach` owns recovery instead.
     */
    initialConnectRetry?: { maxAttempts?: number }
    /**
     * Invoked once with the exec session id as soon as it is known (the
     * platform's session_info frame arrives before any stdout). Lets a caller
     * persist the id so a DIFFERENT process can later check the session's
     * liveness (listExecSessions). Fires on the first session_info only.
     */
    onSessionId?: (sessionId: string) => void
}

export interface ExecResult {
    exitCode: number
    stdout: string
    stderr: string
    sessionId?: string
}

export interface ExecSessionInfo {
    id: string
    command?: string
    workdir?: string
    created?: string
    last_activity?: string
    is_active?: boolean
    tty?: boolean
    bytes_per_second?: number
}

export interface SpritesLogger {
    debug: (msg: string, meta?: Record<string, unknown>) => void
    info: (msg: string, meta?: Record<string, unknown>) => void
    warn: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
}

export interface SpritesClientOptions {
    baseUrl?: string
    wsBaseUrl?: string
    token: string
    accountSlug?: string
    logger?: SpritesLogger
    fetchImpl?: typeof fetch
    requestTimeoutMs?: number
}
