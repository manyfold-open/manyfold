import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import type { AgentRuntimeRow, RuntimeHostRow } from '@manyfold/db'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { RuntimeContextService } from '@/modules/hosts/runtime-context.service'
import { RunnerManagerService } from '@/modules/chat/runner/runner-manager.service'
import type { HostScriptRunner } from '@/modules/agents/bootstrap/framework-version-install'

export interface FrameworkExecRunRequest {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    timeoutMs: number
    dir?: string
}

export interface FrameworkExecRunResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface FrameworkExec {
    run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult>
}

// One command on a host, through its daemon (ADR-0037 R6): the only way
// anything inside a machine is run, whichever provider the machine is on.
export class DaemonFrameworkExec implements FrameworkExec {
    constructor(
        private readonly registry: DaemonRegistryService,
        // The host id: the daemon's routing key.
        private readonly daemonId: string
    ) {}

    async run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult> {
        const stdoutChunks: string[] = []
        const stderrChunks: string[] = []
        const payload: Record<string, unknown> = {
            cmd: req.cmd,
            timeoutMs: req.timeoutMs
        }
        if (req.env) payload.env = req.env
        if (req.stdin !== undefined) payload.stdin = req.stdin
        if (req.dir) payload.dir = req.dir
        const stream = this.registry.streamRpc({
            daemonId: this.daemonId,
            method: 'exec.start',
            payload,
            timeoutMs: req.timeoutMs + 5_000,
            onEvent: (kind, data) => {
                if (kind === 'stdout') stdoutChunks.push(data)
                else if (kind === 'stderr') stderrChunks.push(data)
            }
        })
        const ack = await stream.result
        const exitCode =
            typeof ack?.exitCode === 'number' ? ack.exitCode : -1
        return {
            exitCode,
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join('')
        }
    }
}

// The staged framework install (installFrameworkVersionOn) runs login-shell
// scripts; this is that runner over a daemon exec, so a framework installs
// the same way on every kind of host.
export const daemonScriptRunner = (
    exec: FrameworkExec,
    warn: HostScriptRunner['warn']
): HostScriptRunner => ({
    run: (script, timeoutMs) =>
        exec.run({ cmd: ['bash', '-lc', script], timeoutMs }),
    warn
})

@Injectable()
export class FrameworkExecResolver {
    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly runnerManager: RunnerManagerService
    ) {}

    // The exec for a runtime's host: its daemon, brought online first when
    // the host is the platform's. An external runtime has no machine.
    async forRuntime(
        runtime: AgentRuntimeRow,
        logger?: Logger
    ): Promise<FrameworkExec> {
        if (!runtime.hostId)
            throw new Error(
                `runtime ${runtime.id} is external; framework exec needs a host`
            )
        const context = await this.runtimeContext.forRuntime(runtime.id)
        if (!context?.host)
            throw new Error(`runtime ${runtime.id} has no host`)
        return this.forHost(context.host, logger)
    }

    async forHost(
        host: RuntimeHostRow,
        logger?: Logger
    ): Promise<FrameworkExec> {
        const resolution = await this.runnerManager.ensureHostDaemon({ host })
        if (!resolution.handle) {
            logger?.warn(
                `framework exec unavailable hostId=${host.id} reason=${resolution.fallbackReason ?? 'offline'}`
            )
            throw new ServiceUnavailableException({
                code:
                    host.kind === 'local'
                        ? 'DAEMON_OFFLINE'
                        : 'SANDBOX_DAEMON_OFFLINE',
                message: `${host.name} is not reachable (${resolution.fallbackReason ?? 'daemon offline'})`,
                hostId: host.id
            })
        }
        return new DaemonFrameworkExec(this.registry, host.id)
    }
}
