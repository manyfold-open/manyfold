import { runnerApiUrl } from '@/common/public-api-url'
import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import {
    DAEMON_FEATURE_EXEC_FILES,
    DAEMON_FEATURE_SERVICES,
    DAEMON_MIN_CLI_VERSION,
    K8S_HOME_BASE,
    POD_RUNNER_PROFILE,
    RUNNER_PROFILE,
    SANDBOX_DAEMON_SERVICE,
    isCliVersionTooOld,
    profilePaths
} from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import type {
    HostDaemonRow,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'
import { resolveMfDeployEnv } from '@/common/deploy-env'
import {
    buildCliInstallScript,
    cliInstallChannelForDeployEnv,
    buildHerdrInstallScript,
    buildShellEnvScript,
    HERDR_INSTALL_MARKER
} from '@/modules/agent-self/sprite-shell-env.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import {
    HostDaemonsService,
    hasRpcLease
} from '@/modules/hosts/host-daemons.service'
import {
    HostAwakeService,
    type AwakeHold
} from '@/modules/hosts/host-awake.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import {
    SandboxProviderRegistry,
    StaleGenerationError,
    type ExecEndpointFailure,
    type ExecEndpointFailureClass,
    type ProviderCall,
    type SandboxProvider,
    type SupervisedProcess
} from '@/modules/hosts/providers/sandbox-provider'
import { recordPower } from '@/modules/hosts/providers/generation'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'
import {
    HostCliService,
    HostCliTooOldError,
    HostCliUpdatingError,
    type HostCliRefusal
} from './host-cli.service'

// Bring a hosted host's daemon up so a turn — or anything else that happens
// inside the machine — can go through the daemon protocol (ADR-0037 R11):
// Agent → Runtime → Host → host_daemons. Online → RPC. Not online → the
// provider adapter's power / wake / bootstrap, in that order, then RPC. A
// local host's daemon is the user's to start: offline is `runner_unavailable`.
//
// Measured on a real sprite 2026-07-24: two probe results shape everything
// here.
//   - a reverse WSS from inside a sprite to the API works (GET /api/daemon/ws
//     answers 101), and `mf daemon` runs there — but the sprite has no systemd,
//     so the daemon runs under the sprite's own service supervisor, started
//     by us (SPRITE_LAYOUT);
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
// What the inspect got before a caller could bound it. Kept as the default so a
// caller without an exec-health budget behaves exactly as it did.
const DEFAULT_INSPECT_TIMEOUT_MS = 60_000
// After a wake thawed a registered daemon whose socket the API had already
// dropped, how long its own reconnect gets before the process is restarted.
// The daemon's ws client forces a reconnect when it detects the clock jump a
// suspension leaves behind, and its backoff starts at 1s, so a live process is
// back on a fresh lease within a few seconds; a process that is not back by
// then is wedged or gone, and `daemon stop; daemon start` is what helps.
const WAKE_RECONNECT_WAIT_MS = 15_000
// A machine woken from cold boots first; only then does its supervisor's loop
// start the daemon that dials in. Restarting it after a thaw's wait instead
// meets a machine still booting: the inspect times out and the turn fails.
// Seen on prod [2026-10-04]: a turn gave up 30s after the wake and its daemon
// dialed in 13s later.
// Measured on prod [2026-10-05]: of 558 wakes over 7 days that found a sprite
// stopped and saw its daemon back, 82% were back within 15s, 95% within 60s
// and 98% within 90s; the slowest took 159s.
const COLD_WAKE_RECONNECT_WAIT_MS = 90_000
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

export interface BringUpHandle {
    // The host id: the daemon's routing key (ADR-0037).
    hostId: string
    // false when the daemon was already connected (the common case).
    started: boolean
    // The rpc-lease generation the handle was resolved against
    // (`instance:connectedAtMs`), null while the lease is mid-reconnect.
    // Telemetry-only (#619): correlates a dispatch outcome with the socket
    // generation the resolution actually aimed at.
    generation: string | null
}

export type BringUpFallbackReason =
    | 'runner_unavailable'
    | 'runner_missing'
    | 'sprite_exec_unavailable'
    // hermes only, decided by the caller: the daemon came up but does not
    // advertise turn.hermes, so it cannot own the ACP client.
    | 'runner_missing_turn_rpc'
    // the host's daemon is older than the floor and could not be updated.
    | 'runner_cli_too_old'
    // the host's daemon updates once the work it has finishes: retry soon.
    | 'runner_updating'
    // the provider's health check reported the machine broken: nothing may
    // wake it until a re-check passes, so this is never worth retrying.
    | 'sandbox_maintenance'

// How the machine's exec endpoint refused the inspect, when the refusal is
// about the endpoint itself rather than about the command it was asked to run
// (the adapter judges it, ProviderErrorFacts.execFailure).

export interface BringUpResolution {
    handle: BringUpHandle | null
    fallbackReason?: BringUpFallbackReason
    // Present only with `sprite_exec_unavailable`: what the inspect proved about
    // the sprite exec endpoint, for the caller to quarantine on (#730).
    execFailure?: ExecEndpointFailure
    // With `runner_cli_too_old` after an update was tried: why it did not
    // give the daemon what was needed, and on which versions.
    cliRefusal?: HostCliRefusal
    // When the machine's own `mf daemon register` failed: what the CLI said,
    // the one clue to why its runner never connected.
    registerFailure?: string
}

interface BringUpMachineState {
    installed: boolean
    registered: boolean
    // The API the daemon config was registered against; null when there is no
    // config or it does not say.
    apiUrl: string | null
    version: string | null
    // herdr present on the machine (ADR-0031); null when the probe did not say.
    herdr: boolean | null
}

interface BringUpOutcome {
    handle: BringUpHandle | null
    execFailure?: ExecEndpointFailure
    registerFailure?: string
}

type BringUpInspection =
    | { state: BringUpMachineState }
    | { state: null; execFailure?: ExecEndpointFailure }

// Where the daemon's profile lives on each kind of machine, and how its
// process is (re)started there. On both, a loop restarts the daemon whenever
// it exits — a pod's boot script (ADR-0035), a sprite's supervised service —
// so stopping it IS starting it, and an update applies by exiting.
interface DaemonLayout {
    profile: string
    envPrefix: string
    probePath: string
    logPath: string | null
    start: (mf: string, keepExecs: boolean) => string
    // The loop the provider's own supervisor keeps running, when the machine's
    // main process is not already that loop.
    supervised: SupervisedProcess | null
    // Whether registering also writes the profile block every shell on the
    // machine reads (MF_API_URL, MF_DEPLOY_ENV), so `mf` run by an agent or
    // in a terminal talks to the API its daemon does. A pod's shells get
    // both from the pod's env.
    writesShellEnv: boolean
}

const SPRITE_RUNNER_LOG = '"$HOME/.manyfold/runner.log"'

// A sprite's daemon runs as a sprites service, which starts it again after
// the sprite's environment restarts (a cold boot): a daemon started by an
// exec does not come back from that. The service runs this loop rather than
// the daemon itself, because the service counts as running while any of its
// processes is left, and the daemon's own services outlive a daemon that
// exits. The pod's counterpart is docker/host/mf-host-boot.sh. `daemon start`
// dials the API its registration saved (ADR-0014), so the loop carries no
// URL of its own.
const SPRITE_DAEMON_LOOP = [
    `log=${SPRITE_RUNNER_LOG}`,
    "child=''",
    `trap 'trap "" TERM INT; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT`,
    'while :; do',
    '    "$HOME/.local/bin/mf" daemon start --foreground >>"$log" 2>&1 &',
    '    child=$!',
    '    wait "$child"',
    '    status=$?',
    "    child=''",
    '    echo "$(date -u +%FT%TZ) mf-daemon: daemon exited ($status); restarting in 5s" >>"$log"',
    '    sleep 5 &',
    '    child=$!',
    '    wait "$child"',
    "    child=''",
    'done'
].join('\n')

const SPRITE_LAYOUT: DaemonLayout = {
    profile: RUNNER_PROFILE,
    envPrefix: `export MF_PROFILE=${RUNNER_PROFILE};`,
    probePath: profilePaths('$HOME/.manyfold', RUNNER_PROFILE).daemonConfigPath,
    logPath: SPRITE_RUNNER_LOG,
    // `daemon stop` first: we only get here because the daemon is NOT online,
    // and one frozen by a suspension keeps running with a dead socket. The
    // loop starts it again; a daemon an older bring-up started by an exec is
    // stopped for the loop to take over. The process NAME is matched, not the
    // command line: `pgrep -f` also matches the bash wrapper running this
    // very script.
    start: (mf, keepExecs) =>
        `${mf} daemon stop${keepExecs ? ' --keep-execs' : ''} >/dev/null 2>&1 || true; ` +
        'pgrep -c -x mf || echo 0',
    supervised: {
        name: SANDBOX_DAEMON_SERVICE,
        command: ['bash', '-lc', SPRITE_DAEMON_LOOP],
        // The container marker is what the daemon reads as "a supervisor
        // restarts me": it takes `daemon.update` by exiting and runs
        // services (services.v1), as on a pod.
        env: { MF_PROFILE: RUNNER_PROFILE, MF_DAEMON_SUPERVISOR: 'container' }
    },
    writesShellEnv: true
}

const POD_CONFIG_ROOT = `${K8S_HOME_BASE}/.manyfold`

const POD_LAYOUT: DaemonLayout = {
    profile: POD_RUNNER_PROFILE,
    envPrefix: `export MF_PROFILE=${POD_RUNNER_PROFILE} MF_CONFIG_DIR=${POD_CONFIG_ROOT};`,
    probePath: profilePaths(POD_CONFIG_ROOT, POD_RUNNER_PROFILE).daemonConfigPath,
    logPath: null,
    start: (mf, keepExecs) =>
        `${mf} daemon stop${keepExecs ? ' --keep-execs' : ''} >/dev/null 2>&1 || true; ` +
        'pkill -TERM -x mf >/dev/null 2>&1 || true; sleep 2; pgrep -c -x mf || echo 0',
    supervised: null,
    writesShellEnv: false
}

const layoutFor = (provider: RuntimeProvider): DaemonLayout =>
    provider.kind === 'k8s' ? POD_LAYOUT : SPRITE_LAYOUT

const MF_BIN = '"$HOME/.local/bin/mf"'

const leaseGeneration = (daemon: HostDaemonRow | null | undefined): string | null =>
    daemon?.rpcInstanceId && daemon.rpcConnectedAt
        ? `${daemon.rpcInstanceId}:${daemon.rpcConnectedAt.getTime()}`
        : null

@Injectable()
export class HostBringUpService {
    private readonly logger = new Logger(HostBringUpService.name)
    // One in-flight bring-up per host: concurrent turns on the same machine
    // must not each install and register a daemon.
    private readonly bringUps = new Map<string, Promise<BringUpOutcome>>()
    private readonly resupervisions = new Map<string, Promise<HostDaemonRow | null>>()
    constructor(
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderResolver,
        private readonly tokens: DaemonTokenService,
        private readonly registry: DaemonRegistryService,
        private readonly awake: HostAwakeService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, a daemon lacking a feature is refused as too old.
        @Optional() private readonly hostCli?: HostCliService
    ) {}

    // Overridable in tests instead of injected: a function has no DI token, and
    // making it a constructor param broke the whole container at boot.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // The daemon of a host, reachable — brought up if the host is the
    // platform's and it is not (R11). Never throws: no daemon is an answer.
    //
    // Reachable means the API holds a socket to it (the rpc lease), never that
    // a heartbeat is recent: a heartbeat outlives a closed socket by up to the
    // presence window, which is exactly the window a turn used to fall into
    // (staging 2026-09-27: `workspace_connection_closed` on a machine that had
    // suspended 20s earlier). A hosted machine is held awake from here until
    // the caller's admission is done: the lease is what resumes a suspended
    // machine and what stops it suspending again between the wake and the
    // first RPC (ADR-0038). Callers that keep working hold their own; the
    // grace on release keeps the machine up across the hand-over.
    async ensureHostDaemon(args: HostDaemonArgs): Promise<BringUpResolution> {
        const { host } = args
        const daemon = await this.hostDaemons.findByHostId(host.id)
        if (host.kind === 'local') {
            // Only its owner can start a self-owned computer.
            if (!hasRpcLease(daemon)) return unavailable('runner_unavailable')
            return this.admit(host, daemon, args, false)
        }
        if (
            host.status === 'retired' ||
            host.status === 'deleting' ||
            host.status === 'failed'
        )
            return unavailable('runner_unavailable')
        // Refused before the hold: the hold is itself a wake.
        if (host.status === 'maintenance')
            return unavailable('sandbox_maintenance')
        const hold = this.awake.hold(host, `ensure-${args.agentId ?? host.id}`)
        try {
            // Awaited, not returned: the admission can update the daemon, and
            // the hold has to outlast that, not end when the promise is made.
            if (hasRpcLease(daemon))
                return await this.admit(host, daemon, args, false)
            const resolved = await this.singleFlightBringUp(args, hold)
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
                    ...(resolved.registerFailure
                        ? { registerFailure: resolved.registerFailure }
                        : {})
                }
            const fresh = await this.hostDaemons.findByHostId(host.id)
            return await this.admit(host, fresh, args, resolved.handle.started)
        } finally {
            void hold.release()
        }
    }

    // A fresh socket lease recorded after `since`: the proof a daemon that was
    // frozen, replaced or restarted is back. Callers that hit a dead
    // generation on their first RPC wait here, then retry once (ADR-0038).
    awaitReconnect(
        host: RuntimeHostRow,
        since: Date,
        waitMs = WAKE_RECONNECT_WAIT_MS
    ): Promise<BringUpHandle | null> {
        return this.waitForLease(host, since, waitMs)
    }

    // The exec-health probe (#730): `true` on the provider-native exec,
    // bounded by the caller's budget. Idempotent by construction, which is the
    // only reason running it on a host already suspected is safe at all. It is
    // an endpoint failure the breaker counts, ok, or inconclusive: everything
    // that failed without telling anything about this endpoint (an
    // account-wide refusal, a fact about the request, a bring-up that moved
    // the host's generation).
    async probeExec(
        host: RuntimeHostRow,
        timeoutMs: number
    ): Promise<'ok' | 'inconclusive' | ExecEndpointFailureClass> {
        let adapter: SandboxProvider | null = null
        try {
            const resolved = await this.adapterFor(host)
            adapter = resolved.adapter
            const res = await adapter.bootstrap({
                host,
                provider: resolved.provider,
                generation: host.generation,
                script: 'true',
                timeoutMs
            })
            // A non-zero exit means the socket opened and the machine
            // answered: no evidence against the endpoint, and no proof of its
            // recovery either.
            return res.exitCode === 0 ? 'ok' : 'inconclusive'
        } catch (err) {
            const facts = adapter?.describeError?.(err) ?? null
            if (facts?.execFailure) return facts.execFailure.failureClass
            this.logger.warn(
                `exec probe inconclusive hostId=${host.id} class=${facts?.errorClass ?? errorClass(err)}`
            )
            return 'inconclusive'
        }
    }

    // The turn path's hold on the machine, kept for as long as the turn runs
    // (ADR-0038). The same lease the admission held: the machine never sleeps
    // between the two.
    holdAwake(host: RuntimeHostRow, reason: string): AwakeHold {
        return this.awake.hold(host, reason)
    }

    private async admit(
        host: RuntimeHostRow,
        daemon: HostDaemonRow | null,
        args: HostDaemonArgs,
        started: boolean
    ): Promise<BringUpResolution> {
        const features = daemon?.clientFeatures ?? []
        const missing = (args.requiredFeatures ?? []).filter(
            (feature) => !features.includes(feature)
        )
        if (!missing.length)
            return {
                handle: {
                    hostId: host.id,
                    started,
                    generation: leaseGeneration(daemon)
                }
            }
        // A sprite's daemon an older bring-up started by an exec runs no
        // services (services.v1 is a supervised daemon's): handing it to its
        // supervised loop is what gives it them, not an update.
        if (
            host.kind === 'hosted' &&
            daemon &&
            daemon.startupMethod !== 'container' &&
            missing.includes(DAEMON_FEATURE_SERVICES)
        ) {
            const back = await this.singleFlightResupervise(host)
            if (
                back &&
                (args.requiredFeatures ?? []).every((f) =>
                    back.clientFeatures.includes(f)
                )
            )
                return {
                    handle: {
                        hostId: host.id,
                        started: true,
                        generation: leaseGeneration(back)
                    }
                }
            if (back) daemon = back
        }
        // A hosted machine's daemon is the platform's to keep current (R11):
        // it is updated here, under the admission's hold, and the work goes on
        // once it is back with what the work needs. A self-owned computer is
        // its user's to update, so the answer says the CLI is too old.
        if (host.kind === 'hosted' && daemon && this.hostCli) {
            this.logger.log(
                `daemon on host ${host.id} lacks ${missing.join(',')} for agent ${args.agentId ?? '-'}; updating its CLI`
            )
            try {
                const fresh = await this.hostCli.ensure(host, {
                    features: missing
                })
                return {
                    handle: {
                        hostId: host.id,
                        started: true,
                        generation: leaseGeneration(fresh)
                    }
                }
            } catch (err) {
                this.logger.warn(
                    `daemon on host ${host.id} was not updated for ${missing.join(',')}: ${(err as Error).message}`
                )
                if (err instanceof HostCliTooOldError)
                    return {
                        ...unavailable('runner_cli_too_old'),
                        cliRefusal: err.refusal
                    }
                return unavailable(
                    err instanceof HostCliUpdatingError
                        ? 'runner_updating'
                        : 'runner_unavailable'
                )
            }
        }
        this.logger.warn(
            `daemon on host ${host.id} lacks required features ${missing.join(',')} for agent ${args.agentId ?? '-'}`
        )
        return unavailable('runner_cli_too_old')
    }

    private singleFlightResupervise(
        host: RuntimeHostRow
    ): Promise<HostDaemonRow | null> {
        const inFlight = this.resupervisions.get(host.id)
        if (inFlight) return inFlight
        const attempt = this.resupervise(host).finally(() => {
            this.resupervisions.delete(host.id)
        })
        this.resupervisions.set(host.id, attempt)
        return attempt
    }

    // The daemon restarted under its provider's supervisor, and back: the
    // loop starts it again with the container marker. A provider without a
    // supervised layout has nothing to hand it to.
    private async resupervise(
        host: RuntimeHostRow
    ): Promise<HostDaemonRow | null> {
        try {
            const { provider, adapter } = await this.adapterFor(host)
            if (!layoutFor(provider).supervised) return null
            this.logger.log(`handing the daemon on host ${host.id} to its supervised loop`)
            const generation = await this.hosts.bumpGeneration(host.id)
            const startedAt = new Date()
            const online = await this.startHeldAwake(
                adapter,
                { host, provider, generation },
                () => this.waitForLease(host, startedAt, DEFAULT_WAIT_ONLINE_MS)
            )
            return online ? this.hostDaemons.findByHostId(host.id) : null
        } catch (err) {
            this.logger.warn(
                `daemon on host ${host.id} was not handed to its supervised loop class=${errorClass(err)}`
            )
            return null
        }
    }

    private singleFlightBringUp(
        args: HostDaemonArgs,
        hold: AwakeHold
    ): Promise<BringUpOutcome> {
        const inFlight = this.bringUps.get(args.host.id)
        if (inFlight) return inFlight
        const attempt = this.bringUp(args, hold).finally(() => {
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

    // R11 for a hosted host the API holds no socket to: observe power, resume
    // a suspended or stopped machine (the awake lease already did, when the
    // provider has one) and give the thawed daemon a moment to dial back in;
    // otherwise bootstrap — install mf, register with a token bound to this
    // host, start — under a fresh generation. The lease is held throughout.
    private async bringUp(
        args: HostDaemonArgs,
        hold: AwakeHold
    ): Promise<BringUpOutcome> {
        const { host } = args
        const tag = `hostId=${host.id} agentId=${args.agentId ?? '-'}`
        try {
            const { provider, adapter } = await this.adapterFor(host)
            const since = new Date()
            await hold.settled
            const power = await adapter.power({ host, provider })
            if (power === 'gone') {
                this.logger.warn(`daemon bring-up found the machine gone ${tag}`)
                return { handle: null }
            }
            await recordPower(this.hosts, host.id, power)
            const asleep = power === 'suspended' || power === 'stopped'
            if (asleep)
                await adapter.wake({ host, provider, generation: host.generation })
            // A registered daemon on a machine that just thawed — woken here or
            // by the awake hold's own exec — dials back in by itself within
            // seconds; restarting it instead ends every exec it still carries.
            // Seen on staging [2026-09-29]: a bring-up restarted a daemon that
            // had reconnected in the same second, with 13 streams in flight.
            const daemon = await this.hostDaemons.findByHostId(host.id)
            if (asleep || daemon) {
                const reconnectMs =
                    power === 'stopped' &&
                    daemon?.startupMethod === 'container'
                        ? COLD_WAKE_RECONNECT_WAIT_MS
                        : WAKE_RECONNECT_WAIT_MS
                const back = await this.waitForLease(
                    host,
                    since,
                    Math.min(reconnectMs, args.waitOnlineMs ?? reconnectMs)
                )
                if (back) {
                    this.logger.log(`daemon reconnected ${tag}`)
                    return { handle: back }
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
            if (!prepared.ok)
                return { handle: null, registerFailure: prepared.registerFailure }
            const waitMs = args.waitOnlineMs ?? DEFAULT_WAIT_ONLINE_MS
            const startedAt = new Date()
            let online = await this.startHeldAwake(adapter, call, () =>
                this.waitForLease(host, startedAt, waitMs)
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
                    const again = await this.register(adapter, call)
                    if (!again.ok)
                        return {
                            handle: null,
                            registerFailure: registerFailureOf(again.detail)
                        }
                    online = await this.startHeldAwake(adapter, call, () =>
                        this.waitForLease(host, startedAt, waitMs)
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

    // The install-and-register half of a bring-up. A daemon that is merely
    // PRESENT is not good enough: the platform owns this binary and nothing
    // else ever updates it, so a machine keeps its first CLI indefinitely —
    // including bugs since fixed in it. Below the floor it is reinstalled.
    private async installAndRegister(
        adapter: SandboxProvider,
        call: ProviderCall,
        state: BringUpMachineState
    ): Promise<{ ok: boolean; registerFailure?: string }> {
        const tooOld = isCliVersionTooOld(state.version, DAEMON_MIN_CLI_VERSION)
        if (!state.installed || tooOld) {
            if (tooOld && state.installed)
                this.logger.log(
                    `daemon CLI ${state.version ?? 'unknown'} < ${DAEMON_MIN_CLI_VERSION}, upgrading hostId=${call.host.id}`
                )
            if (!(await this.installCli(adapter, call))) return { ok: false }
        }
        // herdr rides along with the daemon (ADR-0031), best effort: a
        // machine without it still chats, it just cannot hand a session to
        // herdr until the Update Center installs it.
        if (state.herdr === false) await this.installHerdr(adapter, call)
        // Seen on a local stack [2026-09-28]: a sandbox registered through a
        // quick tunnel kept dialing it after the tunnel was replaced, and every
        // bring-up ended in `daemon did not come online` with the sandbox held
        // awake. Registering again is what rewrites the saved address.
        const registeredElsewhere =
            state.registered &&
            state.apiUrl !== null &&
            state.apiUrl.replace(/\/+$/, '') !== this.apiUrl()
        if (registeredElsewhere)
            this.logger.warn(
                `daemon registered against ${state.apiUrl}, re-registering against ${this.apiUrl()} hostId=${call.host.id}`
            )
        if (!state.registered || registeredElsewhere) {
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
                    return { ok: false }
                registered = await this.register(adapter, call)
            }
            if (!registered.ok)
                return {
                    ok: false,
                    registerFailure: registerFailureOf(registered.detail)
                }
        }
        return { ok: true }
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
    ): Promise<BringUpInspection> {
        const layout = layoutFor(call.provider)
        const script = [
            `test -x ${MF_BIN} && echo installed=1 || echo installed=0`,
            `test -f "${layout.probePath}" && echo registered=1 || echo registered=0`,
            // `daemon start` dials the address saved at register time whatever
            // `--api-url` says (ADR-0014), so once this deployment's public URL
            // moves, a registered daemon never connects again until it is
            // registered anew. Only the URL is read: the file holds a token.
            `echo apiUrl=$(grep -o '"apiUrl": *"[^"]*"' "${layout.probePath}" 2>/dev/null | head -n 1 | cut -d '"' -f 4)`,
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
            const facts = adapter.describeError?.(err) ?? null
            const execFailure = facts?.execFailure ?? null
            this.logger.warn(
                `daemon inspect exec failed hostId=${call.host.id} class=${execFailure?.failureClass ?? facts?.errorClass ?? errorClass(err)}`
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
                apiUrl: /^apiUrl=(\S+)$/m.exec(res.stdout)?.[1] ?? null,
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

    // Register with a token minted BOUND to the host (ADR-0037 R5): it can
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
        // In a subshell reading nothing: the token after it is on stdin.
        const shellEnv = layout.writesShellEnv
            ? `(\n${buildShellEnvScript({
                  apiBaseUrl: this.apiUrl(),
                  deployEnv: process.env.MF_DEPLOY_ENV
              })}\n) </dev/null >/dev/null 2>&1 || echo 'mf shell env not written' >&2\n`
            : ''
        const res = await adapter
            .bootstrap({
                ...call,
                script:
                    `${shellEnv}${layout.envPrefix} ${MF_BIN} --api-url ${this.apiUrl()} ` +
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
                `daemon register failed hostId=${host.id} exit=${res.exitCode} detail=${registerFailureOf(detail) ?? '(no output)'}`
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
        if (layout.supervised) {
            if (!adapter.superviseDaemon)
                throw new Error(
                    `${call.provider.kind} cannot supervise the daemon of host ${call.host.id}`
                )
            await adapter.superviseDaemon(call, layout.supervised)
        }
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
        const hold = this.awake.hold(call.host, 'start')
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

    // A lease the API recorded AFTER `since`: a pong or a connect from a
    // process that was demonstrably running at that moment. Presence alone is
    // the wrong test here — it is what a frozen process still passes.
    private async waitForLease(
        host: RuntimeHostRow,
        since: Date,
        waitMs: number
    ): Promise<BringUpHandle | null> {
        const deadline = Date.now() + waitMs
        // The socket may land on this instance (the event ends the wait at
        // once) or on a peer (the poll sees the lease it wrote).
        let poke: (() => void) | null = null
        const unsubscribe = this.registry.onConnected((daemonId) => {
            if (daemonId === host.id) poke?.()
        })
        try {
            for (;;) {
                const daemon = await this.hostDaemons.findByHostId(host.id)
                if (
                    hasRpcLease(daemon) &&
                    daemon.rpcLastSeenAt &&
                    daemon.rpcLastSeenAt.getTime() >= since.getTime()
                )
                    return handleFor(host, daemon, true)
                if (Date.now() >= deadline) return null
                await new Promise<void>((resolve) => {
                    poke = resolve
                    void this.delay(POLL_INTERVAL_MS).then(resolve)
                })
                poke = null
            }
        } finally {
            unsubscribe()
        }
    }

    private apiUrl(): string {
        return runnerApiUrl()
    }
}

const handleFor = (
    host: RuntimeHostRow,
    daemon: HostDaemonRow,
    started: boolean
): BringUpHandle => ({
    hostId: host.id,
    started,
    generation: leaseGeneration(daemon)
})

const unavailable = (reason: BringUpFallbackReason): BringUpResolution => ({
    handle: null,
    fallbackReason: reason
})

// The token we send IS `ldt_`-prefixed, so the CLI complaining that it is not
// can only mean the CLI never read stdin and used the literal `-`. Same for a
// CLI that does not know the flag at all.
// A failed register's output as one line, or nothing when it printed none.
const registerFailureOf = (detail: string): string | undefined =>
    detail.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined

const isStaleCliRegisterFailure = (detail: string): boolean =>
    /must start with ldt_|unknown option|requires --token/i.test(detail)

const errorClass = (err: unknown): string =>
    err instanceof Error && err.name ? err.name : typeof err

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

