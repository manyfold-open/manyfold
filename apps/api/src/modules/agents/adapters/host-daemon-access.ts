import { Injectable, Optional } from '@nestjs/common'
import { daemonOnline, type AgentRuntime } from '@manyfold/shared'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import {
    RunnerManagerService,
    type RunnerExecFailure,
    type RunnerFallbackReason,
    type RunnerResolution
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
    // false: report an offline hosted daemon instead of waking the machine
    // (read paths that must not start billed running time).
    wake?: boolean
}

export interface EnsureHostDaemonResult {
    daemon: HostDaemonRow | null
    online: boolean
    fallbackReason?: RunnerFallbackReason
    execFailure?: RunnerExecFailure
    workspace?: RunnerResolution['workspace']
}

// Agent → Runtime → Host → host_daemons is the only path to a machine
// (ADR-0036). Online → use the daemon as it is. A hosted host that is not
// online is brought up by the runner manager (power → wake → bootstrap); a
// local host that is offline can only be started by its owner, so it reads
// as runner_unavailable.
@Injectable()
export class HostDaemonAccess {
    constructor(
        private readonly hostDaemons: HostDaemonsService,
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
            const online = !!resolution.handle && daemonOnline(daemon)
            return {
                daemon,
                online,
                fallbackReason: online
                    ? undefined
                    : (resolution.fallbackReason ?? 'runner_unavailable'),
                execFailure: resolution.execFailure,
                workspace: resolution.workspace
            }
        }
        const daemon =
            args.daemon ?? (await this.hostDaemons.findByHostId(args.host.id))
        const online = daemonOnline(daemon)
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
