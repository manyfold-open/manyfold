import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import type {
    DaemonHerdrFramework,
    DaemonHerdrOpenResult,
    DaemonHerdrUpdateResult,
    DaemonOwnedTerminal
} from '@manyfold/shared'

// herdr (https://herdr.dev) is a terminal workspace manager for coding agents
// that runs on the user's own machine. Its server speaks newline-delimited
// JSON over a local unix socket: one `{id, method, params}` request per
// line, one `{id, result}` or `{id, error}` reply, and pushed `{event, data}`
// envelopes on a connection that subscribed to events. This module is the
// daemon's whole knowledge of it (ADR-0031): finding the binary, talking to
// the socket, opening a chat session's framework TUI in a pane named after
// the session, listing herdr-hosted terminals in the inventory the API reads
// as their proof of life, and closing them when the API asks.
//
// herdr's shape mirrors the web's: a workspace per Manyfold agent (labelled
// with the agent's name), a tab per chat session (labelled with its title),
// one pane running the TUI. Agent names in herdr are machine handles
// (`[a-z][a-z0-9_-]{0,31}`), so the human title lives on the tab and pane.

export const HERDR_BINARY = 'herdr'
export const HERDR_METADATA_SOURCE = 'manyfold'
// herdr accepts 3 s < timeout <= 300 s for an agent start; a cold `claude`
// on a slow disk takes a while to draw its prompt.
export const HERDR_AGENT_START_TIMEOUT_MS = 60_000
// herdr answers agent_pane_busy while a new pane's shell is still coming up
// ("not an available shell"), even after process_info shows the shell alone.
// Seen on macOS dev [2026-09-22]: a workspace created a second after its
// predecessor closed refused the first start. The start is asked again a few
// times before that counts as a failure.
export const HERDR_AGENT_START_BUSY_RETRIES = 8
export const HERDR_AGENT_START_BUSY_DELAY_MS = 400
const CALL_TIMEOUT_MS = 10_000
const PING_TIMEOUT_MS = 3_000
const SHELL_PROMPT_WAIT_MS = 5_000
const SHELL_PROMPT_POLL_MS = 200
// How often the watcher asks herdr whether each hosted TUI is still running,
// and how young a terminal must be before its shell reading as idle counts
// as the TUI having quit rather than not having started yet.
export const HERDR_POLL_INTERVAL_MS = 3_000
export const HERDR_EXIT_MIN_UPTIME_MS = 5_000
// herdr's live handoff (its own update) closes every socket for a moment
// and panes survive it; forgetting terminals on the first refused connect
// would release holds over TUIs that are still running.
const UNREACHABLE_POLLS_BEFORE_FORGET = 5
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export const HERDR_KIND_BY_FRAMEWORK: Record<DaemonHerdrFramework, string> = {
    'claude-code': 'claude',
    codex: 'codex'
}

export const isHerdrFramework = (
    value: unknown
): value is DaemonHerdrFramework => value === 'claude-code' || value === 'codex'

export class HerdrError extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message)
        this.name = 'HerdrError'
    }
}

// The daemon's ack carries one string; the API reads the code before the
// colon and maps it to its own error codes.
export const herdrErrorString = (err: unknown): string =>
    err instanceof HerdrError
        ? `${err.code}: ${err.message}`
        : `herdr_launch_failed: ${(err as Error).message}`

// The default session's socket, or the one the environment names: herdr
// itself resolves `HERDR_SOCKET_PATH`, then a named session, then the
// default, and the daemon follows the same order so a machine that runs the
// daemon under a named herdr session lands in that session.
export const herdrSocketPath = (
    env: NodeJS.ProcessEnv = process.env
): string => {
    if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH
    const configDir = env.HERDR_CONFIG_PATH
        ? dirname(env.HERDR_CONFIG_PATH)
        : join(homedir(), '.config', HERDR_BINARY)
    return env.HERDR_SESSION
        ? join(configDir, 'sessions', env.HERDR_SESSION, 'herdr.sock')
        : join(configDir, 'herdr.sock')
}

export interface HerdrDetection {
    path: string
    // From `herdr --version` ("herdr 0.9.1"); null when the binary would
    // not answer.
    version: string | null
}

const VERSION_TIMEOUT_MS = 5_000
const UPDATE_TIMEOUT_MS = 180_000
const SERVER_START_WAIT_MS = 8_000

const runHerdr = (
    binary: string,
    args: string[],
    timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (exitCode: number | null): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ exitCode, stdout, stderr })
        }
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL')
            } catch {}
            finish(null)
        }, timeoutMs)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk
        })
        child.on('error', () => finish(null))
        child.on('close', (code) => finish(code))
    })

export const parseHerdrVersion = (output: string): string | null => {
    const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(output)
    return match ? match[1] : null
}

const herdrVersionOf = async (binary: string): Promise<string | null> => {
    const result = await runHerdr(binary, ['--version'], VERSION_TIMEOUT_MS)
    return result.exitCode === 0 ? parseHerdrVersion(result.stdout) : null
}

let lastDetection: HerdrDetection | null = null

// Installed or not: PATH (augmented from the login shell at daemon start,
// which is where `~/.local/bin` usually comes from) plus herdr's own default
// install location. Whether its server is running is a question for the
// moment a handoff is asked for, not for the capability flag. The result is
// kept for the heartbeat and refreshed on the framework-detect cadence and
// after an update.
export const detectHerdr = async (): Promise<HerdrDetection | null> => {
    lastDetection = await probeHerdr()
    return lastDetection
}

export const currentHerdr = (): HerdrDetection | null => lastDetection

const probeHerdr = async (): Promise<HerdrDetection | null> => {
    if (process.platform === 'win32') return null
    const candidates = (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, HERDR_BINARY))
    candidates.push(join(homedir(), '.local', 'bin', HERDR_BINARY))
    for (const candidate of candidates) {
        try {
            await access(candidate)
        } catch {
            continue
        }
        return { path: candidate, version: await herdrVersionOf(candidate) }
    }
    return null
}

// herdr's own updater (`herdr update`), for the Update Center (ADR-0031).
// The version it left behind is re-probed so the next heartbeat carries it.
export const updateHerdr = async (): Promise<DaemonHerdrUpdateResult> => {
    const before = lastDetection ?? (await detectHerdr())
    if (!before)
        return {
            ok: false,
            fromVersion: null,
            toVersion: null,
            error: 'herdr is not installed on this machine'
        }
    const result = await runHerdr(before.path, ['update'], UPDATE_TIMEOUT_MS)
    const after = await detectHerdr()
    const ok = result.exitCode === 0
    return {
        ok,
        fromVersion: before.version,
        toVersion: after?.version ?? null,
        ...(ok
            ? {}
            : {
                  error:
                      result.exitCode === null
                          ? 'herdr update timed out'
                          : `herdr update exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`
              })
    }
}

// Start herdr's server headless when a handoff finds none. Only where the
// daemon owns the environment (a platform runner inside a sandbox); on a
// self-owned computer the user's herdr is theirs to start.
const startHerdrServer = async (
    socketPath: string,
    binary: string
): Promise<void> => {
    const child = spawn(binary, ['server'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, HERDR_SOCKET_PATH: socketPath }
    })
    // A binary that vanished since detection surfaces as the wait below
    // running out, not as an unhandled 'error' event taking the daemon down.
    child.on('error', () => {})
    child.unref()
    const deadline = Date.now() + SERVER_START_WAIT_MS
    while (Date.now() < deadline) {
        try {
            await herdrCall(
                'ping',
                {},
                { socketPath, timeoutMs: PING_TIMEOUT_MS }
            )
            return
        } catch {}
        await new Promise((resolve) =>
            setTimeout(resolve, SHELL_PROMPT_POLL_MS)
        )
    }
    throw new HerdrError(
        'herdr_not_running',
        `herdr server did not come up on ${socketPath} within ${SERVER_START_WAIT_MS}ms`
    )
}

interface HerdrReply {
    id?: string
    result?: unknown
    error?: { code?: string; message?: string }
}

const notRunning = (
    err: NodeJS.ErrnoException,
    socketPath: string
): HerdrError =>
    new HerdrError(
        'herdr_not_running',
        `herdr is not running (${err.code ?? err.message} on ${socketPath}); start it with \`herdr\``
    )

const readLines = (socket: Socket, onLine: (line: string) => void): void => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line) onLine(line)
            newline = buffer.indexOf('\n')
        }
    })
}

const connectSocket = (
    socketPath: string,
    timeoutMs: number
): Promise<Socket> =>
    new Promise((resolve, reject) => {
        const socket = createConnection(socketPath)
        const timer = setTimeout(() => {
            socket.destroy()
            reject(
                new HerdrError(
                    'herdr_not_running',
                    `herdr did not accept a connection on ${socketPath} within ${timeoutMs}ms`
                )
            )
        }, timeoutMs)
        socket.once('connect', () => {
            clearTimeout(timer)
            resolve(socket)
        })
        socket.once('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer)
            reject(notRunning(err, socketPath))
        })
    })

export interface HerdrCallOptions {
    socketPath?: string
    timeoutMs?: number
}

// One request on its own connection: herdr answers with the request's id
// and the connection is dropped. Simpler than multiplexing, and every call
// is either short or bounded by its own timeout.
export const herdrCall = async <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: HerdrCallOptions = {}
): Promise<T> => {
    const socketPath = opts.socketPath ?? herdrSocketPath()
    const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS
    const socket = await connectSocket(socketPath, timeoutMs)
    const id = `mf-${randomUUID()}`
    return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try {
                socket.destroy()
            } catch {}
            fn()
        }
        const timer = setTimeout(
            () =>
                finish(() =>
                    reject(
                        new HerdrError(
                            'timeout',
                            `herdr ${method} did not answer within ${timeoutMs}ms`
                        )
                    )
                ),
            timeoutMs
        )
        readLines(socket, (line) => {
            let reply: HerdrReply
            try {
                reply = JSON.parse(line) as HerdrReply
            } catch {
                return
            }
            if (reply.id !== id) return
            if (reply.error) {
                const error = reply.error
                finish(() =>
                    reject(
                        new HerdrError(
                            error.code ?? 'error',
                            error.message ?? `herdr ${method} failed`
                        )
                    )
                )
                return
            }
            finish(() => resolve((reply.result ?? {}) as T))
        })
        socket.once('error', (err: NodeJS.ErrnoException) =>
            finish(() => reject(notRunning(err, socketPath)))
        )
        socket.once('close', () =>
            finish(() =>
                reject(
                    new HerdrError(
                        'herdr_not_running',
                        `herdr closed the connection before answering ${method}`
                    )
                )
            )
        )
        socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
}

export interface HerdrEvent {
    event: string
    data: Record<string, unknown>
}

// A connection that stays open: the first line with our id acknowledges the
// subscription, every later line is a pushed event envelope.
export const herdrSubscribe = (args: {
    subscriptions: Array<Record<string, unknown>>
    socketPath?: string
    onEvent: (event: HerdrEvent) => void
    onClose: (err: Error | null) => void
}): { close: () => void } => {
    const socketPath = args.socketPath ?? herdrSocketPath()
    const id = `mf-sub-${randomUUID()}`
    let closed = false
    let acked = false
    const socket = createConnection(socketPath)
    const done = (err: Error | null): void => {
        if (closed) return
        closed = true
        try {
            socket.destroy()
        } catch {}
        args.onClose(err)
    }
    socket.once('connect', () => {
        socket.write(
            `${JSON.stringify({
                id,
                method: 'events.subscribe',
                params: { subscriptions: args.subscriptions }
            })}\n`
        )
    })
    readLines(socket, (line) => {
        let message: HerdrReply & { event?: unknown; data?: unknown }
        try {
            message = JSON.parse(line) as typeof message
        } catch {
            return
        }
        if (!acked) {
            if (message.id !== id) return
            if (message.error)
                done(
                    new HerdrError(
                        message.error.code ?? 'error',
                        message.error.message ?? 'events.subscribe failed'
                    )
                )
            else acked = true
            return
        }
        if (typeof message.event === 'string')
            args.onEvent({
                event: message.event,
                data:
                    message.data && typeof message.data === 'object'
                        ? (message.data as Record<string, unknown>)
                        : {}
            })
    })
    socket.once('error', (err: NodeJS.ErrnoException) =>
        done(notRunning(err, socketPath))
    )
    socket.once('close', () => done(null))
    return { close: () => done(null) }
}

interface HerdrTerminal {
    terminalId: string
    paneId: string
    tabId: string
    workspaceId: string
    startedAt: number
    // A profile-bound agent's context is held for as long as the pane
    // lives, like a pty under a profile.
    release: (() => Promise<void>) | null
    socketPath: string
}

const terminals = new Map<string, HerdrTerminal>()
// This daemon's registration (its daemon uuid): the panes it opens carry it,
// so it adopts and reuses only its own when several daemon profiles on one
// machine talk to the same herdr.
let paneOwner: string | null = null
let inventoryListener: (() => void) | null = null
let log: (message: string) => void = () => {}
let pollIntervalMs = HERDR_POLL_INTERVAL_MS
let exitMinUptimeMs = HERDR_EXIT_MIN_UPTIME_MS

// Who to tell when the set of herdr-hosted terminals changes (the daemon
// sends a heartbeat right away, so the API ends the row and releases the
// hold within a second of the TUI quitting instead of at the next tick).
export const configureHerdr = (opts: {
    onInventoryChange?: () => void
    log?: (message: string) => void
    owner?: string
    // Test seam: the watcher's cadence, in real seconds otherwise.
    timing?: { pollIntervalMs?: number; exitMinUptimeMs?: number }
}): void => {
    if (opts.onInventoryChange) inventoryListener = opts.onInventoryChange
    if (opts.log) log = opts.log
    if (opts.owner) paneOwner = opts.owner
    if (opts.timing?.pollIntervalMs) pollIntervalMs = opts.timing.pollIntervalMs
    if (opts.timing?.exitMinUptimeMs !== undefined)
        exitMinUptimeMs = opts.timing.exitMinUptimeMs
}

export const herdrTerminalCount = (): number => terminals.size

export const herdrTerminal = (
    terminalId: string
): { paneId: string; tabId: string; workspaceId: string } | null => {
    const t = terminals.get(terminalId)
    return t
        ? { paneId: t.paneId, tabId: t.tabId, workspaceId: t.workspaceId }
        : null
}

// In the inventory the daemon sends with hello and heartbeat, a herdr-hosted
// terminal reads like an owned one: the user is looking at it in herdr, so
// it is attached for as long as it is listed.
export const listHerdrTerminals = (): DaemonOwnedTerminal[] =>
    [...terminals.values()].map((t) => ({
        terminalId: t.terminalId,
        attached: true,
        startedAt: new Date(t.startedAt).toISOString()
    }))

// ---- watcher -----------------------------------------------------------

interface PaneProcessInfo {
    pane_id?: string
    shell_pid?: number | null
    foreground_process_group_id?: number | null
    foreground_processes?: Array<{ pid: number; name: string }>
}

// The TUI has quit when nothing but the shell itself is in the pane's
// foreground.
export const paneShellIdle = (info: PaneProcessInfo): boolean => {
    const foreground = info.foreground_processes ?? []
    return foreground.every((p) => p.pid === info.shell_pid)
}

let pollTimer: NodeJS.Timeout | null = null
let polling = false
let subscription: { close: () => void } | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectDelay = RECONNECT_BASE_MS
let unreachablePolls = 0

const forget = (t: HerdrTerminal, reason: string): void => {
    if (!terminals.delete(t.terminalId)) return
    log(`herdr terminal ${t.terminalId}: ${reason}`)
    if (t.release) void t.release().catch(() => {})
    stopWatchingIfIdle()
    try {
        inventoryListener?.()
    } catch (err) {
        log(`herdr inventory listener failed: ${(err as Error).message}`)
    }
}

const closePane = async (t: HerdrTerminal): Promise<void> => {
    try {
        await herdrCall(
            'pane.close',
            { pane_id: t.paneId },
            { socketPath: t.socketPath }
        )
    } catch (err) {
        if (!(err instanceof HerdrError && err.code === 'not_found'))
            log(
                `herdr terminal ${t.terminalId}: pane.close failed: ${(err as Error).message}`
            )
    }
}

const pollOnce = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
        let unreachable = false
        for (const t of [...terminals.values()]) {
            if (!terminals.has(t.terminalId)) continue
            let info: { process_info?: PaneProcessInfo }
            try {
                info = await herdrCall<{ process_info?: PaneProcessInfo }>(
                    'pane.process_info',
                    { pane_id: t.paneId },
                    { socketPath: t.socketPath, timeoutMs: PING_TIMEOUT_MS }
                )
            } catch (err) {
                if (err instanceof HerdrError && err.code === 'not_found') {
                    forget(t, 'pane is gone')
                    continue
                }
                unreachable = true
                continue
            }
            unreachablePolls = 0
            if (
                Date.now() - t.startedAt >= exitMinUptimeMs &&
                paneShellIdle(info.process_info ?? {})
            ) {
                // The TUI quit: the pane is a bare shell nobody needs, so it
                // goes too, and the tab with it — herdr stays as tidy as the
                // web, where the terminal view is gone the moment the
                // session comes back.
                await closePane(t)
                forget(t, 'TUI exited')
            }
        }
        if (unreachable) {
            unreachablePolls += 1
            if (unreachablePolls >= UNREACHABLE_POLLS_BEFORE_FORGET) {
                for (const t of [...terminals.values()])
                    forget(t, 'herdr unreachable; its panes are gone')
                unreachablePolls = 0
            }
        }
    } finally {
        polling = false
    }
}

const onHerdrEvent = (event: HerdrEvent): void => {
    const paneId =
        typeof event.data.pane_id === 'string' ? event.data.pane_id : null
    const tabId =
        typeof event.data.tab_id === 'string' ? event.data.tab_id : null
    for (const t of [...terminals.values()]) {
        if (event.event === 'tab_closed' && tabId === t.tabId) {
            forget(t, 'tab closed')
            continue
        }
        if (paneId !== t.paneId) continue
        if (event.event === 'pane_exited' || event.event === 'pane_closed') {
            forget(
                t,
                `pane ${event.event === 'pane_exited' ? 'exited' : 'closed'}`
            )
            continue
        }
        // The agent herdr saw in the pane changed: confirm through the
        // process list before acting, a tool the TUI runs is not the TUI
        // quitting.
        if (event.event === 'pane_agent_detected') void pollOnce()
    }
}

const scheduleResubscribe = (socketPath: string): void => {
    if (reconnectTimer || terminals.size === 0) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        startSubscription(socketPath)
    }, reconnectDelay)
    reconnectTimer.unref?.()
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2)
}

const startSubscription = (socketPath: string): void => {
    if (subscription || terminals.size === 0) return
    let current: { close: () => void } | null = null
    current = herdrSubscribe({
        socketPath,
        subscriptions: [
            { type: 'pane.exited' },
            { type: 'pane.closed' },
            { type: 'tab.closed' },
            { type: 'pane.agent_detected' }
        ],
        onEvent: (event) => {
            reconnectDelay = RECONNECT_BASE_MS
            onHerdrEvent(event)
        },
        onClose: (err) => {
            if (subscription === current) subscription = null
            if (err) log(`herdr event stream closed: ${err.message}`)
            // Anything that happened while the stream was down is caught by
            // the poll; the stream only makes the common case immediate.
            scheduleResubscribe(socketPath)
        }
    })
    subscription = current
}

const ensureWatching = (socketPath: string): void => {
    if (!pollTimer) {
        pollTimer = setInterval(() => void pollOnce(), pollIntervalMs)
        pollTimer.unref?.()
    }
    startSubscription(socketPath)
}

const stopWatchingIfIdle = (): void => {
    if (terminals.size > 0) return
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    reconnectDelay = RECONNECT_BASE_MS
    unreachablePolls = 0
    subscription?.close()
    subscription = null
}

// ---- open / focus / close --------------------------------------------

// herdr agent names are handles, not titles: lowercase, 32 chars, unique
// among live agents. The terminal id's tail is unique and already in the
// right alphabet.
export const herdrAgentName = (terminalId: string): string =>
    `mf-${terminalId
        .replace(/^[a-z]+_/, '')
        .slice(-8)
        .toLowerCase()}`

interface TabCreated {
    tab?: { tab_id?: string }
    root_pane?: { pane_id?: string }
}

interface WorkspaceCreated extends TabCreated {
    workspace?: { workspace_id?: string }
}

interface HerdrPaneInfo {
    pane_id?: string
    tab_id?: string
    workspace_id?: string
    tokens?: Record<string, string> | null
}

// What a pane this daemon opened carries in herdr's metadata tokens: the
// conversation it resumes, the terminal row it belongs to, the daemon that
// opened it and when. A later handoff of the same conversation finds its
// tab by the first; a restarted daemon finds its panes by the rest.
const TOKEN_CHAT = 'mf_chat'
const TOKEN_TERMINAL = 'mf_terminal'
const TOKEN_OWNER = 'mf_owner'
const TOKEN_STARTED = 'mf_started'
const OWNED_TERMINAL_ID = /^tms_[a-z0-9]{26}$/

const ownedByThisDaemon = (pane: HerdrPaneInfo): boolean => {
    const owner = pane.tokens?.[TOKEN_OWNER]
    return !paneOwner || !owner || owner === paneOwner
}

const listPanes = async (
    call: <T>(method: string, params: Record<string, unknown>) => Promise<T>,
    workspaceId?: string
): Promise<HerdrPaneInfo[]> => {
    const listed = await call<{ panes?: HerdrPaneInfo[] }>(
        'pane.list',
        workspaceId ? { workspace_id: workspaceId } : {}
    )
    return listed.panes ?? []
}

// A daemon that restarts (an upgrade, a sandbox runner brought back after a
// suspension) forgets the panes it opened while herdr keeps them, TUIs and
// all. Seen on a sprites sandbox [2026-09-22]: every runner restart left
// its panes behind, holds released, and each new handoff added a tab.
// Adopting the panes it tagged before the first inventory goes out keeps
// their holds and lets pty.close and the poll reach them again.
export const adoptHerdrPanes = async (
    opts: { socketPath?: string } = {}
): Promise<number> => {
    const socketPath = opts.socketPath ?? herdrSocketPath()
    const call = <T>(
        method: string,
        params: Record<string, unknown>
    ): Promise<T> =>
        herdrCall<T>(method, params, { socketPath, timeoutMs: PING_TIMEOUT_MS })
    try {
        await call('ping', {})
    } catch {
        return 0
    }
    let adopted = 0
    for (const pane of await listPanes(call).catch(() => [])) {
        const terminalId = pane.tokens?.[TOKEN_TERMINAL]
        if (
            !terminalId ||
            !OWNED_TERMINAL_ID.test(terminalId) ||
            terminals.has(terminalId) ||
            !pane.pane_id ||
            !ownedByThisDaemon(pane)
        )
            continue
        const started = Date.parse(pane.tokens?.[TOKEN_STARTED] ?? '')
        terminals.set(terminalId, {
            terminalId,
            paneId: pane.pane_id,
            tabId: pane.tab_id ?? '',
            workspaceId: pane.workspace_id ?? '',
            startedAt: Number.isFinite(started) ? started : Date.now(),
            release: null,
            socketPath
        })
        adopted += 1
    }
    if (adopted > 0) {
        log(`herdr: adopted ${adopted} pane(s) opened before this start`)
        ensureWatching(socketPath)
    }
    return adopted
}

const waitForShellPrompt = async (
    call: <T>(
        method: string,
        params: Record<string, unknown>,
        timeoutMs?: number
    ) => Promise<T>,
    paneId: string
): Promise<void> => {
    const deadline = Date.now() + SHELL_PROMPT_WAIT_MS
    while (Date.now() < deadline) {
        try {
            const { process_info } = await call<{
                process_info?: PaneProcessInfo
            }>('pane.process_info', { pane_id: paneId }, PING_TIMEOUT_MS)
            if (process_info?.shell_pid != null && paneShellIdle(process_info))
                return
        } catch {}
        await new Promise((resolve) =>
            setTimeout(resolve, SHELL_PROMPT_POLL_MS)
        )
    }
}

export interface OpenInHerdrArgs {
    terminalId: string
    framework: DaemonHerdrFramework
    command: string[]
    cwd: string
    env: Record<string, string>
    title: string
    agentName: string
    chatSessionId?: string | null
    release?: (() => Promise<void>) | null
    socketPath?: string
    // Start herdr's server if none answers (platform runners only).
    autoStartServer?: boolean
}

// Open a chat session's TUI in herdr: find (or create) the agent's
// workspace, add a tab for the session with the platform's env on its
// shell, start the framework CLI in it through herdr's own agent surface so
// herdr knows what is running, label it, raise it, and remember it so the
// inventory and pty.close can reach it.
export const openInHerdr = async (
    args: OpenInHerdrArgs
): Promise<DaemonHerdrOpenResult> => {
    const socketPath = args.socketPath ?? herdrSocketPath()
    const call = <T>(
        method: string,
        params: Record<string, unknown>,
        timeoutMs?: number
    ): Promise<T> => herdrCall<T>(method, params, { socketPath, timeoutMs })

    const kind = HERDR_KIND_BY_FRAMEWORK[args.framework]
    const [binary, ...agentArgs] = args.command
    if (!binary || basename(binary) !== kind)
        throw new HerdrError(
            'herdr_launch_failed',
            `the command must run ${kind}, got ${binary ?? 'nothing'}`
        )
    const title = args.title.trim() || args.agentName.trim() || 'Manyfold chat'
    const workspaceLabel = args.agentName.trim() || 'Manyfold'

    try {
        await call('ping', {}, PING_TIMEOUT_MS)
    } catch (err) {
        const binary = lastDetection?.path ?? HERDR_BINARY
        if (
            !args.autoStartServer ||
            !(err instanceof HerdrError && err.code === 'herdr_not_running')
        )
            throw err
        log(`herdr server not running on ${socketPath}; starting it`)
        await startHerdrServer(socketPath, binary)
    }

    const listed = await call<{
        workspaces?: Array<{ workspace_id?: string; label?: string }>
    }>('workspace.list', {})
    const existing = (listed.workspaces ?? []).find(
        (w) => w.label === workspaceLabel && typeof w.workspace_id === 'string'
    )
    let workspaceId = ''
    let tabId = ''
    let paneId = ''
    // The conversation's earlier panes in the agent's workspace are stale
    // by construction (the API asks for a handoff only when nothing holds
    // the session), so the new TUI takes the first one's tab, in the place
    // it already has, and all of them close: one tab per conversation,
    // however many times it is handed over.
    const stale =
        existing?.workspace_id && args.chatSessionId
            ? (
                  await listPanes(call, existing.workspace_id).catch(() => [])
              ).filter(
                  (p) =>
                      p.tokens?.[TOKEN_CHAT] === args.chatSessionId &&
                      typeof p.pane_id === 'string' &&
                      ownedByThisDaemon(p)
              )
            : []
    if (existing?.workspace_id && stale.length > 0) {
        const split = await call<{ pane?: HerdrPaneInfo }>('pane.split', {
            target_pane_id: stale[0].pane_id,
            direction: 'right',
            cwd: args.cwd,
            env: args.env,
            focus: false
        }).catch(() => null)
        if (split?.pane?.pane_id && split.pane.tab_id) {
            workspaceId = existing.workspace_id
            tabId = split.pane.tab_id
            paneId = split.pane.pane_id
            for (const old of stale) {
                for (const t of [...terminals.values()])
                    if (t.paneId === old.pane_id)
                        forget(t, 'replaced by a new handoff')
                await call('pane.close', { pane_id: old.pane_id }).catch(
                    () => {}
                )
            }
            await call('tab.rename', { tab_id: tabId, label: title }).catch(
                () => {}
            )
            log(
                `herdr: ${args.chatSessionId} takes over ${tabId}, closing ${stale.length} stale pane(s)`
            )
        }
    }
    if (paneId) {
        // Took over the conversation's tab above.
    } else if (existing?.workspace_id) {
        workspaceId = existing.workspace_id
        const created = await call<TabCreated>('tab.create', {
            workspace_id: workspaceId,
            cwd: args.cwd,
            env: args.env,
            label: title,
            focus: false
        })
        tabId = created.tab?.tab_id ?? ''
        paneId = created.root_pane?.pane_id ?? ''
    } else {
        const created = await call<WorkspaceCreated>('workspace.create', {
            cwd: args.cwd,
            env: args.env,
            label: workspaceLabel,
            focus: false
        })
        workspaceId = created.workspace?.workspace_id ?? ''
        tabId = created.tab?.tab_id ?? ''
        paneId = created.root_pane?.pane_id ?? ''
        if (tabId)
            await call('tab.rename', { tab_id: tabId, label: title }).catch(
                () => {}
            )
    }
    if (!paneId)
        throw new HerdrError(
            'herdr_launch_failed',
            'herdr created no pane for the session'
        )
    // One instant for the pane's token and the inventory, so a restarted
    // daemon adopts the terminal with the start time the API already has.
    const startedAt = Date.now()

    try {
        await waitForShellPrompt(call, paneId)
        for (let attempt = 0; ; attempt += 1) {
            try {
                await call(
                    'agent.start',
                    {
                        name: herdrAgentName(args.terminalId),
                        kind,
                        pane_id: paneId,
                        args: agentArgs,
                        timeout_ms: HERDR_AGENT_START_TIMEOUT_MS
                    },
                    HERDR_AGENT_START_TIMEOUT_MS + PING_TIMEOUT_MS
                )
                break
            } catch (err) {
                // Blocked during startup (a folder-trust prompt, a login) is
                // still the TUI running in the pane; the user answers it
                // there.
                if (err instanceof HerdrError && err.code === 'agent_not_ready')
                    break
                if (
                    err instanceof HerdrError &&
                    err.code === 'agent_pane_busy' &&
                    attempt < HERDR_AGENT_START_BUSY_RETRIES
                ) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, HERDR_AGENT_START_BUSY_DELAY_MS)
                    )
                    await waitForShellPrompt(call, paneId)
                    continue
                }
                throw err
            }
        }
        await call('pane.rename', { pane_id: paneId, label: title }).catch(
            () => {}
        )
        await call('pane.report_metadata', {
            pane_id: paneId,
            source: HERDR_METADATA_SOURCE,
            title,
            tokens: {
                [TOKEN_TERMINAL]: args.terminalId,
                [TOKEN_STARTED]: new Date(startedAt).toISOString(),
                ...(args.chatSessionId
                    ? { [TOKEN_CHAT]: args.chatSessionId }
                    : {}),
                ...(paneOwner ? { [TOKEN_OWNER]: paneOwner } : {})
            }
        }).catch(() => {})
    } catch (err) {
        await call('pane.close', { pane_id: paneId }).catch(() => {})
        throw err instanceof HerdrError
            ? new HerdrError(
                  'herdr_launch_failed',
                  `${err.code}: ${err.message}`
              )
            : err
    }

    const focused = await call('pane.focus', { pane_id: paneId }).then(
        () => true,
        () => false
    )
    await call('notification.show', {
        title: `Manyfold · ${title}`,
        body: 'This conversation moved here from the web. Quit the TUI to hand it back.',
        sound: 'request'
    }).catch(() => {})

    terminals.set(args.terminalId, {
        terminalId: args.terminalId,
        paneId,
        tabId,
        workspaceId,
        startedAt,
        release: args.release ?? null,
        socketPath
    })
    log(
        `herdr terminal ${args.terminalId}: opened ${kind} in ${paneId} (${workspaceLabel} / ${title})`
    )
    ensureWatching(socketPath)
    try {
        inventoryListener?.()
    } catch {}
    return { paneId, tabId, workspaceId, focused }
}

export const focusHerdrTerminal = async (
    terminalId: string
): Promise<{ focused: boolean }> => {
    const t = terminals.get(terminalId)
    if (!t)
        throw new HerdrError('not_found', 'this terminal is not open in herdr')
    try {
        await herdrCall(
            'pane.focus',
            { pane_id: t.paneId },
            { socketPath: t.socketPath }
        )
    } catch (err) {
        if (err instanceof HerdrError && err.code === 'not_found')
            forget(t, 'pane is gone')
        throw err
    }
    // No notification here, unlike a handoff: focus follows the web moving
    // between conversations herdr holds, several times a minute, and a
    // toast with a sound in the user's own herdr on every one is noise.
    return { focused: true }
}

// Close on the API's word (a release from the chat view, a takeover, the
// reaper): the pane goes, the TUI with it, and the inventory drops the
// terminal.
export const closeHerdrTerminal = async (
    terminalId: string
): Promise<boolean> => {
    const t = terminals.get(terminalId)
    if (!t) return false
    await closePane(t)
    forget(t, 'closed on request')
    return true
}

// Test seam: forget everything without touching herdr.
export const resetHerdrForTest = (): void => {
    terminals.clear()
    stopWatchingIfIdle()
    inventoryListener = null
    paneOwner = null
    log = () => {}
    pollIntervalMs = HERDR_POLL_INTERVAL_MS
    exitMinUptimeMs = HERDR_EXIT_MIN_UPTIME_MS
}
