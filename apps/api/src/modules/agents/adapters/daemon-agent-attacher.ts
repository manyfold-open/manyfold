import {
    codingAgentWorkspacePath,
    codingAgentWorkspacePathForHome
} from '@manyfold/shared'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import type { Agent } from '@manyfold/db'
import {
    isAgentWorkspaceManaged,
    isWorkspacePreflightUserError,
    resolveWorkspaceSelection
} from '@/modules/agents/workspace/workspace-preflight'
import { HostDaemonAccess } from './host-daemon-access'
import type { RuntimeTarget } from './agent-adapter'

// A coding agent's workspace on its machine, created and removed through the
// host's daemon whatever provider the machine came from (ADR-0037 R6).
@Injectable()
export class DaemonAgentAttacher {
    private readonly log = new Logger(DaemonAgentAttacher.name)

    constructor(private readonly access: HostDaemonAccess) {}

    async attach(args: {
        target: RuntimeTarget
        agentId: string
        workspace?: string
    }): Promise<{ workspacePath: string; internalId: string }> {
        const host = requireHost(args.target)
        const selection = resolveWorkspaceSelection(
            args.workspace,
            defaultWorkspaceFor(args.target, args.agentId)
        )
        try {
            await this.access.withHost(
                { ...args.target, host, agentId: args.agentId, reason: 'attach' },
                (session) =>
                    session.rpc({
                        method: 'workspace.ensure',
                        payload: {
                            path: selection.path,
                            create: selection.managed
                        }
                    })
            )
        } catch (err) {
            const message = (err as Error).message
            this.log.warn(
                `workspace.ensure failed for ${args.agentId} on ${host.id}: ${message}`
            )
            if (isWorkspacePreflightUserError(message))
                throw new BadRequestException(message)
            throw err
        }
        return { workspacePath: selection.path, internalId: args.agentId }
    }

    async detach(args: { target: RuntimeTarget; agent: Agent }): Promise<void> {
        const host = requireHost(args.target)
        if (!args.agent.workspacePath) return
        try {
            await this.access.withHost(
                { ...args.target, host, agentId: args.agent.id, reason: 'detach' },
                (session) =>
                    session.rpc({
                        method: 'workspace.delete',
                        payload: {
                            path: args.agent.workspacePath,
                            remove: isAgentWorkspaceManaged(args.agent)
                        }
                    })
            )
        } catch (err) {
            this.log.warn(
                `workspace.delete failed for ${args.agent.id} on ${host.id}: ${(err as Error).message}`
            )
        }
    }
}

const requireHost = (target: RuntimeTarget) => {
    if (!target.host)
        throw new Error(
            `runtime ${target.runtime.id} has no host; cannot reach a daemon`
        )
    return target.host
}

// The machine declared its workspace root at registration (ADR-0014); older
// registrations declared only a home; a host that reported neither falls
// back to the placement's conventional root.
const defaultWorkspaceFor = (target: RuntimeTarget, agentId: string): string => {
    const host = target.host
    if (host?.workspaceBaseDir)
        return `${host.workspaceBaseDir.replace(/\/+$/, '')}/${agentId}`
    if (host?.homeDir) return codingAgentWorkspacePathForHome(host.homeDir, agentId)
    return codingAgentWorkspacePath(target.placement, agentId)
}
