import { Injectable, Optional } from '@nestjs/common'
import type { AgentRuntime, DaemonRpcMethod } from '@manyfold/shared'
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
    placement: AgentRuntime
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
        const online = hasRpcLease(daemon)
        return {
            daemon,
            online,
            fallbackReason: online
                ? undefined
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
                    ensured.fallbackReason ?? 'runner_unavailable'
                )
            return await work({
                host: args.host,
                daemon: ensured.daemon,
                daemonId: args.host.id,
                rpc: (call) => this.rpc(args.host, call)
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
        readonly reason: RunnerFallbackReason
    ) {
        super(
            host.kind === 'local'
                ? `${host.name} is offline; start its daemon (mf daemon start) and retry`
                : `${host.name} has no running daemon (${reason}); retry once the machine is up`
        )
        this.name = 'HostDaemonOfflineError'
    }
}
