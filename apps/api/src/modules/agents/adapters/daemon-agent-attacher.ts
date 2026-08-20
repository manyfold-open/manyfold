import { codingAgentWorkspacePathForHome } from '@manyfold/shared'
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import type { Agent, AgentRuntimeRow } from '@manyfold/db'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import {
    isAgentWorkspaceManaged,
    isWorkspacePreflightUserError,
    resolveWorkspaceSelection
} from '@/modules/agents/workspace/workspace-preflight'

@Injectable()
export class DaemonAgentAttacher {
    private readonly log = new Logger(DaemonAgentAttacher.name)

    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly hosts: DaemonHostService
    ) {}

    async attach(args: {
        runtime: AgentRuntimeRow
        agentId: string
        workspace?: string
    }): Promise<{ workspacePath: string; internalId: string }> {
        const host = await this.requireHost(args.runtime)
        if (!host.homeDir)
            throw new Error(
                `daemon host ${host.id} missing homeDir; cannot resolve workspace`
            )
        // Hosts running an older CLI registered `~/.nca/workspaces` and only
        // accept managed workspaces under that root — follow their report.
        const defaultWorkspace = host.workspaceBaseDir
            ? `${host.workspaceBaseDir.replace(/\/+$/, '')}/${args.agentId}`
            : codingAgentWorkspacePathForHome(host.homeDir, args.agentId)
        const selection = resolveWorkspaceSelection(
            args.workspace,
            defaultWorkspace
        )
        try {
            await this.registry.rpc({
                daemonId: host.id,
                method: 'workspace.ensure',
                payload: {
                    path: selection.path,
                    create: selection.managed
                }
            })
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

    async detach(args: {
        runtime: AgentRuntimeRow
        agent: Agent
    }): Promise<void> {
        const host = await this.requireHost(args.runtime)
        if (!args.agent.workspacePath) return
        try {
            await this.registry.rpc({
                daemonId: host.id,
                method: 'workspace.delete',
                payload: {
                    path: args.agent.workspacePath,
                    remove: isAgentWorkspaceManaged(args.agent)
                }
            })
        } catch (err) {
            this.log.warn(
                `workspace.delete failed for ${args.agent.id} on ${host.id}: ${(err as Error).message}`
            )
        }
    }

    private async requireHost(runtime: AgentRuntimeRow) {
        if (!runtime.daemonId)
            throw new Error(
                `runtime ${runtime.id} missing daemonId; cannot resolve daemon`
            )
        const host = await this.hosts.findById(runtime.daemonId)
        if (!host)
            throw new NotFoundException(
                `daemon host ${runtime.daemonId} not found`
            )
        return host
    }
}
