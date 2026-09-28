import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import { RuntimeContextService } from '@/modules/hosts/runtime-context.service'
import type { HostScriptRunner } from '@/modules/agents/bootstrap/framework-version-install'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    type HostExecRequest,
    type HostExecResult
} from './host-daemon-access'

export type FrameworkExecRunRequest = HostExecRequest

export type FrameworkExecRunResult = HostExecResult

export interface FrameworkExec {
    run(req: FrameworkExecRunRequest): Promise<FrameworkExecRunResult>
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
        private readonly runtimeContext: RuntimeContextService,
        private readonly hostAccess: HostDaemonAccess
    ) {}

    // Commands on a runtime's host, through its daemon (ADR-0037 R6). Each
    // one runs under the machine's awake hold with the daemon brought up when
    // the platform owns the host (ADR-0038), so a command never outlives the
    // hold it needs; the release grace carries the machine across a caller's
    // next command. An external runtime has no machine.
    async forRuntime(
        runtime: AgentRuntimeRow,
        logger?: Logger
    ): Promise<FrameworkExec> {
        if (!runtime.hostId)
            throw new Error(
                `runtime ${runtime.id} is external; framework exec needs a host`
            )
        const context = await this.runtimeContext.forRuntime(runtime.id)
        const host = context?.host
        if (!context || !host)
            throw new Error(`runtime ${runtime.id} has no host`)
        return {
            run: async (req) => {
                try {
                    return await this.hostAccess.withHost(
                        {
                            host,
                            daemon: null,
                            placement: context.placement,
                            reason: 'framework-exec'
                        },
                        (session) => session.exec(req)
                    )
                } catch (err) {
                    if (!(err instanceof HostDaemonOfflineError)) throw err
                    logger?.warn(
                        `framework exec unavailable hostId=${host.id} reason=${err.reason}`
                    )
                    throw new ServiceUnavailableException({
                        code:
                            host.kind === 'local'
                                ? 'DAEMON_OFFLINE'
                                : 'SANDBOX_DAEMON_OFFLINE',
                        message: `${host.name} is not reachable (${err.reason})`,
                        hostId: host.id
                    })
                }
            }
        }
    }
}
