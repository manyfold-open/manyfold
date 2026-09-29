import { randomUUID } from 'node:crypto'
import { Injectable, Optional } from '@nestjs/common'
import type {
    RuntimePlacement,
    DaemonRpcMethod,
    DaemonStreamKind
} from '@manyfold/shared'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import {
    HostDaemonsService,
    hasRpcLease
} from '@/modules/hosts/host-daemons.service'
import {
    HostAwakeService,
    NOOP_HOLD,
    type AwakeHold
} from '@/modules/hosts/host-awake.service'
import {
    DaemonRegistryService,
    DaemonRpcResponseError
} from '@/modules/daemon/daemon-registry.service'
import {
    RunnerManagerService,
    type RunnerExecFailure,
    type RunnerFallbackReason
} from '@/modules/chat/runner/runner-manager.service'

export interface EnsureHostDaemonArgs {
    host: RuntimeHostRow
    daemon: HostDaemonRow | null
    placement: RuntimePlacement
    agentId?: string
    workspacePath?: string | null
    extraRoots?: readonly string[]
    requiredFeatures?: readonly string[]
    firstExecTimeoutMs?: number
    waitOnlineMs?: number
    // false: report a hosted daemon the API holds no socket to instead of
    // waking the machine (read paths that must not start billed running time).
    wake?: boolean
}

export interface EnsureHostDaemonResult {
    daemon: HostDaemonRow | null
    online: boolean
    fallbackReason?: RunnerFallbackReason
    execFailure?: RunnerExecFailure
}

export interface HostRpcArgs {
    method: DaemonRpcMethod
    payload: Record<string, unknown>
    timeoutMs?: number
    // Retry once after a reconnect when the call timed out, not only when the
    // socket was lost. For calls a live daemon answers in milliseconds; a call
    // that legitimately takes long must not be doubled.
    retryOnTimeout?: boolean
}

// One command on the machine, run by its daemon (exec.start).
export interface HostExecRequest {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    timeoutMs: number
    dir?: string
    // Directories beyond the workspace base the daemon admits `dir` under for
    // this one exec (exec.roots.v1).
    roots?: readonly string[]
    // Output as it arrives, for a caller timing the command's own phases. A
    // command re-sent after a reconnect replays what it printed before.
    onStdout?: (chunk: string) => void
}

export interface HostExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

// A streaming call (fs.read, a pty): its events arrive as they happen. It is
// not retried — a stream cut mid-way cannot be replayed from here — and it
// outlives the hold of the call that opened it, so a caller keeping it past
// that call holds the machine itself.
export interface HostStreamArgs {
    method: DaemonRpcMethod
    payload: Record<string, unknown>
    timeoutMs?: number
    onEvent: (kind: DaemonStreamKind, data: string) => void
}

export interface HostStream {
    refId: string
    result: Promise<Record<string, unknown> | undefined>
    cancel: () => void
}

// What a caller works with while the machine is held awake (ADR-0038).
export interface HostSession {
    host: RuntimeHostRow
    daemon: HostDaemonRow
    // The host id: the daemon's routing key.
    daemonId: string
    // An RPC to the daemon that survives the one thing a held machine still
    // does on its own — reconnect after a thaw: a call lost to a closed,
    // replaced or frozen socket waits for the fresh lease and goes once more.
    rpc: (args: HostRpcArgs) => Promise<Record<string, unknown> | undefined>
    // A command on the machine, under the same hold. The refId is minted once:
    // a command whose socket was lost is sent again on the fresh lease under
    // that refId, and the daemon attaches to it, or replays it if it finished,
    // instead of running it twice (exec.start is idempotent by refId,
    // ADR-0029 §4). A timeout is never retried; a long command must not be
    // doubled.
    exec: (req: HostExecRequest) => Promise<HostExecResult>
    stream: (args: HostStreamArgs) => HostStream
}

export interface WithHostArgs extends EnsureHostDaemonArgs {
    // For the log line.
    reason: string
}

// Agent → Runtime → Host → host_daemons is the only path to a machine
// (ADR-0037), and `withHost` is the only way to work on one (ADR-0038): the
// machine is held awake, its daemon is brought up if the platform owns it,
// the work runs, the hold is released. Reachable means the API holds a socket
// (the rpc lease) — presence is for summaries. A self-owned computer the API
// holds no socket to can only be started by its owner, so it reads as
// runner_unavailable.
@Injectable()
export class HostDaemonAccess {
    constructor(
        private readonly hostDaemons: HostDaemonsService,
        private readonly registry: DaemonRegistryService,
        @Optional() private readonly awake?: HostAwakeService,
        @Optional() private readonly runnerManager?: RunnerManagerService
    ) {}

    async ensure(args: EnsureHostDaemonArgs): Promise<EnsureHostDaemonResult> {
        if (
            args.host.kind === 'hosted' &&
            args.wake !== false &&
            this.runnerManager
        ) {
            const resolution = await this.runnerManager.ensureHostDaemon({
                host: args.host,
                agentId: args.agentId,
                workspacePath: args.workspacePath,
                extraRoots: args.extraRoots,
                requiredFeatures: args.requiredFeatures,
                firstExecTimeoutMs: args.firstExecTimeoutMs,
                waitOnlineMs: args.waitOnlineMs
            })
            const daemon = await this.hostDaemons.findByHostId(args.host.id)
            const online = !!resolution.handle && hasRpcLease(daemon)
            return {
                daemon,
                online,
                fallbackReason: online
                    ? undefined
                    : (resolution.fallbackReason ?? 'runner_unavailable'),
                execFailure: resolution.execFailure
            }
        }
        const daemon =
            args.daemon ?? (await this.hostDaemons.findByHostId(args.host.id))
        const connected = hasRpcLease(daemon)
        // A self-owned computer is its user's to update: a daemon lacking
        // what the work needs is answered as too old, never updated here.
        const tooOld =
            connected &&
            (args.requiredFeatures ?? []).some(
                (feature) => !(daemon?.clientFeatures ?? []).includes(feature)
            )
        const online = connected && !tooOld
        return {
            daemon,
            online,
            fallbackReason: online
                ? undefined
                : tooOld
                  ? 'runner_cli_too_old'
                  : daemon
                    ? 'runner_unavailable'
                    : 'runner_missing'
        }
    }

    // The host id is the RPC routing key; this is the one place a caller
    // that needs a live daemon right now gets it or a reason it cannot.
    async requireOnline(args: EnsureHostDaemonArgs): Promise<string> {
        const result = await this.ensure(args)
        if (!result.online)
            throw new HostDaemonOfflineError(
                args.host,
                result.fallbackReason ?? 'runner_unavailable'
            )
        return args.host.id
    }

    // Hold the machine awake, get its daemon, run the work, let go. A hosted
    // machine the API holds no socket to is brought up under the hold. The
    // hold is released after the work; a caller whose work outlives this call
    // (a turn) takes its own hold from `hold` before this one is released, and
    // the grace on release keeps the machine up across the hand-over.
    async withHost<T>(
        args: WithHostArgs,
        work: (session: HostSession) => Promise<T>
    ): Promise<T> {
        if (args.wake === false) await this.assertUp(args)
        const hold = this.hold(args.host, args.reason)
        try {
            const ensured = await this.ensure(args)
            if (!ensured.online || !ensured.daemon)
                throw new HostDaemonOfflineError(
                    args.host,
                    ensured.fallbackReason ?? 'runner_unavailable',
                    ensured.execFailure
                )
            return await work({
                host: args.host,
                daemon: ensured.daemon,
                daemonId: args.host.id,
                rpc: (call) => this.rpc(args.host, call),
                exec: (req) => this.exec(args.host, req),
                stream: (call) =>
                    this.registry.streamRpc({
                        daemonId: args.host.id,
                        method: call.method,
                        payload: call.payload,
                        timeoutMs: call.timeoutMs,
                        onEvent: call.onEvent
                    })
            })
        } finally {
            void hold.release()
        }
    }

    hold(host: RuntimeHostRow, reason: string): AwakeHold {
        return this.awake?.hold(host, reason) ?? NOOP_HOLD
    }

    // A caller that must not start billed running time gets no hold on a
    // machine that is not already up and connected: taking the hold is itself
    // an exec, and an exec resumes a sleeping sprite.
    private async assertUp(args: EnsureHostDaemonArgs): Promise<void> {
        const daemon =
            args.daemon ?? (await this.hostDaemons.findByHostId(args.host.id))
        const up =
            args.host.kind === 'local' || args.host.powerState === 'running'
        if (!up || !hasRpcLease(daemon))
            throw new HostDaemonOfflineError(
                args.host,
                daemon ? 'runner_unavailable' : 'runner_missing'
            )
    }

    private async rpc(
        host: RuntimeHostRow,
        call: HostRpcArgs
    ): Promise<Record<string, unknown> | undefined> {
        const since = new Date()
        try {
            return await this.registry.rpc({
                daemonId: host.id,
                method: call.method,
                payload: call.payload,
                timeoutMs: call.timeoutMs
            })
        } catch (err) {
            if (!isTransportLoss(err, call.retryOnTimeout === true)) throw err
            const back = this.runnerManager
                ? await this.runnerManager.awaitReconnect(host, since)
                : null
            if (!back) throw err
            return this.registry.rpc({
                daemonId: host.id,
                method: call.method,
                payload: call.payload,
                timeoutMs: call.timeoutMs
            })
        }
    }

    private async exec(
        host: RuntimeHostRow,
        req: HostExecRequest
    ): Promise<HostExecResult> {
        const refId = randomUUID()
        const payload: Record<string, unknown> = {
            cmd: req.cmd,
            timeoutMs: req.timeoutMs
        }
        if (req.env) payload.env = req.env
        if (req.stdin !== undefined) payload.stdin = req.stdin
        if (req.dir) payload.dir = req.dir
        if (req.roots?.length) payload.roots = [...req.roots]
        const attempt = async (): Promise<HostExecResult> => {
            const stdout: string[] = []
            const stderr: string[] = []
            const stream = this.registry.streamRpc({
                daemonId: host.id,
                method: 'exec.start',
                payload,
                timeoutMs: req.timeoutMs + 5_000,
                refIdOverride: refId,
                onEvent: (kind, data) => {
                    if (kind === 'stdout') {
                        stdout.push(data)
                        req.onStdout?.(data)
                    } else if (kind === 'stderr') stderr.push(data)
                }
            })
            const ack = await stream.result
            return {
                exitCode: typeof ack?.exitCode === 'number' ? ack.exitCode : -1,
                stdout: stdout.join(''),
                stderr: stderr.join('')
            }
        }
        const since = new Date()
        try {
            return await attempt()
        } catch (err) {
            if (!isTransportLoss(err, false)) throw err
            const back = this.runnerManager
                ? await this.runnerManager.awaitReconnect(host, since)
                : null
            if (!back) throw err
            return attempt()
        }
    }
}

// The registry surfaces a lost generation in a few fixed shapes: a socket that
// closed or was replaced mid-flight, no socket at all, a stale peer lease, or
// its own deadline for a socket that is up but frozen. Anything else came
// back from a live daemon and is the caller's error.
export const isTransportLoss = (err: unknown, includeTimeout: boolean): boolean => {
    if (err instanceof DaemonRpcResponseError) return false
    const message = err instanceof Error ? err.message : String(err)
    if (
        /connection closed|connection replaced|is not connected|no active websocket|lease is stale/i.test(
            message
        )
    )
        return true
    return includeTimeout && /timed out/i.test(message)
}

export class HostDaemonOfflineError extends Error {
    constructor(
        readonly host: RuntimeHostRow,
        readonly reason: RunnerFallbackReason,
        // What the bring-up's first exec proved about the provider's exec
        // endpoint, when that is why there is no daemon.
        readonly execFailure?: RunnerExecFailure
    ) {
        super(
            reason === 'runner_updating'
                ? `${host.name} is updating its Manyfold CLI once its current work finishes; retry in a few minutes`
                : reason === 'runner_cli_too_old'
                ? host.kind === 'local'
                    ? `the Manyfold CLI on ${host.name} is too old for this; update it and retry`
                    : `the Manyfold CLI on ${host.name} is too old for this, and no update carrying what it needs is published yet`
                : host.kind === 'local'
                  ? `${host.name} is offline; start its daemon (mf daemon start) and retry`
                  : `${host.name} has no running daemon (${reason}); retry once the machine is up`
        )
        this.name = 'HostDaemonOfflineError'
    }
}
