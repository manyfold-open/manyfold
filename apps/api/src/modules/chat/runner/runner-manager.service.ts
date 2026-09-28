import { DEFAULT_API_BASE_URL } from '@/common/brand'
import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import {
    DAEMON_FEATURE_EXEC_FILES,
    DAEMON_MIN_CLI_VERSION,
    K8S_HOME_BASE,
    POD_RUNNER_PROFILE,
    RUNNER_PROFILE,
    isCliVersionTooOld,
    profilePaths
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
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
import {
    HostDaemonsService,
    hasRpcLease
} from '@/modules/hosts/host-daemons.service'
import {
    HostAwakeService,
    type AwakeHold
} from '@/modules/hosts/host-awake.service'
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
// inside the machine — can go through the daemon protocol (ADR-0037 R11):
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

export interface RunnerHandle {
    // The host id: the daemon's routing key (ADR-0037).
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

export interface RunnerResolution {
    handle: RunnerHandle | null
    fallbackReason?: RunnerFallbackReason
    // Present only with `sprite_exec_unavailable`: what the inspect proved about
    // the sprite exec endpoint, for the caller to quarantine on (#730).
    execFailure?: RunnerExecFailure
}

interface RunnerMachineState {
    installed: boolean
    registered: boolean
    version: string | null
    // herdr present on the machine (ADR-0031); null when the probe did not say.
    herdr: boolean | null
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

@Injectable()
export class RunnerManagerService {
    private readonly logger = new Logger(RunnerManagerService.name)
    // One in-flight bring-up per host: concurrent turns on the same machine
    // must not each install and register a daemon.
    private readonly bringUps = new Map<string, Promise<RunnerBringUp>>()
    constructor(
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly providers: SandboxProviderRegistry,
        private readonly clients: HostProviderClients,
        private readonly tokens: DaemonTokenService,
        private readonly registry: DaemonRegistryService,
        private readonly awake: HostAwakeService
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
    async ensureHostDaemon(args: HostDaemonArgs): Promise<RunnerResolution> {
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
        const hold = this.awake.hold(host, `ensure-${args.agentId ?? host.id}`)
        try {
            if (hasRpcLease(daemon)) return this.admit(host, daemon, args, false)
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
                        : {})
                }
            const fresh = await this.hostDaemons.findByHostId(host.id)
            return this.admit(host, fresh, args, resolved.handle.started)
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
    ): Promise<RunnerHandle | null> {
        return this.waitForLease(host, since, waitMs)
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
        return {
            handle: {
                daemonId: host.id,
                started,
                generation: leaseGeneration(daemon)
            }
        }
    }

    private singleFlightBringUp(
        args: HostDaemonArgs,
        hold: AwakeHold
    ): Promise<RunnerBringUp> {
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
    ): Promise<RunnerBringUp> {
        const { host } = args
        const tag = `hostId=${host.id} agentId=${args.agentId ?? '-'}`
        try {
            const { provider, adapter } = await this.adapterFor(host)
            const since = new Date()
            await hold.settled
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
                    if (!(await this.register(adapter, call)).ok)
                        return { handle: null }
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
    ): Promise<RunnerHandle | null> {
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
    fallbackReason: reason
})

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

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

