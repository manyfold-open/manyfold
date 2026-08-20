import {
    AgentMcpScopeRefreshResult,
    DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG,
    RefreshAgentMcpResponse,
    frameworkMcpSupport,
    mcpConfigFromExtras
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    jsonbMerge,
    type Agent,
    type Database
} from '@manyfold/db'
import { createClient as createSpritesClient } from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { daemonReadTextFile } from '@/modules/daemon/daemon-fs'
import { daemonAdvertisesFeature } from '@/modules/chat/chat-adapter'
import { COMPOSIO_MCP_SERVER_NAME } from '@/modules/connections/composio.service'
import { composioInjectScope } from '@/modules/agent-runtimes/mcp/composio-mcp'
import {
    readFileText,
    spritesLoggerFrom
} from '@/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { resolveMcpScopeTargets } from '@/modules/agent-runtimes/mcp/mcp-config'
import {
    importScopeTexts,
    type McpManagedExclusion
} from '@/modules/agent-runtimes/mcp/mcp-config-import'

// Pulls the runtime's real MCP config files back into agent.extras.mcp — the
// reverse of McpConfigMaterializer. Read-only on the runtime: files are never
// written or normalised here, and the materializer is deliberately NOT
// triggered afterwards (it would rewrite the very files we just read).
@Injectable()
export class McpImportService {
    private readonly log = new Logger(McpImportService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly agents: AgentsService,
        private readonly daemonRegistry: DaemonRegistryService
    ) {}

    async refresh(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<RefreshAgentMcpResponse> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        if (!frameworkMcpSupport(agent.framework))
            throw new BadRequestException(
                `${agent.framework} agents do not support MCP servers`
            )
        if (agent.runtime !== 'sprites' && agent.runtime !== 'daemon')
            throw new BadRequestException(
                'MCP import requires an agent on a sandbox or self-owned computer runtime'
            )
        if (!agent.runtimeId)
            throw new BadRequestException('agent has no linked runtime')
        const [runtime] = await this.db
            .select({ homeDir: agentRuntimes.homeDir })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, agent.runtimeId))
            .limit(1)
        const homeDir = runtime?.homeDir
        if (!homeDir)
            throw new BadRequestException(
                'agent runtime home dir is unknown (not bootstrapped yet)'
            )
        const read = await this.readerFor(agent)
        const allTargets = resolveMcpScopeTargets(agent.framework, {
            homeDir,
            workspacePath: agent.workspacePath ?? agent.mountPath
        })
        // A scope the target's CLI cannot read (claude user scope before the
        // ~/.claude.json containment) is excluded so its stored value survives
        // the fold, and reported as skipped rather than silently absent.
        const gatedScopes: AgentMcpScopeRefreshResult[] = []
        const targets: typeof allTargets = []
        for (const target of allTargets) {
            const gateMessage = await this.scopeReadGate(agent, target.scopeId)
            if (gateMessage)
                gatedScopes.push({
                    scopeId: target.scopeId,
                    status: 'skipped',
                    message: gateMessage
                })
            else targets.push(target)
        }
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
        if (result.changed)
            await this.db
                .update(agents)
                .set({
                    extras: jsonbMerge(agents.extras, { mcp: result.mcp }),
                    updatedAt: new Date()
                })
                .where(eq(agents.id, agent.id))
        return {
            agent: await this.agents.get(agentId, callerUserId, isAdmin),
            scopes: [...gatedScopes, ...result.scopes]
        }
    }

    // Reads one runtime file, null when absent — a seam for tests and the one
    // place the transport differs per runtime kind.
    protected async readerFor(
        agent: Agent
    ): Promise<(absPath: string) => Promise<string | null>> {
        if (agent.runtime === 'daemon') {
            if (!agent.daemonId)
                throw new BadRequestException('daemon agent has no daemonId')
            const daemonId = agent.daemonId
            return (absPath) =>
                daemonReadTextFile(this.daemonRegistry, daemonId, absPath)
        }
        if (!agent.spriteName || !agent.accountId)
            throw new BadRequestException(
                'MCP import requires a sprite-hosted agent'
            )
        const spriteName = agent.spriteName
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new BadRequestException(
                `sprites account ${agent.accountId} not found`
            )
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
        return (absPath) =>
            readFileText(client, spriteName, absPath, spritesLoggerFrom(this.log))
    }

    private async scopeReadGate(
        agent: Agent,
        scopeId: string
    ): Promise<string | null> {
        if (agent.runtime !== 'daemon') return null
        if (agent.framework !== 'claude-code' || scopeId !== 'user')
            return null
        const supported = await daemonAdvertisesFeature(
            this.db,
            agent.daemonId ?? '',
            DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG
        )
        return supported
            ? null
            : 'the user scope needs a newer mf CLI on this computer — run `mf update` or update from the runtime page'
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
