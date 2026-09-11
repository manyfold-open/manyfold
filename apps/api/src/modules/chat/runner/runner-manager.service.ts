import { DEFAULT_API_BASE_URL } from '@/common/brand'
import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import {
    RUNNER_PROFILE,
    DAEMON_MIN_CLI_VERSION,
    isCliVersionTooOld,
    podRunnerHostName,
    profilePaths,
    runnerHostName
} from '@manyfold/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import { runtimeHosts, type Database } from '@manyfold/db'
import {
    pickRunnerHostRow,
    staleRunnerTwins
} from '@/modules/chat/runner/runner-host-rows'
import { SpritesError } from '@manyfold/sprites'
import { resolveMfDeployEnv } from '@/common/deploy-env'
import { DRIZZLE } from '@/db/tokens'
import {
    buildCliInstallScript,
    cliInstallChannelForDeployEnv
} from '@/modules/agent-self/sprite-shell-env.service'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'

// Bring an agent's sprite-side runner up so a turn can be dispatched through
// the daemon protocol instead of a bare sprite exec.
//
// Measured on a real sprite 2026-07-24: two probe results shape everything
// here.
//   - a reverse WSS from inside a sprite to the API works (GET /api/daemon/ws
//     answers 101), and `mf daemon` runs there — but the sprite has no systemd,
//     so the runner has to be started detached, by us;
//   - the WSS CANNOT survive sprite suspension: a frozen process misses pings
//     and the API drops it (`ws closed code=4000 reason=pong timeout`) while the
//     process is still alive. So a runner is NOT durably resident: every
//     dispatch has to wake the sprite and wait for the runner to reconnect.
//
// That is why this is a "manager" and not a provisioning step: ensureRunner()
// is called on the turn path, is expected to be a no-op fast path most of the
// time, and returns null rather than throwing so the caller keeps using today's
// sprite exec. A runner that cannot be brought up must degrade, never fail a turn.

// ADR-0014: the runner's reserved profile name and its on-disk layout come
// from @manyfold/shared profile-paths — the same source the CLI builds the
// paths from, so probe and reality cannot drift. Only the CONTROL PLANE is
// profile-scoped; the data plane the runner manages is the machine-scoped
// shared roots, which is the CLI's registration default — nothing to declare.
export { RUNNER_PROFILE, runnerHostName }
const RUNNER_PROBE_PATH = profilePaths(
    '$HOME/.manyfold',
    RUNNER_PROFILE
).daemonConfigPath

// The runner token authenticates EVERY websocket connect through its bearer
// header, not just the one-off register — a short TTL therefore bricks the runner
// a day later, which is exactly what happened on staging: `ws closed code=4401
// reason=unauthorized`, and inspectSprite kept reporting registered=1 so it
// never re-registered. Match the user-daemon default instead.
const TOKEN_TTL_DAYS = 90
// Measured on staging: a fresh register + start reconnects at ~60-75s (the CLI
// re-detects frameworks on register, then boots and dials). 45s gave up just
// before the runner arrived — the turn fell back and the runner then sat there
// connected with nothing holding the sprite awake.
const DEFAULT_WAIT_ONLINE_MS = 120_000
const POLL_INTERVAL_MS = 500
// The awake lease bounds the leak when the owning instance dies mid-turn: the
// sprite keeps executing (that is the whole point) but suspends on its own soon
// after. Renewed at a third of the TTL so a single failed renew is not fatal.
const AWAKE_TTL = '30m'
const AWAKE_RENEW_MS = 10 * 60_000
// A stale runner connection can sit inside the presence grace window looking
// online while its websocket generation is frozen (sprite suspended mid-ping)
// or already closed. The registry's generic 30s RPC default turned that into a
// 30s stall before the direct-sprite fallback on every affected turn — 8 of 10
// production fallbacks took 29–30.1s (#592). workspace.ensure is a filesystem
// check on the daemon and a live connection answers it in milliseconds, so a
// short setup deadline converts a dead generation into a fast fallback.
const WORKSPACE_ENSURE_TIMEOUT_MS = 5_000
// What the inspect got before a caller could bound it. Kept as the default so a
// caller without an exec-health budget behaves exactly as it did.
const DEFAULT_INSPECT_TIMEOUT_MS = 60_000
// After the sandbox CLI upgrade restarts the runner, how long to wait for the
// restarted process's first heartbeat to carry the installed version (that
// heartbeat is the write that moves cliVersion and clientFeatures). Bounded by
// the caller's budget, not by a measurement: the upgrade request already spends
// up to 180s on the install, and a wait that runs out only means the host row
// catches up a little later. A fresh register+start reconnects at ~60-75s (see
// DEFAULT_WAIT_ONLINE_MS); a restart skips the register.
const RESTART_WAIT_MS = 45_000
const STATUS_PROBE_TIMEOUT_MS = 30_000
// After a wake exec thawed a registered runner whose socket the API had already
// dropped, how long its own reconnect gets before the process is restarted.
// The daemon's ws client forces a reconnect when it detects the clock jump a
// suspension leaves behind, and its backoff starts at 1s, so a live process is
// back on a fresh lease within a few seconds; a process that is not back by
// then is wedged or gone, and `daemon stop; daemon start` is what helps.
const WAKE_RECONNECT_WAIT_MS = 15_000
// How long a runner woken for an account operation (not a turn) is held awake.
// Long enough for the sign-in / key / pick sequence the user just started, and
// for a freshly started daemon to dial in (~60-75s), short enough that a wake
// nobody follows up on stops billing within minutes. Renewed by every
// subsequent wake, never by a timer: the TTL is the whole leak bound.
export const AUTH_AWAKE_TTL = '5m'

export interface SpriteExecFn {
    (args: {
        cmd: string[]
        stdin?: string
        timeoutMs: number
    }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export interface EnsureRunnerArgs {
    agentId: string
    userId: string
    spriteName: string
    exec: SpriteExecFn
    workspacePath?: string | null
    waitOnlineMs?: number
    // Daemon client features the turn cannot run without (a profile-bound
    // agent needs auth-context.v1). An online runner lacking one is reported
    // unavailable rather than handed out — the direct-exec fallback then
    // refuses too, so the wrong sign-in never answers.
    requiredFeatures?: readonly string[]
    // The budget for the INSPECT, the first exec of the turn and the one a dead
    // exec endpoint surfaces on. The caller passes its exec-health budget here
    // so the endpoint's own fault is bounded by a health deadline instead of by
    // a command deadline (#730): 60s meant the fault took 39s to notice and 39s
    // more for the direct fallback to re-prove it. Absent = the historical 60s,
    // so a caller that has no health budget is unchanged.
    firstExecTimeoutMs?: number
}

export interface SpriteAwakeHold {
    // Turn reached a terminal: stop renewing and drop the lease now.
    release: () => Promise<void>
    // Turn was handed off mid-flight: stop renewing, leave the lease to expire.
    detach: () => void
}

export interface RunnerHandle {
    daemonId: string
    // false when the runner was already connected (the common case).
    started: boolean
    // The rpc-lease generation the handle was resolved against
    // (`instance:connectedAtMs`), null while the lease is mid-reconnect.
    // Telemetry-only (#619): correlates a dispatch outcome with the socket
    // generation the resolution actually aimed at.
    generation: string | null
}

export type RunnerFallbackReason =
    | 'runner_unavailable'
    | 'sprite_exec_unavailable'
    | 'workspace_timeout'
    | 'workspace_connection_closed'
    | 'workspace_error'
    // hermes only, decided by the caller: the runner came up but its daemon
    // does not advertise turn.hermes, so it cannot own the ACP client.
    | 'runner_missing_turn_rpc'
    // pod only: the daemon in the image is older than the runner floor. A
    // sprite runner below the floor is reinstalled; nothing reinstalls a pod's,
    // so the turn stays on pod-exec until the image moves.
    | 'runner_cli_too_old'

// How the sprite's exec endpoint refused the runner inspect, when the refusal is
// about the endpoint itself rather than about the command it was asked to run.
// The vocabulary is the one sandbox-exec-health already probes for — 5xx
// handshake, transport error, timeout — because it describes the same three ways
// a sprite backend fails to give us a socket.
export type RunnerExecFailureClass =
    | 'handshake_5xx'
    | 'transport_error'
    | 'timeout'

export interface RunnerExecFailure {
    failureClass: RunnerExecFailureClass
    // Only a status-carrying handshake failure has one; a bare transport error
    // never invents it.
    upstreamStatus?: number
}

export type WorkspacePreflightOutcome =
    | 'none' // no custom workspace: nothing to register
    | 'base' // under the runner-managed root: registered by construction
    | 'cached' // already ensured within this daemon generation
    | 'ensured' // workspace.ensure ran and succeeded
    | 'failed' // workspace.ensure failed: the turn falls back

// Why ensureRunner reports more than a handle: `fallback` with a large
// durationMs was the only production signal for #592, and it could not say
// WHICH edge fell back — a frozen socket eating the RPC deadline looks exactly
// like a failed bring-up. The reason + preflight outcome make the buckets
// distinguishable in chat.runner.resolve telemetry.
export interface RunnerResolution {
    handle: RunnerHandle | null
    fallbackReason?: RunnerFallbackReason
    // Present only with `sprite_exec_unavailable`: what the inspect proved about
    // the sprite exec endpoint, for the caller to quarantine on (#730).
    execFailure?: RunnerExecFailure
    workspace: { outcome: WorkspacePreflightOutcome; ensureMs?: number }
}

// What restartForInstalledCli did about the runner PROCESS after the sandbox
// CLI upgrade swapped the binary under it. Every value is a valid end state for
// the upgrade — the binary on disk is the new one regardless — and the three
// that leave the old process running ('busy', 'restart-timeout', 'failed') are
// exactly the pre-existing behaviour, now logged.
export type RunnerRestartOutcome =
    // no managed runner host for this sprite: nothing runs the old build
    | 'no-runner'
    // registered but no process: the next bring-up starts the new binary
    | 'not-running'
    // the running daemon already reports the installed version
    | 'current'
    // live exec/pty sessions: left on the old build, a turn is worth more
    | 'busy'
    // stopped, started, and the host row reports the installed version
    | 'restarted'
    // started, but the row did not report it within RESTART_WAIT_MS
    | 'restart-timeout'
    // the status probe or the restart exec itself failed
    | 'failed'

// `mf daemon status --json` as seen from the runner profile inside the sprite.
export type RunnerProcessState =
    | { kind: 'not-running' }
    // A process is there but answered no health: a daemon older than the
    // control socket. Its version and activity cannot be read from outside.
    | { kind: 'unknown' }
    | {
          kind: 'running'
          version: string | null
          activeExecs: number
          activePtys: number
      }

interface RunnerSpriteState {
    installed: boolean
    registered: boolean
    version: string | null
}

// How wakeRunner got to an answering runner, for the caller's log line. The
// handle is what matters; the outcome says which of the three ways a sprite
// suspension leaves a runner (frozen with its socket intact, frozen past the
// API's pong deadline, or gone with the VM) this call actually met.
export type RunnerWakeOutcome =
    // the API still held the socket: the thawed process answers on it
    | 'live'
    // the API had dropped the socket: the thawed process dialled back in
    | 'reconnected'
    // no process (cold VM) or a silent one: stopped, started, dialled in
    | 'restarted'
    // never registered on this sprite (or a stale binary): the turn path's
    // install/register/start
    | 'brought-up'
    // a silent process with live exec/pty sessions: not restarted under a turn
    | 'busy'
    // the wake exec itself failed: the sprite could not be reached
    | 'exec-failed'
    // started, but no fresh lease within the budget
    | 'not-online'

export interface RunnerWakeResult {
    handle: RunnerHandle | null
    outcome: RunnerWakeOutcome
}

// What prepareRunner left behind: a runner that already answers, one that
// was started and is dialling in, or the reason it could not get that far.
export type RunnerPrepareOutcome =
    | 'live'
    | 'started'
    | 'exec-failed'
    | 'install-failed'
    | 'register-failed'

// A bring-up either produced a handle or did not, and a bring-up that died on
// the exec endpoint carries WHY: the single-flight below hands this same value
// to every waiter, so a waiter cannot end up with a bare null and walk back into
// the transport the winner just proved dead.
interface RunnerBringUp {
    handle: RunnerHandle | null
    execFailure?: RunnerExecFailure
}

type RunnerInspection =
    | { state: RunnerSpriteState }
    | { state: null; execFailure?: RunnerExecFailure }

@Injectable()
export class RunnerManagerService {
    private readonly logger = new Logger(RunnerManagerService.name)
    // One in-flight bring-up per sprite: concurrent turns on the same agent must
    // not each install and register a runner.
    private readonly bringUps = new Map<string, Promise<RunnerBringUp>>()
    // Custom workspaces already registered with a runner, keyed by daemon and
    // scoped to one connection generation. The daemon keeps an ensured root
    // for the life of its process and a process restart cannot keep its
    // websocket, so a new rpc lease strictly covers every daemon-side reset
    // that could forget the path — replacing the entry on generation change
    // re-registers exactly when registration could have been lost (#592).
    private readonly ensuredWorkspaces = new Map<
        string,
        { generation: string; paths: Set<string> }
    >()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: DaemonHostService,
        private readonly tokens: DaemonTokenService,
        private readonly registry: DaemonRegistryService
    ) {}

    // Overridable in tests instead of injected: a function has no DI token, and
    // making it a constructor param broke the whole container at boot.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    async ensureRunner(args: EnsureRunnerArgs): Promise<RunnerResolution> {
        const resolved = await this.resolveOnline(args)
        const handle = resolved.handle
        if (!handle)
            return {
                handle: null,
                // `runner_unavailable` is an invitation to fall back to a direct
                // sprite exec, so it is exactly the wrong thing to say when the
                // inspect just proved that transport cannot open (#730): the
                // fallback would pay the same handshake a second time before the
                // turn reaches a terminal.
                fallbackReason: resolved.execFailure
                    ? 'sprite_exec_unavailable'
                    : 'runner_unavailable',
                ...(resolved.execFailure
                    ? { execFailure: resolved.execFailure }
                    : {}),
                workspace: { outcome: 'none' }
            }
        const workspace = await this.workspacePreflight(
            handle.daemonId,
            args.workspacePath
        )
        if (workspace.outcome === 'failed')
            return {
                handle: null,
                fallbackReason: workspace.reason,
                workspace: {
                    outcome: 'failed',
                    ensureMs: workspace.ensureMs
                }
            }
        return {
            handle,
            workspace: {
                outcome: workspace.outcome,
                ...(workspace.ensureMs !== undefined
                    ? { ensureMs: workspace.ensureMs }
                    : {})
            }
        }
    }

    // The pod twin of ensureRunner. A pod's daemon is in the image and started
    // by the entrypoint, so there is nothing to install, register or launch and
    // nothing to keep awake — the whole resolution is "is this pod's runner
    // registered and online", plus the same workspace preflight a sprite turn
    // does. Anything short of an online runner returns null and the turn takes
    // the pod-exec path it took before, which is what keeps this safe to enable
    // per agent.
    async resolvePodRunner(args: {
        userId: string
        runtimeId: string
        workspacePath?: string | null
    }): Promise<RunnerResolution> {
        const existing = await this.findRunnerHost({
            userId: args.userId,
            hostName: podRunnerHostName(args.runtimeId)
        })
        if (!existing?.online)
            return {
                handle: null,
                fallbackReason: 'runner_unavailable',
                workspace: { outcome: 'none' }
            }
        // The same floor the sprite runner enforces by reinstalling. Nothing
        // in the API checks a daemon's exec.stdin support per turn; below the
        // floor the prompt would be sent on a stdin the daemon never reads and
        // the framework would sit waiting for it. The image pins the version,
        // and the pin is operator-overridable, so this is where it is checked.
        if (isCliVersionTooOld(existing.cliVersion, DAEMON_MIN_CLI_VERSION))
            return {
                handle: null,
                fallbackReason: 'runner_cli_too_old',
                workspace: { outcome: 'none' }
            }
        const workspace = await this.workspacePreflight(
            existing.id,
            args.workspacePath,
            existing
        )
        if (workspace.outcome === 'failed')
            return {
                handle: null,
                fallbackReason: workspace.reason,
                workspace: {
                    outcome: 'failed',
                    ensureMs: workspace.ensureMs
                }
            }
        return {
            handle: {
                daemonId: existing.id,
                started: false,
                generation: existing.generation
            },
            workspace: {
                outcome: workspace.outcome,
                ...(workspace.ensureMs !== undefined
                    ? { ensureMs: workspace.ensureMs }
                    : {})
            }
        }
    }

    private async resolveOnline(
        args: EnsureRunnerArgs
    ): Promise<RunnerBringUp> {
        const existing = await this.findRunnerHost({
            userId: args.userId,
            hostName: runnerHostName(args.spriteName)
        })
        const missing = (args.requiredFeatures ?? []).filter(
            (feature) => !(existing?.clientFeatures ?? []).includes(feature)
        )
        if (existing?.online && missing.length) {
            this.logger.warn(
                `runner ${existing.id} lacks required features ${missing.join(',')} for agent ${args.agentId}`
            )
            return { handle: null }
        }
        if (existing?.online)
            return {
                handle: {
                    daemonId: existing.id,
                    started: false,
                    generation: existing.generation
                }
            }

        const inFlight = this.bringUps.get(args.spriteName)
        if (inFlight) return inFlight
        const attempt = this.bringUp(args).finally(() => {
            this.bringUps.delete(args.spriteName)
        })
        this.bringUps.set(args.spriteName, attempt)
        return attempt
    }

    // The sandbox CLI upgrade installs over ~/.local/bin/mf, but the runner is a
    // long-lived process with no supervisor: nothing re-execs it, its own
    // daemon.update refuses without an init unit, auto-update is off for a
    // manual start, and a warm sprite resume brings the OLD process back. Its
    // heartbeat keeps reporting the build it was started with — cliVersion and
    // clientFeatures alike — so every capability gate reads the pre-upgrade
    // daemon while the sandbox row says the upgrade landed.
    // Seen on staging 2026-09-10: sandbox row 0.33.1-dev…ab03120, runner row
    // 0.31.2-dev…909c84a without auth-profiles.v1, and the runtime page kept
    // asking for the CLI update the Update Center had just reported done.
    //
    // Never at the cost of a turn: a runner with live sessions is left alone,
    // and nothing here throws — the caller's upgrade already landed on disk.
    async restartForInstalledCli(args: {
        userId: string
        spriteName: string
        exec: SpriteExecFn
        installedVersion: string
        waitMs?: number
    }): Promise<RunnerRestartOutcome> {
        try {
            const existing = await this.findRunnerHost({
                userId: args.userId,
                hostName: runnerHostName(args.spriteName)
            })
            if (!existing) return 'no-runner'
            const state = await this.probeRunnerProcess(args)
            if (state.kind === 'not-running') return 'not-running'
            if (state.kind === 'running') {
                if (state.version === args.installedVersion) return 'current'
                if (state.activeExecs > 0 || state.activePtys > 0) {
                    this.logger.warn(
                        `runner busy, keeping ${state.version ?? 'unknown'} sprite=${args.spriteName} execs=${state.activeExecs} ptys=${state.activePtys}`
                    )
                    return 'busy'
                }
            }
            // 'unknown' falls through on purpose: a daemon too old to answer
            // its own control socket is the one a restart helps most.
            await this.start(args)
            const reported = await this.waitForCliVersion({
                userId: args.userId,
                spriteName: args.spriteName,
                version: args.installedVersion,
                waitMs: args.waitMs
            })
            if (!reported) {
                const tail = await this.logRunnerTail(args)
                this.logger.warn(
                    `runner did not report ${args.installedVersion} after restart sprite=${args.spriteName} daemonId=${existing.id} tail=${tail ?? '(none)'}`
                )
                return 'restart-timeout'
            }
            this.logger.log(
                `runner restarted on ${args.installedVersion} sprite=${args.spriteName} daemonId=${existing.id}`
            )
            return 'restarted'
        } catch (err) {
            this.logger.warn(
                `runner restart failed sprite=${args.spriteName} class=${errorClass(err)}`
            )
            return 'failed'
        }
    }

    // A runner that is registered but not answering, made to answer — for the
    // callers that talk to it OUTSIDE a turn (the runtime page's auth.* RPCs).
    // A turn never needs this: its own execs wake the sprite and its awake
    // lease keeps it up, so a frozen runner thaws under the turn's first RPC.
    // An auth.* call has neither, and the host row cannot tell it the runner
    // is frozen: a suspended process misses pings but keeps its 45s lease, so
    // isOnline() says yes for up to a minute after the VM went to sleep.
    // Seen on staging 2026-09-10: the runner heartbeated at :27, the sprite
    // suspended at :35, `auth.create` at :41 sat on the frozen socket for the
    // full 20s RPC timeout, twice, before the pong deadline finally dropped it.
    //
    // One exec (the inspect) resumes the VM; what happens next depends on
    // whether the API still holds the socket — and the row's lease says
    // which. Nothing here throws: no runner is a legitimate answer.
    async wakeRunner(args: {
        userId: string
        spriteName: string
        exec: SpriteExecFn
        waitOnlineMs?: number
    }): Promise<RunnerWakeResult> {
        const since = new Date()
        const hostName = runnerHostName(args.spriteName)
        try {
            const existing = await this.findRunnerHost({
                userId: args.userId,
                hostName
            })
            const inspected = await this.inspectSprite(args)
            const state = inspected.state
            if (!state) return { handle: null, outcome: 'exec-failed' }
            if (
                !existing ||
                !state.installed ||
                !state.registered ||
                isCliVersionTooOld(state.version, DAEMON_MIN_CLI_VERSION)
            ) {
                // Nothing to thaw: the sprite has never had a runner (a new
                // agent before its first turn — the "no runner yet" state) or
                // keeps a binary below the floor. Same path a turn takes.
                const up = await this.bringUp({ ...args, agentId: '-' })
                return {
                    handle: up.handle,
                    outcome: up.handle ? 'brought-up' : 'not-online'
                }
            }
            // The API still holds the socket: the process that just thawed
            // answers on it, and the next RPC is the proof. Waiting for a
            // pong here would only add up to a ping interval of latency.
            const current = await this.findRunnerHost({
                userId: args.userId,
                hostName
            })
            if (current?.online)
                return {
                    handle: {
                        daemonId: current.id,
                        started: false,
                        generation: current.generation
                    },
                    outcome: 'live'
                }
            // The socket is gone. Either the process thawed and is dialling
            // back in, or it is gone with the VM (a cold start keeps the
            // config on disk, so the inspect still says registered=1).
            const process = await this.probeRunnerProcess(args)
            if (process.kind !== 'not-running') {
                const reconnected = await this.waitForLease({
                    userId: args.userId,
                    hostName,
                    since,
                    waitMs: WAKE_RECONNECT_WAIT_MS
                })
                if (reconnected)
                    return { handle: reconnected, outcome: 'reconnected' }
                if (
                    process.kind === 'running' &&
                    (process.activeExecs > 0 || process.activePtys > 0)
                ) {
                    this.logger.warn(
                        `runner silent but busy, not restarting sprite=${args.spriteName} execs=${process.activeExecs} ptys=${process.activePtys}`
                    )
                    return { handle: null, outcome: 'busy' }
                }
            }
            await this.start(args)
            const started = await this.waitForLease({
                userId: args.userId,
                hostName,
                since,
                waitMs: args.waitOnlineMs ?? DEFAULT_WAIT_ONLINE_MS
            })
            if (!started) {
                const tail = await this.logRunnerTail(args)
                this.logger.warn(
                    `runner did not come back after wake sprite=${args.spriteName} daemonId=${existing.id} tail=${tail ?? '(none)'}`
                )
                return { handle: null, outcome: 'not-online' }
            }
            return { handle: started, outcome: 'restarted' }
        } catch (err) {
            this.logger.warn(
                `runner wake failed sprite=${args.spriteName} class=${errorClass(err)}`
            )
            return { handle: null, outcome: 'exec-failed' }
        }
    }

    // A lease the API recorded AFTER `since`: a pong or a connect from a
    // process that was demonstrably running at that moment. `online` alone is
    // the wrong test here — it is what a frozen process still passes.
    private async waitForLease(args: {
        userId: string
        hostName: string
        since: Date
        waitMs: number
    }): Promise<RunnerHandle | null> {
        const deadline = Date.now() + args.waitMs
        for (;;) {
            const host = await this.findRunnerHost({
                userId: args.userId,
                hostName: args.hostName
            })
            if (
                host?.online &&
                host.rpcLastSeenAt &&
                host.rpcLastSeenAt.getTime() > args.since.getTime()
            )
                return {
                    daemonId: host.id,
                    started: true,
                    generation: host.generation
                }
            if (Date.now() >= deadline) return null
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    // A custom workspace (CreateAgentDto.workspace on a shared sandbox) lives
    // outside the machine-scoped root the runner registered, and the daemon
    // exec guard refuses a cwd it does not know.
    // Seen on staging 2026-08-04: a claude agent co-resident on a NarraNexus
    // sandbox with workspace /home/sprite/.narranexus failed every runner turn
    // with `outside allowed roots` while a direct sprite exec would have run
    // it.
    // Mirror what DaemonAgentAttacher does for daemon runtimes: register the
    // path as a workspace root before dispatching through the runner. Any
    // failure degrades to the sprite-exec transport — a runner must never be
    // the reason a turn cannot start.
    private async workspacePreflight(
        daemonId: string,
        workspacePath: string | null | undefined,
        // The host row when the caller already read it (the pod path does, by
        // name); otherwise it is fetched here. Must carry the rpc lease fields
        // too, or the per-generation cache below silently degrades to
        // "re-ensure every turn".
        known?: {
            workspaceBaseDir: string | null
            rpcInstanceId: string | null
            rpcConnectedAt: Date | null
        }
    ): Promise<{
        outcome: WorkspacePreflightOutcome
        ensureMs?: number
        reason?: RunnerFallbackReason
    }> {
        const path = workspacePath
        if (!path) return { outcome: 'none' }
        const host =
            known ?? (await this.hosts.findById(daemonId).catch(() => null))
        const base = host?.workspaceBaseDir?.replace(/\/+$/, '')
        if (base && (path === base || path.startsWith(`${base}/`)))
            return { outcome: 'base' }
        // The generation comes from the host row's rpc lease, not a local
        // socket map: the socket may live on the peer api instance, but every
        // instance sees the same lease. Rows without a lease (mid-reconnect
        // race) never hit the cache and always re-ensure — the safe direction.
        const generation =
            host?.rpcInstanceId && host.rpcConnectedAt
                ? `${host.rpcInstanceId}:${host.rpcConnectedAt.getTime()}`
                : null
        const cached = generation
            ? this.ensuredWorkspaces.get(daemonId)
            : undefined
        if (
            cached &&
            cached.generation === generation &&
            cached.paths.has(path)
        )
            return { outcome: 'cached' }
        const startedAt = Date.now()
        try {
            await this.registry.rpc({
                daemonId,
                method: 'workspace.ensure',
                payload: { path, create: false },
                timeoutMs: WORKSPACE_ENSURE_TIMEOUT_MS
            })
            if (generation) {
                const entry =
                    cached?.generation === generation
                        ? cached
                        : { generation, paths: new Set<string>() }
                entry.paths.add(path)
                this.ensuredWorkspaces.set(daemonId, entry)
            }
            return { outcome: 'ensured', ensureMs: Date.now() - startedAt }
        } catch (err) {
            const message = (err as Error).message
            this.logger.warn(
                `runner workspace register failed daemon=${daemonId} class=${errorClass(err)}`
            )
            return {
                outcome: 'failed',
                ensureMs: Date.now() - startedAt,
                reason: classifyWorkspaceEnsureFailure(message)
            }
        }
    }

    private async findRunnerHost(args: {
        userId: string
        // The platform-set host name — runnerHostName for a sprite,
        // podRunnerHostName for a pod. Keyed by name rather than by the
        // capacity it lives in so both managed runners share one lookup.
        hostName: string
    }): Promise<{
        id: string
        online: boolean
        generation: string | null
        cliVersion: string | null
        clientFeatures: string[]
        // What workspacePreflight reads, so the pod path can hand this row
        // over instead of reading it a second time.
        workspaceBaseDir: string | null
        rpcInstanceId: string | null
        rpcConnectedAt: Date | null
        // The last pong (or connect) the API recorded, so a caller that just
        // woke the sprite can tell a lease refreshed by the thawed process
        // from the one a frozen process left behind (`online` cannot: the
        // 45s window outlives a suspension by design).
        rpcLastSeenAt: Date | null
    } | null> {
        const rows = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, args.userId),
                    eq(runtimeHosts.kind, 'daemon'),
                    // The name is the registering client's word: a user can
                    // `daemon register --name` anything. `managed` is not —
                    // it derives from the token purpose the platform minted —
                    // so it is what makes this lookup find OUR runner and not
                    // a same-named BYOD host. Teardown filters the same way.
                    eq(runtimeHosts.managed, true),
                    eq(runtimeHosts.name, args.hostName)
                )
            )
            .limit(8)
        // See runner-host-rows.ts: one rule for which of several same-named
        // rows is the runner, and the leftovers of a double registration are
        // dropped here, where registrations are made.
        const row = pickRunnerHostRow(rows)
        if (!row) return null
        if (rows.length > 1) void this.reapRunnerTwins(rows)
        // Readiness comes from the host row, NOT registry.isOnline(): that only
        // knows about sockets on THIS api instance, and staging/prod run two.
        // With two machines the local check is a coin flip — measured: the same
        // drill said "online" on one machine and "did not come online" on the
        // other, minutes apart. streamRpc already falls back to remoteStreamRpc
        // for a daemon whose socket lives on a peer, so a runner connected
        // anywhere is usable from everywhere.
        return {
            id: row.id,
            online: this.hosts.isOnline(row),
            generation:
                row.rpcInstanceId && row.rpcConnectedAt
                    ? `${row.rpcInstanceId}:${row.rpcConnectedAt.getTime()}`
                    : null,
            cliVersion: row.cliVersion ?? null,
            clientFeatures: row.clientFeatures ?? [],
            workspaceBaseDir: row.workspaceBaseDir ?? null,
            rpcInstanceId: row.rpcInstanceId ?? null,
            rpcConnectedAt: row.rpcConnectedAt ?? null,
            rpcLastSeenAt: row.rpcLastSeenAt ?? null
        }
    }

    private async reapRunnerTwins(
        rows: ReadonlyArray<{
            id: string
            createdAt: Date
            rpcConnectedAt: Date | null
            rpcLastSeenAt: Date | null
        }>
    ): Promise<void> {
        const twins = staleRunnerTwins(rows)
        if (twins.length === 0) return
        try {
            await this.db.delete(runtimeHosts).where(
                inArray(
                    runtimeHosts.id,
                    twins.map((t) => t.id)
                )
            )
            this.logger.log(
                `runner twin rows dropped ids=${twins.map((t) => t.id).join(',')}`
            )
        } catch (err) {
            this.logger.warn(
                `runner twin cleanup failed class=${errorClass(err)}`
            )
        }
    }

    // The install-and-register half of a bring-up, shared with prepareRunner.
    // A runner that is merely PRESENT is not good enough. The platform owns
    // this binary and nothing else ever updates it, so a sprite keeps its
    // first CLI indefinitely — including bugs we have since fixed in it. The
    // floor is the version whose exec-buffer sweep stops the buffer growing
    // without bound; below it, a cold runner re-enumerates and re-parses every
    // turn it ever ran before it dials back.
    // Seen on staging 2026-07-26: bring-up blew its 120s budget on a sprite
    // that was already installed AND registered, and this is the most
    // plausible reason.
    private async installAndRegister(
        args: EnsureRunnerArgs,
        state: RunnerSpriteState
    ): Promise<'ok' | 'install-failed' | 'register-failed'> {
        const tooOld = isCliVersionTooOld(state.version, DAEMON_MIN_CLI_VERSION)
        if (!state.installed || tooOld) {
            if (tooOld && state.installed)
                this.logger.log(
                    `runner CLI ${state.version ?? 'unknown'} < ${DAEMON_MIN_CLI_VERSION}, upgrading sprite=${args.spriteName}`
                )
            const ok = await this.installCli(args)
            if (!ok) return 'install-failed'
        }
        if (!state.registered) {
            let registered = await this.register(args)
            // A CLI that predates `--token -` takes the dash LITERALLY and
            // rejects it as a malformed token. That is exactly what a sprite
            // from an older image has: `~/.local/bin/mf` is there (so the
            // install step is skipped) but it is the legacy binary, or the
            // nca->mf bridge symlink the shell-env writes. Measured on a
            // staging codex sprite: `daemon register token must start with
            // ldt_` on every attempt, forever, because nothing reinstalls.
            if (
                !registered.ok &&
                isStaleCliRegisterFailure(registered.detail)
            ) {
                this.logger.warn(
                    `runner CLI too old to read the token from stdin, reinstalling sprite=${args.spriteName}`
                )
                if (!(await this.installCli(args))) return 'install-failed'
                registered = await this.register(args)
            }
            if (!registered.ok) return 'register-failed'
        }
        return 'ok'
    }

    // Bring a sprite's runner to "registered and starting" WITHOUT waiting for
    // it to dial in. For callers that already have the VM awake — the agent
    // create, right after the framework install — so the runner row exists by
    // the time the user next looks at the runtime, and the next list finds a
    // sleeping runner (a 15s reconnect) instead of "no runner yet" (a full
    // bring-up). The awake hold covers the daemon's ~60-75s first connect,
    // which would otherwise race the sprite's ~35s idle suspend; its TTL is
    // the only thing that ends it.
    async prepareRunner(
        args: EnsureRunnerArgs & { awakeTtl?: string }
    ): Promise<RunnerPrepareOutcome> {
        try {
            const inspected = await this.inspectSprite(args)
            const state = inspected.state
            if (!state) return 'exec-failed'
            const prepared = await this.installAndRegister(args, state)
            if (prepared !== 'ok') return prepared
            const existing = await this.findRunnerHost({
                userId: args.userId,
                hostName: runnerHostName(args.spriteName)
            })
            if (existing?.online) return 'live'
            await this.start(args)
            void this.holdSpriteAwake({
                exec: args.exec,
                turnId: `prepare-${args.spriteName}`,
                ttl: args.awakeTtl ?? AUTH_AWAKE_TTL
            })
            return 'started'
        } catch (err) {
            this.logger.warn(
                `runner prepare failed agentId=${args.agentId} sprite=${args.spriteName} class=${errorClass(err)}`
            )
            return 'exec-failed'
        }
    }

    private async bringUp(args: EnsureRunnerArgs): Promise<RunnerBringUp> {
        try {
            const inspected = await this.inspectSprite(args)
            const state = inspected.state
            // Stop at the inspect when the inspect is what proved the endpoint
            // cannot serve a socket: install, register and start would each pay
            // the same failing handshake, and register would mint a runner token
            // for a sprite nothing can reach.
            if (!state)
                return inspected.execFailure
                    ? { handle: null, execFailure: inspected.execFailure }
                    : { handle: null }
            const prepared = await this.installAndRegister(args, state)
            if (prepared !== 'ok') return { handle: null }
            await this.start(args)
            let online = await this.waitOnline(args)
            if (!online) {
                this.logger.warn(
                    `runner did not come online agentId=${args.agentId} sprite=${args.spriteName}`
                )
                const tail = await this.logRunnerTail(args)
                // A rejected credential is terminal on its own: the sprite still
                // has a config, so inspectSprite reports registered=1 forever and
                // nothing would ever mint a replacement. Re-register once.
                if (/unauthorized|4401/i.test(tail ?? '')) {
                    this.logger.warn(
                        `runner credential rejected, re-registering sprite=${args.spriteName}`
                    )
                    if (!(await this.register(args)).ok) return { handle: null }
                    await this.start(args)
                    online = await this.waitOnline(args)
                }
                if (!online) return { handle: null }
            }
            this.logger.log(
                `runner online agentId=${args.agentId} sprite=${args.spriteName} daemonId=${online.id}`
            )
            return {
                handle: {
                    daemonId: online.id,
                    started: true,
                    generation: online.generation
                }
            }
        } catch (err) {
            // Degrade to the sprite-exec path; a runner is an optimisation, not
            // a dependency of the turn.
            this.logger.warn(
                `runner bring-up failed agentId=${args.agentId} sprite=${args.spriteName} class=${errorClass(err)}`
            )
            return { handle: null }
        }
    }

    // One round trip that both WAKES the sprite (any exec resumes it) and reports
    // what is already there, so the common "already installed and registered"
    // case costs a single exec.
    //
    // It is also the only exec in the bring-up that is SAFE to classify the
    // endpoint from: a read-only probe, first on the wire, with nothing before it
    // that could have broken the socket. A failure of any later exec could be a
    // consequence of what that exec did, so those keep degrading silently.
    private async inspectSprite(
        args: Pick<
            EnsureRunnerArgs,
            'exec' | 'spriteName' | 'firstExecTimeoutMs'
        >
    ): Promise<RunnerInspection> {
        const script = [
            `test -x "$HOME/.local/bin/mf" && echo installed=1 || echo installed=0`,
            `test -f "${RUNNER_PROBE_PATH}" && echo registered=1 || echo registered=0`,
            // Free: we are already paying for this exec. Without it the runner
            // keeps whatever CLI it was first given, forever — there is no
            // upgrade path for a binary the platform installed inside a sprite.
            `echo version=$("$HOME/.local/bin/mf" --version 2>/dev/null | tr -d '[:space:]')`
        ].join('; ')
        let res
        try {
            res = await args.exec({
                cmd: ['bash', '-lc', script],
                timeoutMs: args.firstExecTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS
            })
        } catch (err) {
            const execFailure = classifyExecEndpointFailure(err)
            this.logger.warn(
                `runner inspect exec failed sprite=${args.spriteName} class=${execFailure?.failureClass ?? errorClass(err)}`
            )
            return execFailure ? { state: null, execFailure } : { state: null }
        }
        if (res.exitCode !== 0) {
            // The socket opened and the VM ran the command, so the endpoint is
            // healthy and a direct sprite exec is still the right fallback.
            this.logger.warn(
                `runner inspect failed sprite=${args.spriteName} exit=${res.exitCode}`
            )
            return { state: null }
        }
        return {
            state: {
                installed: res.stdout.includes('installed=1'),
                registered: res.stdout.includes('registered=1'),
                version: /version=([^\s]+)/.exec(res.stdout)?.[1] ?? null
            }
        }
    }

    private async installCli(args: EnsureRunnerArgs): Promise<boolean> {
        // Same installer sprite provisioning uses, so a staging sprite gets the
        // staging CLI. Hardcoding the stable URL here meant staging ran a prod
        // build of the very component whose protocol changes staging exists to
        // validate — and it would overwrite the staging binary provisioning had
        // already put at that path.
        const channel = cliInstallChannelForDeployEnv(
            resolveMfDeployEnv(process.env.MF_DEPLOY_ENV)
        )
        const res = await args.exec({
            cmd: [
                'bash',
                '-lc',
                buildCliInstallScript(channel)
            ],
            timeoutMs: 180_000
        })
        if (res.exitCode !== 0)
            this.logger.warn(
                `runner cli install failed sprite=${args.spriteName} exit=${res.exitCode}`
            )
        return res.exitCode === 0
    }

    private async register(
        args: EnsureRunnerArgs
    ): Promise<{ ok: boolean; detail: string }> {
        // The token is pinned by the register transaction, and the daemon
        // surface it can reach is narrow (register / heartbeat / me + the
        // websocket). It is passed on STDIN — never argv, which would put it in
        // the sprite's process list.
        //
        // `purpose` is the entire trust boundary: it is what makes the register
        // below quota-exempt and its host managed. It lives on the token row,
        // which only this call site can set, so a user's own token presenting
        // the same --name gets neither.
        const minted = await this.tokens.mint({
            userId: args.userId,
            name: runnerHostName(args.spriteName),
            expiresInDays: TOKEN_TTL_DAYS,
            purpose: 'sprite_runner'
        })
        const res = await args
            .exec({
                cmd: [
                    'bash',
                    '-lc',
                    `MF_PROFILE=${RUNNER_PROFILE} "$HOME/.local/bin/mf" --api-url ${this.apiUrl()} ` +
                        `daemon register --token - --name ${shellQuote(runnerHostName(args.spriteName))}`
                ],
                stdin: minted.plaintext,
                timeoutMs: 180_000
            })
            .catch(async (err: unknown) => {
                await this.discardUnboundToken(minted.tokenId, args)
                throw err
            })
        // Seen on staging [2026-09-10]: -y stopped the manual runner before
        // failing to install an init unit. The platform starts it explicitly.
        const ok = res.exitCode === 0
        const detail = redactCredentialText(
            `${res.stdout} ${res.stderr}`
        ).slice(0, 400)
        if (!ok) {
            // The CLI's own words are the only clue to WHY (an API the sprite
            // cannot reach, a rejected token, an old binary); the token itself
            // went over stdin and is never in this output.
            this.logger.warn(
                `runner register failed sprite=${args.spriteName} exit=${res.exitCode} detail=${detail.replace(/\s+/g, ' ').trim().slice(0, 200) || '(no output)'}`
            )
            await this.discardUnboundToken(minted.tokenId, args)
        }
        return { ok, detail }
    }

    // A bring-up that never registered leaves behind a token that is valid for
    // 90 days and can still open the daemon websocket.
    // Seen on production [2026-08-12]: 30 rejected bring-ups in 13h, one such
    // token each, because nothing on the failure path ever removed them.
    //
    // The delete is scoped to `daemon_id IS NULL` in SQL, so the case this has
    // to survive — the register succeeded and only our exec lost the answer —
    // keeps the credential its runner is already authenticating with.
    private async discardUnboundToken(
        tokenId: string,
        args: EnsureRunnerArgs
    ): Promise<void> {
        await this.tokens
            .deleteUnbound({ tokenId, userId: args.userId })
            .then((deleted) => {
                if (!deleted)
                    this.logger.log(
                        `runner token bound despite failure, kept sprite=${args.spriteName}`
                    )
            })
            .catch((err: Error) =>
                this.logger.warn(
                    `runner token cleanup failed sprite=${args.spriteName} class=${errorClass(err)}`
                )
            )
    }

    private async start(
        args: Pick<EnsureRunnerArgs, 'exec' | 'spriteName'>
    ): Promise<void> {
        // `daemon stop` first: we only get here because the runner is NOT online,
        // and a runner frozen by sprite suspension leaves its pid/lock behind, so
        // `daemon start` refuses and nothing ever connects. Stopping is a no-op
        // when there is nothing to stop.
        //
        // setsid: no supervisor exists in a sprite, so the runner has to outlive
        // the exec session that starts it.
        const mf = `"$HOME/.local/bin/mf" --api-url ${this.apiUrl()}`
        const res = await args.exec({
            cmd: [
                'bash',
                '-lc',
                `export MF_PROFILE=${RUNNER_PROFILE}; ` +
                    `${mf} daemon stop >/dev/null 2>&1 || true; ` +
                    `setsid nohup ${mf} daemon start --foreground ` +
                    `>> "$HOME/.manyfold/runner.log" 2>&1 < /dev/null & disown; sleep 2; ` +
                    // Match the process NAME, not the command line: `pgrep -f`
                    // also matches the bash wrapper running this very script
                    // (its argv contains the pattern), which reported procs=2
                    // for a single healthy runner and reads as a duplicate.
                    `pgrep -c -x mf || echo 0`
            ],
            timeoutMs: 90_000
        })
        this.logger.log(
            `runner start sprite=${args.spriteName} exit=${res.exitCode} procs=${res.stdout.trim().slice(-4)}`
        )
    }

    // The runner's own log is the only place that says WHY it never connected
    // (refused to start, wrong api url, auth rejected). Without this a failed
    // bring-up is a dead end from the API side — which is exactly where the
    // first staging attempt stalled.
    private async logRunnerTail(
        args: Pick<EnsureRunnerArgs, 'exec' | 'spriteName'>
    ): Promise<string | null> {
        const res = await args
            .exec({
                cmd: [
                    'bash',
                    '-lc',
                    'tail -n 6 "$HOME/.manyfold/runner.log" 2>/dev/null || echo "(no runner log)"'
                ],
                timeoutMs: 30_000
            })
            .catch((err: Error) => {
                this.logger.warn(
                    `runner log tail unavailable sprite=${args.spriteName} class=${errorClass(err)}`
                )
                return null
            })
        if (!res) return null
        const tail = redactCredentialText(res.stdout).replace(/\s+/g, ' ')
        return tail
    }

    // A runner turn produces NO platform-visible activity: with the exec running
    // INSIDE the sprite (via the runner) rather than as a sprite exec session,
    // the platform sees an idle VM, suspends it, the frozen runner stops
    // answering websocket pings, and the API drops it mid-turn.
    // Seen on staging 2026-07-25: `runner online` → 34s later
    // `daemon.ws.pong_timeout` → `claude exec transport error: connection
    // closed`.
    //
    // So a runner turn has to hold the sprite awake itself. `/v1/tasks` is the
    // platform's own activity lease (what the keep-alive feature renews), and it
    // is reachable from inside the sprite. The lease carries a TTL rather than
    // being renewed from here on purpose: if this API instance dies mid-turn the
    // task expires on its own, the sprite suspends, and nothing leaks — the
    // user-facing keep-alive toggle (with its quota and billing meaning) is left
    // completely alone.
    // Hold the sprite awake for as long as the turn runs, and release on the
    // way out. The lease TTL is short relative to the 2h exec ceiling, so a long
    // turn is kept alive by renewal rather than by one generous TTL: the TTL is
    // what bounds the leak if this instance dies, and renewal is what keeps a
    // 45-minute turn from being frozen at minute 30. Both properties hold
    // because the renew timer dies with the process that owns the turn.
    keepSpriteAwake(args: {
        exec: SpriteExecFn
        turnId: string
    }): SpriteAwakeHold {
        // The create and every renew stay fire-and-forget, but release() waits
        // for whichever was last in flight before it deletes. A hold settled
        // on its first poll — routine for an adoption that finds the turn
        // already terminal — would otherwise race its own DELETE past the
        // POST and leave a full-TTL lease that nobody renews and nothing
        // needs.
        let pending: Promise<unknown> = this.holdSpriteAwake({
            ...args,
            ttl: AWAKE_TTL
        }).catch(() => false)
        const timer = setInterval(() => {
            pending = this.holdSpriteAwake({ ...args, ttl: AWAKE_TTL }).catch(
                () => false
            )
        }, AWAKE_RENEW_MS)
        if (typeof timer.unref === 'function') timer.unref()
        let done = false
        const stop = (): boolean => {
            if (done) return false
            done = true
            clearInterval(timer)
            return true
        }
        return {
            release: async () => {
                if (!stop()) return
                await pending
                await this.releaseSpriteAwake(args)
            },
            // The turn was SUSPENDED, not finished: the runner is still working
            // and will hand the answer to whoever picks the stream up next.
            // Deleting the lease here would let the sprite suspend and freeze it
            // mid-answer, so stop renewing and let the TTL bound the leak — the
            // same thing that happens when this instance dies outright.
            detach: () => {
                stop()
            }
        }
    }

    async holdSpriteAwake(args: {
        exec: SpriteExecFn
        turnId: string
        ttl: string
    }): Promise<boolean> {
        const name = awakeTaskName(args.turnId)
        const create = JSON.stringify({ name, expire: args.ttl })
        const renew = JSON.stringify({ expire: args.ttl })
        // Copied from the proven keep-alive script (packages/sprites tasks.ts):
        // the path goes straight after -X and BEFORE -d, with no -H/-o/-w. My
        // first attempt added those and put the path last, which made curl exit
        // 3 (malformed URL) on every turn — the hold silently never happened.
        // Create-or-renew, so a retry of the same turn is not a failure either.
        const res = await args
            .exec({
                cmd: [
                    'bash',
                    '-lc',
                    `sprite-env curl -s -X POST /v1/tasks -d ${shellQuote(create)} >/dev/null 2>&1 ` +
                        `|| sprite-env curl -s -X PUT ${shellQuote(`/v1/tasks/${name}`)} -d ${shellQuote(renew)} >/dev/null 2>&1`
                ],
                timeoutMs: 60_000
            })
            .catch(() => null)
        const ok = res?.exitCode === 0
        if (!ok)
            this.logger.warn(
                `sprite awake-hold failed turnId=${args.turnId} exit=${res?.exitCode}`
            )
        return ok
    }

    async releaseSpriteAwake(args: {
        exec: SpriteExecFn
        turnId: string
    }): Promise<void> {
        const name = awakeTaskName(args.turnId)
        await args
            .exec({
                cmd: [
                    'bash',
                    '-lc',
                    `sprite-env curl -s -X DELETE ${shellQuote(`/v1/tasks/${name}`)} >/dev/null 2>&1`
                ],
                timeoutMs: 30_000
            })
            .catch((err: Error) => {
                // The TTL is the backstop, so a failed release only means the
                // sprite stays awake a little longer than necessary.
                this.logger.warn(
                    `sprite awake-release failed turnId=${args.turnId} class=${errorClass(err)}`
                )
                return null
            })
    }

    private async waitOnline(
        args: EnsureRunnerArgs
    ): Promise<{ id: string; generation: string | null } | null> {
        const deadline =
            Date.now() + (args.waitOnlineMs ?? DEFAULT_WAIT_ONLINE_MS)
        for (;;) {
            const host = await this.findRunnerHost({
                userId: args.userId,
                hostName: runnerHostName(args.spriteName)
            })
            if (host?.online)
                return { id: host.id, generation: host.generation }
            if (Date.now() >= deadline) return null
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    // Online is not enough after a restart: the socket lease flips on connect,
    // the version on the first heartbeat, and a row that is online on the OLD
    // version is exactly the state a restart is meant to leave.
    private async waitForCliVersion(args: {
        userId: string
        spriteName: string
        version: string
        waitMs?: number
    }): Promise<boolean> {
        const deadline = Date.now() + (args.waitMs ?? RESTART_WAIT_MS)
        for (;;) {
            const host = await this.findRunnerHost({
                userId: args.userId,
                hostName: runnerHostName(args.spriteName)
            })
            if (host?.online && host.cliVersion === args.version) return true
            if (Date.now() >= deadline) return false
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    // The running daemon's own word on what it is and whether it is busy, via
    // the control socket the runner profile owns. The host row cannot answer
    // either: its cliVersion is whatever the process last heartbeated (true,
    // but that is the question), and the API has no cross-instance view of
    // live sessions.
    private async probeRunnerProcess(
        args: Pick<EnsureRunnerArgs, 'exec' | 'spriteName'>
    ): Promise<RunnerProcessState> {
        const res = await args.exec({
            cmd: [
                'bash',
                '-lc',
                `export MF_PROFILE=${RUNNER_PROFILE}; "$HOME/.local/bin/mf" daemon status --json`
            ],
            timeoutMs: STATUS_PROBE_TIMEOUT_MS
        })
        if (res.exitCode !== 0) {
            this.logger.warn(
                `runner status probe failed sprite=${args.spriteName} exit=${res.exitCode}`
            )
            return { kind: 'unknown' }
        }
        return parseRunnerStatus(res.stdout)
    }

    private apiUrl(): string {
        const base = process.env.PUBLIC_API_BASE_URL?.replace(/\/+$/, '')
        return base ? `${base}/api` : DEFAULT_API_BASE_URL
    }
}

// The `--json` payload of `mf daemon status`: `local` is the control-socket
// health of the running process (null when there is none, or when the daemon
// predates the socket), `localPid` the pid-file process if any. Read from the
// first `{` to the last `}` because a login shell may print before the CLI does.
export const parseRunnerStatus = (stdout: string): RunnerProcessState => {
    let body: {
        configured?: unknown
        localPid?: unknown
        local?: {
            version?: unknown
            activeExecs?: unknown
            activePtys?: unknown
        } | null
    }
    try {
        body = JSON.parse(
            stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)
        ) as typeof body
    } catch {
        return { kind: 'unknown' }
    }
    if (body.configured === false) return { kind: 'not-running' }
    const local = body.local
    if (local && typeof local === 'object')
        return {
            kind: 'running',
            version: typeof local.version === 'string' ? local.version : null,
            activeExecs:
                typeof local.activeExecs === 'number' ? local.activeExecs : 0,
            activePtys:
                typeof local.activePtys === 'number' ? local.activePtys : 0
        }
    if (body.localPid === null || body.localPid === undefined)
        return { kind: 'not-running' }
    return { kind: 'unknown' }
}

// The token we send IS `ldt_`-prefixed, so the CLI complaining that it is not
// can only mean the CLI never read stdin and used the literal `-`. Same for a
// CLI that does not know the flag at all.
const isStaleCliRegisterFailure = (detail: string): boolean =>
    /must start with ldt_|unknown option|requires --token/i.test(detail)

// Which exec failures are the EXEC ENDPOINT's fault. Getting this wrong in the
// generous direction is expensive: the caller quarantines on it, so a class
// handed out for a sprite that answered takes a healthy VM out of the turn path.
//
// Exported because chat's health probe asks the same question of the same
// transport (#730) and must exclude the same non-endpoint failures; two copies
// of this judgement would drift, and the direction it drifts in is quarantining
// hosts that are fine.
//
// Only a transient SpritesError qualifies at all. `auth` is an account-wide fact
// (a revoked account token would quarantine every sprite on that account at
// once, none of them sick), and not_found / conflict / quota / permanent are
// facts about the request. A structured `reason` — today `exec_session_gone` —
// means the endpoint started and reaped a session, so it answered.
export const classifyExecEndpointFailure = (
    err: unknown
): RunnerExecFailure | null => {
    if (!(err instanceof SpritesError) || err.code !== 'transient') return null
    if (err.reason) return null
    if (err.execPhase !== 'pre_open') return null
    // The inspect burned its whole budget without a result: nothing usable came
    // back from the endpoint within a window many times what a healthy one needs.
    if (/timed out after \d+ms/i.test(err.message))
        return { failureClass: 'timeout' }
    const status = err.status
    // A non-101 upgrade response. 5xx only: the socket never opened AND the
    // backend blamed itself.
    if (status !== undefined && status >= 500 && /handshake/i.test(err.message))
        return {
            failureClass: 'handshake_5xx',
            upstreamStatus: status
        }
    // `ws` reports a connection that died before the handshake completed as an
    // error with no status. A socket that opened and then died surfaces as
    // `closed without exit code` instead, which is deliberately NOT classified:
    // a sprite suspending mid-inspect does that and recovers by itself.
    if (/transport error/i.test(err.message))
        return { failureClass: 'transport_error' }
    return null
}

const errorClass = (err: unknown): string =>
    err instanceof Error && err.name ? err.name : typeof err

// The registry surfaces a dead generation in exactly two shapes: its own
// deadline text for a socket that is up but frozen, and a connection-lifecycle
// rejection for one that closed or was replaced mid-flight (including the
// broker's offline / stale-lease refusals for a peer-held socket). Anything
// else came back from a live daemon and is a genuine preflight error.
const classifyWorkspaceEnsureFailure = (
    message: string
): RunnerFallbackReason =>
    /timed out/i.test(message)
        ? 'workspace_timeout'
        : /connection closed|connection replaced|is not connected|no active websocket|lease is stale/i.test(
                message
            )
          ? 'workspace_connection_closed'
          : 'workspace_error'

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// Task names must be simple identifiers for the platform API, and per-turn so
// two concurrent turns on one sprite cannot release each other's lease.
const awakeTaskName = (turnId: string): string =>
    `mfturn-${turnId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`
