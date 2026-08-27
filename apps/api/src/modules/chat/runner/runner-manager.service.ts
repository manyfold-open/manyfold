import { DEFAULT_API_BASE_URL } from '@/common/brand'
import {
    RUNNER_PROFILE,
    isCliVersionTooOld,
    profilePaths
} from '@manyfold/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { runtimeHosts, type Database } from '@manyfold/db'
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
export { RUNNER_PROFILE }
const RUNNER_PROBE_PATH = profilePaths(
    '$HOME/.manyfold',
    RUNNER_PROFILE
).daemonConfigPath
// The agent↔runner binding, without a schema change: the runner registers under
// a name derived from the sprite it lives on, so resolving "this agent's runner"
// is a lookup by (userId, kind=daemon, name) and a host belonging to any other
// sprite can never be mistaken for it.
export const runnerHostName = (spriteName: string): string =>
    `sprite-runner:${spriteName}`

// The runner token authenticates EVERY websocket connect (it rides in the ws
// URL), not just the one-off register — a short TTL therefore bricks the runner
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
// Below this the daemon lacks the #519 CLI half: its exec-buffer hello drops
// completed streams after 5 minutes and cannot assert hello.inflight-authoritative,
// so the first API restart after a slow delivery converges an already-successful
// turn as unresumable (#518). 0.21.0 capabilities (turn.start, dial-first
// framework detection) are implied.
const RUNNER_MIN_CLI = '0.22.3'
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

interface RunnerSpriteState {
    installed: boolean
    registered: boolean
    version: string | null
}

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
        const workspace = await this.workspacePreflight(handle.daemonId, args)
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

    private async resolveOnline(
        args: EnsureRunnerArgs
    ): Promise<RunnerBringUp> {
        const existing = await this.findRunnerHost(args)
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
        args: EnsureRunnerArgs
    ): Promise<{
        outcome: WorkspacePreflightOutcome
        ensureMs?: number
        reason?: RunnerFallbackReason
    }> {
        const path = args.workspacePath
        if (!path) return { outcome: 'none' }
        const host = await this.hosts.findById(daemonId).catch(() => null)
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
                `runner workspace register failed sprite=${args.spriteName} class=${errorClass(err)}`
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
        spriteName: string
    }): Promise<{
        id: string
        online: boolean
        generation: string | null
    } | null> {
        const [row] = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, args.userId),
                    eq(runtimeHosts.kind, 'daemon'),
                    eq(runtimeHosts.name, runnerHostName(args.spriteName))
                )
            )
            .limit(1)
        if (!row) return null
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
                    : null
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
            // A runner that is merely PRESENT is not good enough. The platform
            // owns this binary and nothing else ever updates it, so a sprite
            // keeps its first CLI indefinitely — including bugs we have since
            // fixed in it. The floor is the version whose exec-buffer sweep
            // stops the buffer growing without bound; below it, a cold runner
            // re-enumerates and re-parses every turn it ever ran before it
            // dials back.
            // Seen on staging 2026-07-26: bring-up blew its 120s budget on a
            // sprite that was already installed AND registered, and this is
            // the most plausible reason.
            const tooOld = isCliVersionTooOld(state.version, RUNNER_MIN_CLI)
            if (!state.installed || tooOld) {
                if (tooOld && state.installed)
                    this.logger.log(
                        `runner CLI ${state.version ?? 'unknown'} < ${RUNNER_MIN_CLI}, upgrading sprite=${args.spriteName}`
                    )
                const ok = await this.installCli(args)
                if (!ok) return { handle: null }
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
                    if (!(await this.installCli(args))) return { handle: null }
                    registered = await this.register(args)
                }
                if (!registered.ok) return { handle: null }
            }
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
        args: EnsureRunnerArgs
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
            cmd: ['bash', '-lc', buildCliInstallScript(channel)],
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
                        `daemon register --token - --name ${shellQuote(runnerHostName(args.spriteName))} -y`
                ],
                stdin: minted.plaintext,
                timeoutMs: 180_000
            })
            .catch(async (err: unknown) => {
                await this.discardUnboundToken(minted.tokenId, args)
                throw err
            })
        // `-y` also tries to install an autostart unit, which fails on a sprite
        // (no systemd) and is expected — registration itself is what matters.
        const ok =
            res.exitCode === 0 || res.stdout.includes('daemon registered')
        const detail = `${res.stdout} ${res.stderr}`.slice(0, 400)
        if (!ok) {
            this.logger.warn(
                `runner register failed sprite=${args.spriteName} exit=${res.exitCode}`
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

    private async start(args: EnsureRunnerArgs): Promise<void> {
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
        args: EnsureRunnerArgs
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
        const tail = res.stdout.replace(/\s+/g, ' ')
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
        void this.holdSpriteAwake({ ...args, ttl: AWAKE_TTL })
        const timer = setInterval(() => {
            void this.holdSpriteAwake({ ...args, ttl: AWAKE_TTL })
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
                if (stop()) await this.releaseSpriteAwake(args)
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
            const host = await this.findRunnerHost(args)
            if (host?.online)
                return { id: host.id, generation: host.generation }
            if (Date.now() >= deadline) return null
            await this.delay(POLL_INTERVAL_MS)
        }
    }

    private apiUrl(): string {
        const base = process.env.PUBLIC_API_BASE_URL?.replace(/\/+$/, '')
        return base ? `${base}/api` : DEFAULT_API_BASE_URL
    }
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
