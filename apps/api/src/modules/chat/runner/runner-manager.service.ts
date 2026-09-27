import { randomUUID } from 'node:crypto'
import { DEFAULT_API_BASE_URL } from '@/common/brand'
import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import {
    DAEMON_FEATURE_EXEC_FILES,
    DAEMON_FEATURE_HERDR_TERMINAL,
    DAEMON_FEATURE_MANUAL_UPDATE,
    DAEMON_MIN_CLI_VERSION,
    K8S_HOME_BASE,
    POD_RUNNER_PROFILE,
    RUNNER_PROFILE,
    daemonOnline,
    isCliVersionTooOld,
    profilePaths,
    type MfCliChannel
} from '@manyfold/shared'
import {
    Injectable,
    Logger,
    ServiceUnavailableException
} from '@nestjs/common'
import type {
    HostDaemonRow,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'
import { SpritesError } from '@manyfold/sprites'
import { resolveMfDeployEnv } from '@/common/deploy-env'
import {
    buildCliInstallScript,
    cliInstallChannelForDeployEnv,
    buildHerdrInstallScript,
    HERDR_INSTALL_MARKER
} from '@/modules/agent-self/sprite-shell-env.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import {
    HostProviderClients,
    type HostExecFn
} from '@/modules/hosts/providers/host-provider-clients.service'
import {
    SandboxProviderRegistry,
    StaleGenerationError,
    type ProviderCall,
    type SandboxProvider
} from '@/modules/hosts/providers/sandbox-provider'
import { recordPower } from '@/modules/hosts/providers/generation'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'

// Bring a hosted host's daemon up so a turn — or anything else that happens
// inside the machine — can go through the daemon protocol (ADR-0036 R11):
// Agent → Runtime → Host → host_daemons. Online → RPC. Not online → the
// provider adapter's power / wake / bootstrap, in that order, then RPC. A
// local host's daemon is the user's to start: offline is `runner_unavailable`.
//
// Measured on a real sprite 2026-07-24: two probe results shape everything
// here.
//   - a reverse WSS from inside a sprite to the API works (GET /api/daemon/ws
//     answers 101), and `mf daemon` runs there — but the sprite has no systemd,
//     so the daemon has to be started detached, by us;
//   - the WSS CANNOT survive sprite suspension: a frozen process misses pings
//     and the API drops it (`ws closed code=4000 reason=pong timeout`) while the
//     process is still alive. So a daemon is NOT durably resident: every
//     dispatch has to wake the sprite and wait for the daemon to reconnect.
//
// That is why this is a "manager" and not a provisioning step: ensureHostDaemon
// is called on the turn path, is expected to be a no-op fast path most of the
// time, and returns null rather than throwing so the caller can report the
// host unavailable instead of failing on the transport.

export { RUNNER_PROFILE }

// The daemon token authenticates EVERY websocket connect through its bearer
// header, not just the one-off register — a short TTL therefore bricks the
// daemon a day later, which is exactly what happened on staging: `ws closed
// code=4401 reason=unauthorized`, and the inspect kept reporting registered=1
// so it never re-registered. Match the user-daemon default instead. A pod's
// token has no expiry at all: its boot loop registers once from a Secret that
// is never rewritten, so a lapse would only switch the daemon off.
const TOKEN_TTL_DAYS = 90
// Measured on staging: a fresh register + start reconnects at ~60-75s (the CLI
// re-detects frameworks on register, then boots and dials). 45s gave up just
// before the daemon arrived — the turn fell back and the daemon then sat there
// connected with nothing holding the sprite awake.
const DEFAULT_WAIT_ONLINE_MS = 120_000
const POLL_INTERVAL_MS = 500
// The awake lease bounds the leak when the owning instance dies mid-turn: the
// sprite keeps executing (that is the whole point) but suspends on its own soon
// after. Renewed at a third of the TTL so a single failed renew is not fatal.
const AWAKE_TTL = '30m'
const AWAKE_RENEW_MS = 10 * 60_000
// A stale daemon connection can sit inside the presence grace window looking
// online while its websocket generation is frozen (sprite suspended mid-ping)
// or already closed. The registry's generic 30s RPC default turned that into a
// 30s stall on every affected turn — 8 of 10 production fallbacks took
// 29–30.1s (#592). workspace.ensure is a filesystem check on the daemon and a
// live connection answers it in milliseconds, so a short setup deadline
// converts a dead generation into a fast refusal.
const WORKSPACE_ENSURE_TIMEOUT_MS = 5_000
// What the inspect got before a caller could bound it. Kept as the default so a
// caller without an exec-health budget behaves exactly as it did.
const DEFAULT_INSPECT_TIMEOUT_MS = 60_000
// After the sandbox CLI upgrade restarts the daemon, how long to wait for the
// restarted process's first heartbeat to carry the installed version (that
// heartbeat is the write that moves cliVersion and clientFeatures).
const RESTART_WAIT_MS = 45_000
// The daemon downloads and prechecks the binary inside this window.
const RUNNER_UPGRADE_RPC_TIMEOUT_MS = 180_000
const STATUS_PROBE_TIMEOUT_MS = 30_000
// After a wake thawed a registered daemon whose socket the API had already
// dropped, how long its own reconnect gets before the process is restarted.
// The daemon's ws client forces a reconnect when it detects the clock jump a
// suspension leaves behind, and its backoff starts at 1s, so a live process is
// back on a fresh lease within a few seconds; a process that is not back by
// then is wedged or gone, and `daemon stop; daemon start` is what helps.
const WAKE_RECONNECT_WAIT_MS = 15_000
// How long a daemon woken for an account operation (not a turn) is held awake.
// Long enough for the sign-in / key / pick sequence the user just started, and
// for a freshly started daemon to dial in (~60-75s), short enough that a wake
// nobody follows up on stops billing within minutes. Renewed by every
// subsequent wake, never by a timer: the TTL is the whole leak bound.
export const AUTH_AWAKE_TTL = '5m'

// The `{ cmd, stdin?, timeoutMs }` exec shape the sandbox callers share.
export type SpriteExecFn = HostExecFn

export interface HostDaemonArgs {
    host: RuntimeHostRow
    // Telemetry only.
    agentId?: string
    workspacePath?: string | null
    // Directories beyond the workspace the daemon must admit (a framework's
    // own home, FrameworkDefinition.runner.homeRoots).
    extraRoots?: readonly string[]
    waitOnlineMs?: number
    // Daemon client features the caller cannot run without (a profile-bound
    // agent needs auth-context.v1). A daemon lacking one is reported
    // unavailable rather than handed out, so the wrong sign-in never answers.
    requiredFeatures?: readonly string[]
    // The budget for the INSPECT, the first native exec of a bring-up and the
    // one a dead exec endpoint surfaces on (#730).
    firstExecTimeoutMs?: number
}

export interface SpriteAwakeHold {
    // Turn reached a terminal: stop renewing and drop the lease now.
    release: () => Promise<void>
    // Turn was handed off mid-flight: stop renewing, leave the lease to expire.
    detach: () => void
}

export interface RunnerHandle {
    // The host id: the daemon's routing key (ADR-0036).
    daemonId: string
    // false when the daemon was already connected (the common case).
    started: boolean
    // The rpc-lease generation the handle was resolved against
    // (`instance:connectedAtMs`), null while the lease is mid-reconnect.
    // Telemetry-only (#619): correlates a dispatch outcome with the socket
    // generation the resolution actually aimed at.
    generation: string | null
}

export type RunnerFallbackReason =
    | 'runner_unavailable'
    | 'runner_missing'
    | 'sprite_exec_unavailable'
    | 'workspace_timeout'
    | 'workspace_connection_closed'
    | 'workspace_error'
    // hermes only, decided by the caller: the daemon came up but does not
    // advertise turn.hermes, so it cannot own the ACP client.
    | 'runner_missing_turn_rpc'
    // the host's daemon is older than the floor and could not be updated.
    | 'runner_cli_too_old'

// How the sprite's exec endpoint refused the inspect, when the refusal is
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
    | 'base' // under the daemon-managed root: registered by construction
    | 'cached' // already ensured within this daemon generation
    | 'ensured' // workspace.ensure ran and succeeded
    | 'failed' // workspace.ensure failed: the turn cannot start

export interface RunnerResolution {
    handle: RunnerHandle | null
    fallbackReason?: RunnerFallbackReason
    // Present only with `sprite_exec_unavailable`: what the inspect proved about
    // the sprite exec endpoint, for the caller to quarantine on (#730).
    execFailure?: RunnerExecFailure
    workspace: { outcome: WorkspacePreflightOutcome; ensureMs?: number }
}

// What restartForInstalledCli did about the daemon PROCESS after the sandbox
// CLI upgrade swapped the binary under it. Every value is a valid end state for
// the upgrade — the binary on disk is the new one regardless.
export type RunnerRestartOutcome =
    | 'no-runner'
    | 'not-running'
    | 'current'
    | 'busy'
    | 'restarted'
    | 'restart-timeout'
    | 'failed'

// `mf daemon status --json` as seen from the runner profile inside the machine.
export type RunnerProcessState =
    | { kind: 'not-running' }
    // A process is there but answered no health: a daemon older than the
    // control socket. Its version and activity cannot be read from outside.
    | { kind: 'unknown' }
    | {
          kind: 'running'
          version: string | null
          activeExecs: number
          adoptableExecs: number
          activePtys: number
      }

interface RunnerMachineState {
    installed: boolean
    registered: boolean
    version: string | null
    // herdr present on the machine (ADR-0031); null when the probe did not say.
    herdr: boolean | null
}

export type RunnerWakeOutcome =
    | 'live'
    | 'reconnected'
    | 'restarted'
    | 'brought-up'
    | 'busy'
    | 'exec-failed'
    | 'not-online'

export interface RunnerWakeResult {
    handle: RunnerHandle | null
    outcome: RunnerWakeOutcome
}

interface RunnerBringUp {
    handle: RunnerHandle | null
    execFailure?: RunnerExecFailure
}

type RunnerInspection =
    | { state: RunnerMachineState }
    | { state: null; execFailure?: RunnerExecFailure }

// Where the daemon's profile lives on each kind of machine, and how its
// process is (re)started there. A sprite has no supervisor, so the daemon is
// started detached; a pod's boot loop restarts the daemon whenever it exits
// (ADR-0035), so stopping it IS starting it.
interface RunnerLayout {
    profile: string
    envPrefix: string
    probePath: string
    logPath: string | null
    start: (mf: string, keepExecs: boolean) => string
}

const SPRITE_LAYOUT: RunnerLayout = {
    profile: RUNNER_PROFILE,
    envPrefix: `export MF_PROFILE=${RUNNER_PROFILE};`,
    probePath: profilePaths('$HOME/.manyfold', RUNNER_PROFILE).daemonConfigPath,
    logPath: '"$HOME/.manyfold/runner.log"',
    // `daemon stop` first: we only get here because the daemon is NOT online,
    // and a daemon frozen by sprite suspension leaves its pid/lock behind, so
    // `daemon start` refuses and nothing ever connects. Stopping is a no-op
    // when there is nothing to stop. setsid: no supervisor exists in a sprite,
    // so the daemon has to outlive the exec session that starts it. The
    // process NAME is matched, not the command line: `pgrep -f` also matches
    // the bash wrapper running this very script.
    start: (mf, keepExecs) =>
        `${mf} daemon stop${keepExecs ? ' --keep-execs' : ''} >/dev/null 2>&1 || true; ` +
        `setsid nohup ${mf} daemon start --foreground >> "$HOME/.manyfold/runner.log" 2>&1 < /dev/null & disown; sleep 2; ` +
        'pgrep -c -x mf || echo 0'
}

const POD_CONFIG_ROOT = `${K8S_HOME_BASE}/.manyfold`

const POD_LAYOUT: RunnerLayout = {
    profile: POD_RUNNER_PROFILE,
    envPrefix: `export MF_PROFILE=${POD_RUNNER_PROFILE} MF_CONFIG_DIR=${POD_CONFIG_ROOT};`,
    probePath: profilePaths(POD_CONFIG_ROOT, POD_RUNNER_PROFILE).daemonConfigPath,
    logPath: null,
    start: (mf, keepExecs) =>
        `${mf} daemon stop${keepExecs ? ' --keep-execs' : ''} >/dev/null 2>&1 || true; ` +
        'pkill -TERM -x mf >/dev/null 2>&1 || true; sleep 2; pgrep -c -x mf || echo 0'
}

const layoutFor = (provider: RuntimeProvider): RunnerLayout =>
    provider.kind === 'k8s' ? POD_LAYOUT : SPRITE_LAYOUT

const MF_BIN = '"$HOME/.local/bin/mf"'

const leaseGeneration = (daemon: HostDaemonRow | null | undefined): string | null =>
    daemon?.rpcInstanceId && daemon.rpcConnectedAt
        ? `${daemon.rpcInstanceId}:${daemon.rpcConnectedAt.getTime()}`
        : null

const NOOP_HOLD: SpriteAwakeHold = {
    release: async () => {},
    detach: () => {}
}

@Injectable()
export class RunnerManagerService {
    private readonly logger = new Logger(RunnerManagerService.name)
    // One in-flight bring-up per host: concurrent turns on the same machine
    // must not each install and register a daemon.
    private readonly bringUps = new Map<string, Promise<RunnerBringUp>>()
    // Custom workspaces already registered with a daemon, keyed by host and
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
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderClients,
        private readonly tokens: DaemonTokenService,
        private readonly registry: DaemonRegistryService
    ) {}

    // Overridable in tests instead of injected: a function has no DI token, and
    // making it a constructor param broke the whole container at boot.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // The daemon of a host, online — brought up if the host is the
    // platform's and it is not (R11). Never throws: no daemon is an answer.
    async ensureHostDaemon(args: HostDaemonArgs): Promise<RunnerResolution> {
        const { host } = args
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (host.kind === 'local') {
            if (!daemon || !daemonOnline(daemon))
                return unavailable('runner_unavailable')
            return this.admit(host, daemon, args, false)
        }
        if (
            host.status === 'retired' ||
            host.status === 'deleting' ||
            host.status === 'failed'
        )
            return unavailable('runner_unavailable')
        if (daemon && daemonOnline(daemon))
            return this.admit(host, daemon, args, false)
        const resolved = await this.singleFlightBringUp(args)
        if (!resolved.handle)
            return {
                handle: null,
                // `runner_unavailable` is an invitation to retry later, so it
                // is exactly the wrong thing to say when the inspect just
                // proved the exec transport cannot open (#730).
                fallbackReason: resolved.execFailure
                    ? 'sprite_exec_unavailable'
                    : 'runner_unavailable',
                ...(resolved.execFailure
                    ? { execFailure: resolved.execFailure }
                    : {}),
                workspace: { outcome: 'none' }
            }
        const fresh = await this.hostDaemons.findByHostId(host.id)
        return this.admit(host, fresh, args, resolved.handle.started)
    }

    // The throwing form for callers that cannot proceed without the daemon
    // (a sandbox operation, a framework install).
    async requireHostDaemon(
        host: RuntimeHostRow,
        args: Omit<HostDaemonArgs, 'host'> = {}
    ): Promise<HostDaemonRow> {
        const resolution = await this.ensureHostDaemon({ ...args, host })
        const daemon = resolution.handle
            ? await this.hostDaemons.findByHostId(host.id)
            : null
        if (!resolution.handle || !daemon)
            throw new ServiceUnavailableException({
                code:
                    host.kind === 'local'
                        ? 'DAEMON_OFFLINE'
                        : 'SANDBOX_DAEMON_OFFLINE',
                message: `${host.name} is not reachable (${resolution.fallbackReason ?? 'daemon offline'})`,
                hostId: host.id,
                reason: resolution.fallbackReason ?? 'runner_unavailable'
            })
        return daemon
    }

    private async admit(
        host: RuntimeHostRow,
        daemon: HostDaemonRow | null,
        args: HostDaemonArgs,
        started: boolean
    ): Promise<RunnerResolution> {
        const features = daemon?.clientFeatures ?? []
        const missing = (args.requiredFeatures ?? []).filter(
            (feature) => !features.includes(feature)
        )
        if (missing.length) {
            this.logger.warn(
                `daemon on host ${host.id} lacks required features ${missing.join(',')} for agent ${args.agentId ?? '-'}`
            )
            return unavailable('runner_unavailable')
        }
        const handle: RunnerHandle = {
            daemonId: host.id,
            started,
            generation: leaseGeneration(daemon)
        }
        const workspace = await this.workspacePreflight(
            host,
            daemon,
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
        for (const root of args.extraRoots ?? [])
            await this.workspacePreflight(host, daemon, root)
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

    private singleFlightBringUp(args: HostDaemonArgs): Promise<RunnerBringUp> {
        const inFlight = this.bringUps.get(args.host.id)
        if (inFlight) return inFlight
        const attempt = this.bringUp(args).finally(() => {
            this.bringUps.delete(args.host.id)
        })
        this.bringUps.set(args.host.id, attempt)
        return attempt
    }

    private async adapterFor(host: RuntimeHostRow): Promise<{
        provider: RuntimeProvider
        adapter: SandboxProvider
    }> {
        const provider = await this.clients.providerForHost(host)
        return { provider, adapter: this.providers.for(provider.kind) }
    }

    // R11 for a hosted host whose daemon is not online: observe power, wake a
    // suspended or stopped machine and give the thawed daemon a moment to
    // dial back in; otherwise bootstrap — install mf, register with a token
    // bound to this host, start — under a fresh generation.
    private async bringUp(args: HostDaemonArgs): Promise<RunnerBringUp> {
        const { host } = args
        const tag = `hostId=${host.id} agentId=${args.agentId ?? '-'}`
        try {
            const { provider, adapter } = await this.adapterFor(host)
            const since = new Date()
            const power = await adapter.power({ host, provider })
            await recordPower(this.hosts, host.id, power)
            if (power === 'suspended' || power === 'stopped') {
                await adapter.wake({ host, provider, generation: host.generation })
                const woken = await this.waitForLease(
                    host,
                    since,
                    WAKE_RECONNECT_WAIT_MS
                )
                if (woken) {
                    this.logger.log(`daemon reconnected after wake ${tag}`)
                    return { handle: woken }
                }
            }
            const generation = await this.hosts.bumpGeneration(host.id)
            const call: ProviderCall = { host, provider, generation }
            const inspected = await this.inspect(
                adapter,
                call,
                args.firstExecTimeoutMs
            )
            const state = inspected.state
            // Stop at the inspect when the inspect is what proved the endpoint
            // cannot serve a socket: install, register and start would each
            // pay the same failing handshake, and register would mint a token
            // for a machine nothing can reach.
            if (!state)
                return inspected.execFailure
                    ? { handle: null, execFailure: inspected.execFailure }
                    : { handle: null }
            const prepared = await this.installAndRegister(adapter, call, state)
            if (prepared !== 'ok') return { handle: null }
            const waitMs = args.waitOnlineMs ?? DEFAULT_WAIT_ONLINE_MS
            let online = await this.startHeldAwake(adapter, call, () =>
                this.waitOnline(host, waitMs)
            )
            if (!online) {
                this.logger.warn(`daemon did not come online ${tag}`)
                const tail = await this.logTail(adapter, call)
                // A rejected credential is terminal on its own: the machine
                // still has a config, so the inspect reports registered=1
                // forever and nothing would ever mint a replacement.
                // Re-register once.
                if (/unauthorized|4401/i.test(tail ?? '')) {
                    this.logger.warn(
                        `daemon credential rejected, re-registering ${tag}`
                    )
                    if (!(await this.register(adapter, call)).ok)
                        return { handle: null }
                    online = await this.startHeldAwake(adapter, call, () =>
                        this.waitOnline(host, waitMs)
                    )
                }
                if (!online) return { handle: null }
            }
            this.logger.log(`daemon online ${tag} generation=${generation}`)
            return { handle: online }
        } catch (err) {
            if (err instanceof StaleGenerationError)
                this.logger.log(`daemon bring-up superseded ${tag}`)
            else
                this.logger.warn(
                    `daemon bring-up failed ${tag} class=${errorClass(err)}`
                )
            return { handle: null }
        }
    }

    // A daemon that is registered but not answering, made to answer — for
    // the callers that talk to it OUTSIDE a turn (the runtime page's auth.*
    // RPCs). A turn never needs this: its own execs wake the sprite and its
    // awake lease keeps it up, so a frozen daemon thaws under the turn's first
    // RPC. An auth.* call has neither, and the daemon row cannot tell it the
    // process is frozen: a suspended process misses pings but keeps its 45s
    // lease, so presence says yes for up to a minute after the VM went to
    // sleep. Seen on staging 2026-09-10: the daemon heartbeated at :27, the
    // sprite suspended at :35, `auth.create` at :41 sat on the frozen socket
    // for the full 20s RPC timeout, twice, before the pong deadline dropped
    // it. Nothing here throws: no daemon is a legitimate answer.
    async wakeRunner(args: {
        host: RuntimeHostRow
        waitOnlineMs?: number
    }): Promise<RunnerWakeResult> {
        const { host } = args
        const since = new Date()
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (host.kind === 'local')
            return daemon && daemonOnline(daemon)
                ? { handle: handleFor(host, daemon, false), outcome: 'live' }
                : { handle: null, outcome: 'not-online' }
        try {
            const { provider, adapter } = await this.adapterFor(host)
            const power = await adapter.power({ host, provider })
            await recordPower(this.hosts, host.id, power)
            if (power === 'suspended' || power === 'stopped')
                await adapter.wake({ host, provider, generation: host.generation })
            // The API still holds the socket: the process that just thawed
            // answers on it, and the next RPC is the proof. Waiting for a
            // pong here would only add up to a ping interval of latency.
            const current = await this.hostDaemons.findByHostId(host.id)
            if (current && daemonOnline(current) && power === 'running')
                return { handle: handleFor(host, current, false), outcome: 'live' }
            // Either the process thawed and is dialling back in, or it is
            // gone with the VM (a cold start keeps the config on disk).
            const reconnected = await this.waitForLease(
                host,
                since,
                WAKE_RECONNECT_WAIT_MS
            )
            if (reconnected) return { handle: reconnected, outcome: 'reconnected' }
            const generation = await this.hosts.bumpGeneration(host.id)
            const call: ProviderCall = { host, provider, generation }
            const process = await this.probeRunnerProcess(adapter, call)
            if (
                process.kind === 'running' &&
                (process.activeExecs - process.adoptableExecs > 0 ||
                    process.activePtys > 0)
            ) {
                this.logger.warn(
                    `daemon silent but busy, not restarting hostId=${host.id} execs=${process.activeExecs} adoptable=${process.adoptableExecs} ptys=${process.activePtys}`
                )
                return { handle: null, outcome: 'busy' }
            }
            const inspected = await this.inspect(adapter, call)
            if (!inspected.state) return { handle: null, outcome: 'exec-failed' }
            const wasRegistered =
                inspected.state.registered &&
                !isCliVersionTooOld(inspected.state.version, DAEMON_MIN_CLI_VERSION)
            const prepared = await this.installAndRegister(
                adapter,
                call,
                inspected.state
            )
            if (prepared !== 'ok') return { handle: null, outcome: 'not-online' }
            const started = await this.startHeldAwake(adapter, call, () =>
                this.waitForLease(
                    host,
                    since,
                    args.waitOnlineMs ?? DEFAULT_WAIT_ONLINE_MS
                )
            )
            if (!started) {
                const tail = await this.logTail(adapter, call)
                this.logger.warn(
                    `daemon did not come back after wake hostId=${host.id} tail=${tail ?? '(none)'}`
                )
                return { handle: null, outcome: 'not-online' }
            }
            return {
                handle: started,
                outcome: wasRegistered ? 'restarted' : 'brought-up'
            }
        } catch (err) {
            this.logger.warn(
                `daemon wake failed hostId=${host.id} class=${errorClass(err)}`
            )
            return { handle: null, outcome: 'exec-failed' }
        }
    }

    // The sandbox CLI upgrade installs over ~/.local/bin/mf, but a sprite's
    // daemon is a long-lived process with no supervisor: nothing re-execs it,
    // its own daemon.update refuses without an init unit, auto-update is off
    // for a manual start, and a warm sprite resume brings the OLD process
    // back. Its heartbeat keeps reporting the build it was started with —
    // cliVersion and clientFeatures alike — so every capability gate reads the
    // pre-upgrade daemon while the sandbox row says the upgrade landed.
    // Seen on staging 2026-09-10.
    //
    // Never at the cost of a turn: a daemon with live sessions is left alone,
    // and nothing here throws — the caller's upgrade already landed on disk.
    async restartForInstalledCli(args: {
        host: RuntimeHostRow
        installedVersion: string
        waitMs?: number
    }): Promise<RunnerRestartOutcome> {
        const { host } = args
        try {
            const daemon = await this.hostDaemons.findByHostId(host.id)
            if (!daemon) return 'no-runner'
            const { provider, adapter } = await this.adapterFor(host)
            const generation = await this.hosts.bumpGeneration(host.id)
            const call: ProviderCall = { host, provider, generation }
            const state = await this.probeRunnerProcess(adapter, call)
            if (state.kind === 'not-running') return 'not-running'
            if (state.kind === 'running') {
                if (state.version === args.installedVersion) return 'current'
                // Execs the next daemon adopts do not hold the restart back:
                // the stop passes --keep-execs to a daemon that reports them.
                if (
                    state.activeExecs - state.adoptableExecs > 0 ||
                    state.activePtys > 0
                ) {
                    this.logger.warn(
                        `daemon busy, keeping ${state.version ?? 'unknown'} hostId=${host.id} execs=${state.activeExecs} adoptable=${state.adoptableExecs} ptys=${state.activePtys}`
                    )
                    return 'busy'
                }
            }
            // 'unknown' falls through on purpose: a daemon too old to answer
            // its own control socket is the one a restart helps most.
            const reported = await this.startHeldAwake(adapter, call, () =>
                this.waitForCliVersion(host, args.installedVersion, args.waitMs)
            )
            if (!reported) {
                const tail = await this.logTail(adapter, call)
                this.logger.warn(
                    `daemon did not report ${args.installedVersion} after restart hostId=${host.id} tail=${tail ?? '(none)'}`
                )
                return 'restart-timeout'
            }
            this.logger.log(
                `daemon restarted on ${args.installedVersion} hostId=${host.id}`
            )
            return 'restarted'
        } catch (err) {
            this.logger.warn(
                `daemon restart failed hostId=${host.id} class=${errorClass(err)}`
            )
            return 'failed'
        }
    }

    // A daemon that can update itself (ADR-0029 §5: a manual start that
    // advertises daemon.update.manual) is upgraded through daemon.update —
    // it downloads, prechecks, swaps, hands its execs to a successor and
    // rolls back on its own — instead of the platform installing over it and
    // restarting it. `not-capable` sends the caller down the install path.
    async upgradeViaDaemon(args: {
        host: RuntimeHostRow
        targetVersion?: string
        channel?: MfCliChannel
    }): Promise<
        | { kind: 'not-capable' }
        | { kind: 'dispatched'; toVersion: string | null; deferred: boolean }
        | { kind: 'failed'; error: string }
    > {
        const daemon = await this.hostDaemons.findByHostId(args.host.id)
        if (
            !daemon ||
            !daemonOnline(daemon) ||
            !daemon.clientFeatures.includes(DAEMON_FEATURE_MANUAL_UPDATE)
        )
            return { kind: 'not-capable' }
        const payload: Record<string, unknown> = {}
        if (args.targetVersion) payload.targetVersion = args.targetVersion
        if (args.channel) payload.channel = args.channel
        try {
            const ack = await this.registry.rpc({
                daemonId: args.host.id,
                method: 'daemon.update',
                payload,
                timeoutMs: RUNNER_UPGRADE_RPC_TIMEOUT_MS
            })
            const toVersion =
                typeof ack?.toVersion === 'string' ? ack.toVersion : null
            const deferred = ack?.deferred === true
            this.logger.log(
                `daemon upgrade via daemon.update hostId=${args.host.id} to=${toVersion ?? 'latest'} deferred=${deferred}`
            )
            return { kind: 'dispatched', toVersion, deferred }
        } catch (err) {
            const error = (err as Error).message
            this.logger.warn(
                `daemon upgrade via daemon.update failed hostId=${args.host.id}: ${error}`
            )
            return { kind: 'failed', error }
        }
    }

    // herdr inside the machine, through the daemon (ADR-0031): the daemon
    // runs herdr's updater and reports the version it left behind.
    async upgradeHerdrViaDaemon(args: { host: RuntimeHostRow }): Promise<
        | { kind: 'not-capable' }
        | { kind: 'dispatched'; toVersion: string | null }
        | { kind: 'failed'; error: string }
    > {
        const daemon = await this.hostDaemons.findByHostId(args.host.id)
        if (
            !daemon ||
            !daemonOnline(daemon) ||
            !daemon.clientFeatures.includes(DAEMON_FEATURE_HERDR_TERMINAL)
        )
            return { kind: 'not-capable' }
        try {
            const ack = await this.registry.rpc({
                daemonId: args.host.id,
                method: 'herdr.update',
                payload: {},
                timeoutMs: RUNNER_UPGRADE_RPC_TIMEOUT_MS
            })
            return {
                kind: 'dispatched',
                toVersion:
                    typeof ack?.toVersion === 'string' ? ack.toVersion : null
            }
        } catch (err) {
            const error = (err as Error).message
            this.logger.warn(
                `herdr upgrade via herdr.update failed hostId=${args.host.id}: ${error}`
            )
            return { kind: 'failed', error }
        }
    }

    // A custom workspace (CreateAgentDto.workspace on a shared sandbox) lives
    // outside the machine-scoped root the daemon registered, and the daemon
    // exec guard refuses a cwd it does not know.
    // Seen on staging 2026-08-04: a claude agent co-resident on a sandbox with
    // its workspace in another framework's home failed every daemon turn with
    // `outside allowed roots`. Register the path as a workspace root before
    // dispatching. A failure here fails the turn: a daemon that will not admit
    // the workspace cannot run it.
    private async workspacePreflight(
        host: RuntimeHostRow,
        daemon: HostDaemonRow | null,
        workspacePath: string | null | undefined
    ): Promise<{
        outcome: WorkspacePreflightOutcome
        ensureMs?: number
        reason?: RunnerFallbackReason
    }> {
        const path = workspacePath
        if (!path) return { outcome: 'none' }
        const base = host.workspaceBaseDir?.replace(/\/+$/, '')
        if (base && (path === base || path.startsWith(`${base}/`)))
            return { outcome: 'base' }
        // The generation comes from the daemon row's rpc lease, not a local
        // socket map: the socket may live on the peer api instance, but every
        // instance sees the same lease. Rows without a lease (mid-reconnect
        // race) never hit the cache and always re-ensure — the safe direction.
        const generation = leaseGeneration(daemon)
        const cached = generation
            ? this.ensuredWorkspaces.get(host.id)
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
                daemonId: host.id,
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
                this.ensuredWorkspaces.set(host.id, entry)
            }
            return { outcome: 'ensured', ensureMs: Date.now() - startedAt }
        } catch (err) {
            const message = (err as Error).message
            this.logger.warn(
                `daemon workspace register failed hostId=${host.id} class=${errorClass(err)}`
            )
            return {
                outcome: 'failed',
                ensureMs: Date.now() - startedAt,
                reason: classifyWorkspaceEnsureFailure(message)
            }
        }
    }

    // The install-and-register half of a bring-up. A daemon that is merely
    // PRESENT is not good enough: the platform owns this binary and nothing
    // else ever updates it, so a machine keeps its first CLI indefinitely —
    // including bugs since fixed in it. Below the floor it is reinstalled.
    private async installAndRegister(
        adapter: SandboxProvider,
        call: ProviderCall,
        state: RunnerMachineState
    ): Promise<'ok' | 'install-failed' | 'register-failed'> {
        const tooOld = isCliVersionTooOld(state.version, DAEMON_MIN_CLI_VERSION)
        if (!state.installed || tooOld) {
            if (tooOld && state.installed)
                this.logger.log(
                    `daemon CLI ${state.version ?? 'unknown'} < ${DAEMON_MIN_CLI_VERSION}, upgrading hostId=${call.host.id}`
                )
            if (!(await this.installCli(adapter, call))) return 'install-failed'
        }
        // herdr rides along with the daemon (ADR-0031), best effort: a
        // machine without it still chats, it just cannot hand a session to
        // herdr until the Update Center installs it.
        if (state.herdr === false) await this.installHerdr(adapter, call)
        if (!state.registered) {
            let registered = await this.register(adapter, call)
            // A CLI that predates `--token -` takes the dash LITERALLY and
            // rejects it as a malformed token: `~/.local/bin/mf` is there (so
            // the install step is skipped) but it is a legacy binary.
            if (
                !registered.ok &&
                isStaleCliRegisterFailure(registered.detail)
            ) {
                this.logger.warn(
                    `daemon CLI too old to read the token from stdin, reinstalling hostId=${call.host.id}`
                )
                if (!(await this.installCli(adapter, call)))
                    return 'install-failed'
                registered = await this.register(adapter, call)
            }
            if (!registered.ok) return 'register-failed'
        }
        return 'ok'
    }

    // One round trip that both WAKES a sprite (any exec resumes it) and
    // reports what is already there, so the common "already installed and
    // registered" case costs a single exec. It is also the only native exec
    // in the bring-up that is SAFE to classify the endpoint from: a read-only
    // probe, first on the wire, with nothing before it that could have broken
    // the socket.
    private async inspect(
        adapter: SandboxProvider,
        call: ProviderCall,
        timeoutMs?: number
    ): Promise<RunnerInspection> {
        const layout = layoutFor(call.provider)
        const script = [
            `test -x ${MF_BIN} && echo installed=1 || echo installed=0`,
            `test -f "${layout.probePath}" && echo registered=1 || echo registered=0`,
            // Free: we are already paying for this exec. Without it the daemon
            // keeps whatever CLI it was first given, forever.
            `echo version=$(${MF_BIN} --version 2>/dev/null | tr -d '[:space:]')`,
            // Only a non-empty herdr counts, so the install replaces an empty
            // one. Checked, never run: a herdr that hangs must not read as a
            // dead exec endpoint. Seen on prod [2026-09-26]: a 0-byte
            // ~/.local/bin/herdr passed `test -x`, and the daemon probing it
            // died on ENOEXEC every start.
            `h=$(command -v herdr 2>/dev/null || echo "$HOME/.local/bin/herdr"); test -x "$h" && test -s "$h" && echo herdr=1 || echo herdr=0`
        ].join('; ')
        let res
        try {
            res = await adapter.bootstrap({
                ...call,
                script,
                timeoutMs: timeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS
            })
        } catch (err) {
            if (err instanceof StaleGenerationError) throw err
            const execFailure = classifyExecEndpointFailure(err)
            this.logger.warn(
                `daemon inspect exec failed hostId=${call.host.id} class=${execFailure?.failureClass ?? errorClass(err)}`
            )
            return execFailure ? { state: null, execFailure } : { state: null }
        }
        if (res.exitCode !== 0) {
            this.logger.warn(
                `daemon inspect failed hostId=${call.host.id} exit=${res.exitCode}`
            )
            return { state: null }
        }
        return {
            state: {
                installed: res.stdout.includes('installed=1'),
                registered: res.stdout.includes('registered=1'),
                version: /version=([^\s]+)/.exec(res.stdout)?.[1] ?? null,
                herdr: res.stdout.includes('herdr=1')
                    ? true
                    : res.stdout.includes('herdr=0')
                      ? false
                      : null
            }
        }
    }

    private async installHerdr(
        adapter: SandboxProvider,
        call: ProviderCall
    ): Promise<void> {
        try {
            const res = await adapter.bootstrap({
                ...call,
                script: buildHerdrInstallScript(),
                timeoutMs: 180_000
            })
            if (res.exitCode !== 0 || !res.stdout.includes(HERDR_INSTALL_MARKER))
                this.logger.warn(
                    `daemon herdr install failed hostId=${call.host.id} exit=${res.exitCode}`
                )
        } catch (err) {
            if (err instanceof StaleGenerationError) throw err
            this.logger.warn(
                `daemon herdr install failed hostId=${call.host.id}: ${(err as Error).message}`
            )
        }
    }

    private async installCli(
        adapter: SandboxProvider,
        call: ProviderCall
    ): Promise<boolean> {
        // Same installer sprite provisioning uses, so a staging machine gets
        // the staging CLI: hardcoding the stable URL here meant staging ran a
        // prod build of the very component whose protocol changes staging
        // exists to validate.
        const channel = cliInstallChannelForDeployEnv(
            resolveMfDeployEnv(process.env.MF_DEPLOY_ENV)
        )
        const res = await adapter.bootstrap({
            ...call,
            script: buildCliInstallScript(channel),
            timeoutMs: 180_000
        })
        if (res.exitCode !== 0)
            this.logger.warn(
                `daemon cli install failed hostId=${call.host.id} exit=${res.exitCode}`
            )
        return res.exitCode === 0
    }

    // Register with a token minted BOUND to the host (ADR-0036 R5): it can
    // only ever land on this host, and the daemon it starts is this host's.
    // The token is passed on STDIN — never argv, which would put it in the
    // machine's process list.
    private async register(
        adapter: SandboxProvider,
        call: ProviderCall
    ): Promise<{ ok: boolean; detail: string }> {
        const { host, provider } = call
        const layout = layoutFor(provider)
        const minted = await this.tokens.mint({
            userId: host.userId,
            name: `daemon:${host.id}`,
            ...(provider.kind === 'k8s' ? {} : { expiresInDays: TOKEN_TTL_DAYS }),
            hostId: host.id
        })
        const res = await adapter
            .bootstrap({
                ...call,
                script:
                    `${layout.envPrefix} ${MF_BIN} --api-url ${this.apiUrl()} ` +
                    `daemon register --token - --name ${shellQuote(host.name)}`,
                stdin: minted.plaintext,
                timeoutMs: 180_000
            })
            .catch(async (err: unknown) => {
                await this.discardToken(minted.tokenId, host)
                throw err
            })
        const ok = res.exitCode === 0
        const detail = redactCredentialText(
            `${res.stdout} ${res.stderr}`
        ).slice(0, 400)
        if (!ok) {
            // The CLI's own words are the only clue to WHY (an API the machine
            // cannot reach, a rejected token, an old binary); the token itself
            // went over stdin and is never in this output.
            this.logger.warn(
                `daemon register failed hostId=${host.id} exit=${res.exitCode} detail=${detail.replace(/\s+/g, ' ').trim().slice(0, 200) || '(no output)'}`
            )
            await this.discardToken(minted.tokenId, host)
        }
        return { ok, detail }
    }

    // A bring-up that never registered leaves behind a credential valid for
    // 90 days that can still open the daemon websocket. Seen on production
    // [2026-08-12]: 30 rejected bring-ups in 13h, one such token each. A
    // register the exec lost the answer to keeps a live daemon's credential
    // only until its next bring-up, which re-registers on the 4401.
    private async discardToken(
        tokenId: string,
        host: RuntimeHostRow
    ): Promise<void> {
        await this.tokens
            .revoke({ tokenId, userId: host.userId })
            .catch((err: Error) =>
                this.logger.warn(
                    `daemon token cleanup failed hostId=${host.id} class=${errorClass(err)}`
                )
            )
    }

    private async start(
        adapter: SandboxProvider,
        call: ProviderCall
    ): Promise<void> {
        const daemon = await this.hostDaemons.findByHostId(call.host.id)
        // A daemon that runs execs as files (ADR-0029 §4) is stopped with
        // --keep-execs: whatever turn it was carrying stays alive for the
        // daemon started right after to adopt. Only a daemon that advertised
        // the capability gets the flag — an older CLI would refuse the
        // unknown option and never stop.
        const keepExecs = (daemon?.clientFeatures ?? []).includes(
            DAEMON_FEATURE_EXEC_FILES
        )
        const layout = layoutFor(call.provider)
        const mf = `${MF_BIN} --api-url ${this.apiUrl()}`
        const res = await adapter.bootstrap({
            ...call,
            script: `${layout.envPrefix} ${layout.start(mf, keepExecs)}`,
            timeoutMs: 90_000
        })
        this.logger.log(
            `daemon start hostId=${call.host.id} exit=${res.exitCode} procs=${res.stdout.trim().slice(-4)}`
        )
    }

    // Start, then wait for the daemon to dial in, with the sprite held awake
    // for the whole wait. Once the start exec returns nothing is running in the
    // VM, it suspends within seconds, and the daemon freezes before its first
    // connect: every wait on a start has to hold the sprite itself.
    // Seen on prod [2026-09-26]: `runner start` at 06:56:23, the sprite warm at
    // :26, `runner did not come online` at 06:58:24, and the daemon's hello in
    // that same second, because the log-tail exec had woken the VM.
    // Measured on prod [2026-09-26]: a fresh daemon needs ~6s running to
    // connect, and its first start after a CLI upgrade ~60s.
    private async startHeldAwake<T>(
        adapter: SandboxProvider,
        call: ProviderCall,
        waitFor: () => Promise<T>
    ): Promise<T> {
        const hold = this.keepSpriteAwake({
            host: call.host,
            turnId: `start-${randomUUID()}`
        })
        try {
            await this.start(adapter, call)
            return await waitFor()
        } finally {
            void hold.release()
        }
    }

    // The daemon's own log is the only place that says WHY it never connected
    // (refused to start, wrong api url, auth rejected). A pod's daemon logs
    // to the container, which the pod's own logs carry.
    private async logTail(
        adapter: SandboxProvider,
        call: ProviderCall
    ): Promise<string | null> {
        const layout = layoutFor(call.provider)
        if (!layout.logPath) return null
        const res = await adapter
            .bootstrap({
                ...call,
                script: `tail -n 6 ${layout.logPath} 2>/dev/null || echo "(no runner log)"`,
                timeoutMs: 30_000
            })
            .catch((err: Error) => {
                this.logger.warn(
                    `daemon log tail unavailable hostId=${call.host.id} class=${errorClass(err)}`
                )
                return null
            })
        if (!res) return null
        return redactCredentialText(res.stdout).replace(/\s+/g, ' ')
    }

    // A daemon turn produces NO platform-visible activity on a sprite: with
    // the exec running INSIDE the sprite (via the daemon) rather than as a
    // sprite exec session, the platform sees an idle VM, suspends it, the
    // frozen daemon stops answering websocket pings, and the API drops it
    // mid-turn. Seen on staging 2026-07-25.
    //
    // So a daemon turn has to hold the sprite awake itself. `/v1/tasks` is the
    // platform's own activity lease, reachable from inside the sprite. The
    // lease carries a TTL rather than being renewed from here on purpose: if
    // this API instance dies mid-turn the task expires on its own, the sprite
    // suspends, and nothing leaks — the user-facing keep-awake switch (with its
    // quota and billing meaning) is left completely alone. A long turn is kept
    // alive by renewal, and the renew timer dies with the process that owns
    // the turn. A host that is not a sprite has nothing to hold.
    keepSpriteAwake(args: {
        host: RuntimeHostRow
        turnId: string
    }): SpriteAwakeHold {
        if (args.host.providerRef?.kind !== 'sprites') return NOOP_HOLD
        // The create and every renew stay fire-and-forget, but release() waits
        // for whichever was last in flight before it deletes. A hold settled
        // on its first poll would otherwise race its own DELETE past the POST
        // and leave a full-TTL lease that nobody renews and nothing needs.
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
            // The turn was SUSPENDED, not finished: the daemon is still working
            // and will hand the answer to whoever picks the stream up next.
            // Deleting the lease here would let the sprite suspend and freeze it
            // mid-answer, so stop renewing and let the TTL bound the leak.
            detach: () => {
                stop()
            }
        }
    }

    async holdSpriteAwake(args: {
        host: RuntimeHostRow
        turnId?: string
        ttl?: string
    }): Promise<boolean> {
        if (args.host.providerRef?.kind !== 'sprites') return true
        const turnId = args.turnId ?? `hold-${args.host.id}`
        const ttl = args.ttl ?? AUTH_AWAKE_TTL
        const name = awakeTaskName(turnId)
        const create = JSON.stringify({ name, expire: ttl })
        const renew = JSON.stringify({ expire: ttl })
        // Copied from the proven keep-alive script (packages/sprites tasks.ts):
        // the path goes straight after -X and BEFORE -d, with no -H/-o/-w. My
        // first attempt added those and put the path last, which made curl exit
        // 3 (malformed URL) on every turn — the hold silently never happened.
        // Create-or-renew, so a retry of the same turn is not a failure either.
        const res = await this.spriteExec(args.host)
            .then((exec) =>
                exec({
                    cmd: [
                        'bash',
                        '-lc',
                        `sprite-env curl -s -X POST /v1/tasks -d ${shellQuote(create)} >/dev/null 2>&1 ` +
                            `|| sprite-env curl -s -X PUT ${shellQuote(`/v1/tasks/${name}`)} -d ${shellQuote(renew)} >/dev/null 2>&1`
                    ],
                    timeoutMs: 60_000
                })
            )
            .catch(() => null)
        const ok = res?.exitCode === 0
        if (!ok)
            this.logger.warn(
                `sprite awake-hold failed hostId=${args.host.id} turnId=${turnId} exit=${res?.exitCode}`
            )
        return ok
    }

    async releaseSpriteAwake(args: {
        host: RuntimeHostRow
        turnId: string
    }): Promise<void> {
        if (args.host.providerRef?.kind !== 'sprites') return
        const name = awakeTaskName(args.turnId)
        await this.spriteExec(args.host)
            .then((exec) =>
                exec({
                    cmd: [
                        'bash',
                        '-lc',
                        `sprite-env curl -s -X DELETE ${shellQuote(`/v1/tasks/${name}`)} >/dev/null 2>&1`
                    ],
                    timeoutMs: 30_000
                })
            )
            .catch((err: Error) => {
                // The TTL is the backstop, so a failed release only means the
                // sprite stays awake a little longer than necessary.
                this.logger.warn(
                    `sprite awake-release failed turnId=${args.turnId} class=${errorClass(err)}`
                )
                return null
            })
    }

    // Test seam: the sprite exec opens a real WebSocket.
    protected spriteExec(host: RuntimeHostRow): Promise<HostExecFn> {
        return this.clients.spriteExecForHost(host)
    }

    private async waitOnline(
        host: RuntimeHostRow,
        waitMs: number
    ): Promise<RunnerHandle | null> {
        const deadline = Date.now() + waitMs
        for (;;) {
            const daemon = await this.hostDaemons.findByHostId(host.id)
            if (daemon && daemonOnline(daemon))
                return handleFor(host, daemon, true)
            if (Date.now() >= deadline) return null
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    // A lease the API recorded AFTER `since`: a pong or a connect from a
    // process that was demonstrably running at that moment. Presence alone is
    // the wrong test here — it is what a frozen process still passes.
    private async waitForLease(
        host: RuntimeHostRow,
        since: Date,
        waitMs: number
    ): Promise<RunnerHandle | null> {
        const deadline = Date.now() + waitMs
        for (;;) {
            const daemon = await this.hostDaemons.findByHostId(host.id)
            if (
                daemon &&
                daemonOnline(daemon) &&
                daemon.rpcLastSeenAt &&
                daemon.rpcLastSeenAt.getTime() >= since.getTime()
            )
                return handleFor(host, daemon, true)
            if (Date.now() >= deadline) return null
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    // Online is not enough after a restart: the socket lease flips on connect,
    // the version on the first heartbeat, and a row that is online on the OLD
    // version is exactly the state a restart is meant to leave.
    private async waitForCliVersion(
        host: RuntimeHostRow,
        version: string,
        waitMs?: number
    ): Promise<boolean> {
        const deadline = Date.now() + (waitMs ?? RESTART_WAIT_MS)
        for (;;) {
            const daemon = await this.hostDaemons.findByHostId(host.id)
            if (daemon && daemonOnline(daemon) && daemon.cliVersion === version)
                return true
            if (Date.now() >= deadline) return false
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    // The running daemon's own word on what it is and whether it is busy, via
    // the control socket the runner profile owns. The daemon row cannot
    // answer either: its cliVersion is whatever the process last heartbeated
    // (true, but that is the question), and the API has no cross-instance
    // view of live sessions.
    private async probeRunnerProcess(
        adapter: SandboxProvider,
        call: ProviderCall
    ): Promise<RunnerProcessState> {
        const layout = layoutFor(call.provider)
        const res = await adapter.bootstrap({
            ...call,
            script: `${layout.envPrefix} ${MF_BIN} daemon status --json`,
            timeoutMs: STATUS_PROBE_TIMEOUT_MS
        })
        if (res.exitCode !== 0) {
            this.logger.warn(
                `daemon status probe failed hostId=${call.host.id} exit=${res.exitCode}`
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

const handleFor = (
    host: RuntimeHostRow,
    daemon: HostDaemonRow,
    started: boolean
): RunnerHandle => ({
    daemonId: host.id,
    started,
    generation: leaseGeneration(daemon)
})

const unavailable = (reason: RunnerFallbackReason): RunnerResolution => ({
    handle: null,
    fallbackReason: reason,
    workspace: { outcome: 'none' }
})

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
            adoptableExecs?: unknown
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
            adoptableExecs:
                typeof local.adoptableExecs === 'number'
                    ? local.adoptableExecs
                    : 0,
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
