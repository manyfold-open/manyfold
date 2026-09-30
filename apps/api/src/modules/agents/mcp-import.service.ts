import {
    RefreshAgentMcpResponse,
    frameworkMcpSupport,
    mcpConfigFromExtras
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agents,
    jsonbMergeNested,
    type Agent,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import {
    HostDaemonAccess,
    HostDaemonOfflineError
} from '@/modules/agents/adapters/host-daemon-access'
import { daemonReadTextFile } from '@/modules/daemon/daemon-fs'
import { COMPOSIO_MCP_SERVER_NAME } from '@/modules/connections/composio.service'
import { composioInjectScope } from '@/modules/agent-runtimes/mcp/composio-mcp'
import { resolveMcpScopeTargets } from '@/modules/agent-runtimes/mcp/mcp-config'
import {
    importScopeTexts,
    type McpManagedExclusion
} from '@/modules/agent-runtimes/mcp/mcp-config-import'
import type { RuntimeContext } from '@/modules/hosts/runtime-context.service'

// Pulls the runtime's real MCP config files back into agent.extras.mcp — the
// reverse of McpConfigMaterializer. Read-only on the runtime: files are never
// written or normalised here, and the materializer is deliberately NOT
// triggered afterwards (it would rewrite the very files we just read).
@Injectable()
export class McpImportService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly agents: AgentsService,
        private readonly hostAccess: HostDaemonAccess
    ) {}

    async refresh(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<RefreshAgentMcpResponse> {
        const ctx = await this.agents.contextForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!ctx) throw new NotFoundException(`agent ${agentId} not found`)
        const { agent } = ctx
        if (!frameworkMcpSupport(agent.framework))
            throw new BadRequestException(
                `${agent.framework} agents do not support MCP servers`
            )
        if (!ctx.host)
            throw new BadRequestException(
                'MCP import requires an agent on a machine'
            )
        const homeDir = ctx.host.homeDir
        if (!homeDir)
            throw new BadRequestException(
                'agent runtime home dir is unknown (not bootstrapped yet)'
            )
        const read = await this.readerFor(ctx)
        const targets = resolveMcpScopeTargets(agent.framework, {
            homeDir,
            workspacePath: agent.workspacePath ?? agent.mountPath
        })
        const currentByScope: Record<string, string | null> = {}
        for (const target of targets) {
            try {
                currentByScope[target.scopeId] = await read(target.absPath)
            } catch (err) {
                throw new ServiceUnavailableException(
                    `failed to read MCP config from the runtime: ${(err as Error).message}`
                )
            }
        }
        const result = importScopeTexts(
            targets,
            currentByScope,
            mcpConfigFromExtras(agent.extras),
            managedExclusionFor(agent)
        )
        // Only the scopes read in, merged into the live row: a scope edited
        // since this read keeps that edit.
        const imported = Object.fromEntries(
            result.scopes
                .filter((scope) => scope.status === 'imported')
                .map((scope) => [scope.scopeId, result.mcp[scope.scopeId]])
        )
        if (Object.keys(imported).length > 0)
            await this.db
                .update(agents)
                .set({
                    extras: jsonbMergeNested(
                        agents.extras,
                        {},
                        'mcp',
                        imported
                    ),
                    updatedAt: new Date()
                })
                .where(eq(agents.id, agent.id))
        return {
            agent: await this.agents.get(agentId, callerUserId, isAdmin),
            scopes: result.scopes
        }
    }

    // Reads one file on the machine, null when absent — a seam for tests. The
    // host's daemon is the one transport, whatever provisioned the machine
    // (ADR-0037). An import never wakes a machine: a read-only refresh is
    // not worth billed running time, so a machine the API holds no socket to
    // is reported offline.
    protected async readerFor(
        ctx: RuntimeContext
    ): Promise<(absPath: string) => Promise<string | null>> {
        const host = ctx.host
        if (!host) throw new BadRequestException('MCP import requires a machine')
        return async (absPath) => {
            try {
                return await this.hostAccess.withHost(
                    {
                        host,
                        daemon: ctx.daemon,
                        placement: ctx.placement,
                        agentId: ctx.agent?.id,
                        reason: 'mcp-import',
                        wake: false
                    },
                    (session) => daemonReadTextFile(session.rpc, absPath)
                )
            } catch (err) {
                if (!(err instanceof HostDaemonOfflineError)) throw err
                throw new ServiceUnavailableException(
                    `the machine is offline; ${host.kind === 'local' ? 'start its daemon' : 'wake it'} and retry`
                )
            }
        }
    }
}

// The managed composio server is injected at materialize time, never stored in
// extras.mcp — mirror that exactly on the way back in, so its config (and
// plaintext key) never gets persisted as user text.
const managedExclusionFor = (agent: Agent): McpManagedExclusion | null => {
    const composioConnectionId = (
        agent.extras as { composioConnectionId?: string | null }
    ).composioConnectionId
    if (!composioConnectionId) return null
    const scopeId = composioInjectScope(agent.framework)
    if (!scopeId) return null
    return { scopeId, names: [COMPOSIO_MCP_SERVER_NAME] }
}
