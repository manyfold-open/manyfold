import {
    AgentContextDocStatus,
    AgentCredentialsView,
    AgentModelConfigView,
    AgentStorageUsageResponse,
    AgentSummary,
    FrameworkUpgradeEvent,
    FrameworkUpgradeStep,
    MaterializeAgentMcpResponse,
    RefreshAgentMcpResponse,
    RefreshAgentModelConfigModelsResponse,
    RevealAgentCredentialsResponse,
    RotateRuntimeTokenResponse,
    UpdateAgentCredentialsBody
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Logger,
    NotFoundException,
    Param,
    Patch,
    Post,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { UsersService } from '@/modules/users/users.service'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    DenyBoundToken,
    ListFilteredByBoundAgent,
    SubjectAgentFromPath
} from '@/common/decorators/subject-agent.decorator'
import { AgentsService } from '@/modules/agents/agents.service'
import { AgentOrchestratorService } from '@/modules/agents/orchestration/agent-orchestrator.service'
import { AgentCredentialsService } from '@/modules/agents/credentials/agent-credentials.service'
import { AgentDiagnosticsService } from '@/modules/agents/agent-diagnostics.service'
import {
    resolveCreateStreamPlan,
    sanitizeMessage,
    streamAgentCreate
} from '@/modules/agents/create-stream'
import { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import { UpdateAgentDto } from '@/modules/agents/dto/update-agent.dto'
import { UpdateAgentCredentialsDto } from '@/modules/agents/dto/update-agent-credentials.dto'
import {
    RefreshAgentModelConfigModelsDto,
    UpdateAgentModelConfigDto
} from '@/modules/agents/dto/update-agent-model-config.dto'
import { UpdateAgentRuntimeAuthDto } from '@/modules/agents/dto/update-agent-runtime-auth.dto'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { AgentContextDocManageService } from '@/modules/agents/agent-context-doc-manage.service'
import { FrameworkVersionProbeService } from '@/modules/agents/framework-versions/framework-version-probe.service'
import { McpImportService } from '@/modules/agents/mcp-import.service'
import { McpConfigMaterializer } from '@/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { FrameworkUpgradeService } from '@/modules/agents/framework-versions/framework-upgrade.service'
import { AgentServiceRestartService } from '@/modules/agents/agent-service-restart.service'
import { UpgradeFrameworkVersionDto } from '@/modules/agents/dto/upgrade-framework-version.dto'

@Controller('agents')
@UseGuards(AuthGuard)
export class AgentsController {
    private readonly log = new Logger(AgentsController.name)

    constructor(
        private readonly agents: AgentsService,
        private readonly orchestrator: AgentOrchestratorService,
        private readonly credentials: AgentCredentialsService,
        private readonly diagnostics: AgentDiagnosticsService,
        private readonly modelConfig: AgentModelConfigService,
        private readonly adminSettings: AdminSettingsService,
        private readonly users: UsersService,
        private readonly frameworkVersionProbe: FrameworkVersionProbeService,
        private readonly mcpImport: McpImportService,
        private readonly mcpMaterializer: McpConfigMaterializer,
        private readonly frameworkUpgrade: FrameworkUpgradeService,
        private readonly serviceRestart: AgentServiceRestartService,
        private readonly contextDoc: AgentContextDocManageService
    ) {}

    @Get()
    @RequireApiTokenScope('agents:read')
    @ListFilteredByBoundAgent()
    async list(@CurrentUser() user: AuthPrincipal): Promise<AgentSummary[]> {
        const boundAgentId = boundAgentIdFromUser(user)
        const rows = await this.agents.listForUser(user.userId, {
            boundAgentId
        })
        return this.agents.summariesFor(rows)
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('agents:edit')
    @DenyBoundToken()
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateAgentDto,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        if (dto.targetUserId && dto.targetUserId !== user.userId)
            throw new BadRequestException(
                'targetUserId not allowed on /agents; use /admin/agents'
            )
        const accept = (req.headers['accept'] ?? '') as string
        if (!accept.includes('application/x-ndjson')) {
            const agent = await this.orchestrator.create({
                userId: user.userId,
                actorUserId: user.userId,
                dto,
                isAdmin: false
            })
            await res.code(201).send(agent)
            return
        }

        const plan = await resolveCreateStreamPlan(
            { adminSettings: this.adminSettings, users: this.users },
            user.userId,
            dto
        )
        await streamAgentCreate({
            res,
            framework: dto.framework,
            plan,
            log: this.log,
            run: (emitter) =>
                this.orchestrator.create(
                    {
                        userId: user.userId,
                        actorUserId: user.userId,
                        dto,
                        isAdmin: false
                    },
                    emitter
                )
        })
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.orchestrator.delete(id, user.userId, false)
    }

    @Post(':id/restart')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async restart(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentSummary> {
        return this.serviceRestart.restart(id, user.userId, false)
    }

    @Post(':id/runtime-token/rotate')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromPath('id')
    async rotateRuntimeToken(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RotateRuntimeTokenResponse> {
        return this.orchestrator.rotateRuntimeToken(id, user.userId, false)
    }

    @Post(':id/framework-version/refresh')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async refreshFrameworkVersion(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentSummary> {
        return this.frameworkVersionProbe.refresh(id, user.userId, false)
    }

    @Post(':id/mcp/refresh')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async refreshMcp(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RefreshAgentMcpResponse> {
        return this.mcpImport.refresh(id, user.userId, false)
    }

    // The push direction of :id/mcp/refresh — synchronous so the caller gets
    // per-scope outcomes (delivered / skipped needs-CLI / failed offline)
    // instead of a fire-and-forget log line (#781).
    @Post(':id/mcp/materialize')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async materializeMcp(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<MaterializeAgentMcpResponse> {
        const agent = await this.agents.findForCaller(id, user.userId, false)
        if (!agent) throw new NotFoundException(`agent ${id} not found`)
        let scopes
        try {
            scopes = await this.mcpMaterializer.materializeForAgent(agent)
        } catch (err) {
            throw new BadRequestException((err as Error).message)
        }
        return {
            agent: await this.agents.get(id, user.userId, false),
            scopes
        }
    }

    @Post(':id/framework-version/upgrade')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async upgradeFrameworkVersion(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto
    ): Promise<AgentSummary> {
        return this.frameworkUpgrade.upgrade(
            id,
            user.userId,
            dto.targetVersion,
            false
        )
    }

    @Post(':id/framework-version/upgrade-stream')
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async upgradeFrameworkStream(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto,
        @Res() res: FastifyReply
    ): Promise<void> {
        let started = false
        const write = (ev: FrameworkUpgradeEvent): void => {
            if (!started) {
                res.hijack()
                res.raw.writeHead(200, {
                    ...corsHeadersForOrigin(res.request.headers),
                    'content-type': 'application/x-ndjson',
                    'cache-control': 'no-cache',
                    'x-accel-buffering': 'no'
                })
                started = true
            }
            res.raw.write(JSON.stringify(ev) + '\n')
        }
        let lastStep: FrameworkUpgradeStep | null = null
        try {
            const agent = await this.frameworkUpgrade.upgradeStreaming(
                id,
                user.userId,
                dto.targetVersion,
                false,
                {
                    step: (s): void => {
                        lastStep = s
                        write({ type: 'step', step: s })
                    }
                }
            )
            write({ type: 'complete', agent })
        } catch (err) {
            if (!started) throw err
            write({ type: 'error', step: lastStep, message: sanitizeMessage(err) })
        } finally {
            if (started) res.raw.end()
        }
    }

    @Get(':id')
    @RequireApiTokenScope('agents:read')
    @SubjectAgentFromPath('id')
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentSummary> {
        return this.agents.get(id, user.userId, false)
    }

    @Patch(':id')
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateAgentDto
    ): Promise<AgentSummary> {
        return this.agents.update(id, user.userId, dto, false)
    }

    @Get(':id/model-config')
    @RequireApiTokenScope('model-config:read')
    @SubjectAgentFromPath('id')
    async getModelConfig(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentModelConfigView> {
        return this.modelConfig.getForAgent(user.userId, id, false)
    }

    @Patch(':id/model-config')
    @RequireApiTokenScope('model-config:edit')
    @SubjectAgentFromPath('id')
    async updateModelConfig(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateAgentModelConfigDto
    ): Promise<AgentModelConfigView> {
        return this.modelConfig.updateForAgent(user.userId, id, dto, false)
    }

    @Patch(':id/runtime-auth')
    @RequireApiTokenScope('model-config:edit')
    @SubjectAgentFromPath('id')
    async updateRuntimeAuth(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateAgentRuntimeAuthDto
    ): Promise<AgentModelConfigView> {
        return this.modelConfig.updateRuntimeAuth(user, id, dto)
    }

    @Post(':id/model-config/refresh-models')
    @HttpCode(200)
    @RequireApiTokenScope('model-config:edit')
    @SubjectAgentFromPath('id')
    async refreshModelConfigModels(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: RefreshAgentModelConfigModelsDto
    ): Promise<RefreshAgentModelConfigModelsResponse> {
        return this.modelConfig.refreshProviderModels(
            user.userId,
            id,
            false,
            dto?.source
        )
    }

    @Get(':id/context-doc')
    @RequireApiTokenScope('agents:read')
    @SubjectAgentFromPath('id')
    async getContextDoc(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentContextDocStatus> {
        return this.contextDoc.getStatus(user.userId, id, false)
    }

    @Post(':id/context-doc/refresh')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async refreshContextDoc(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentContextDocStatus> {
        return this.contextDoc.refresh(user.userId, id, false)
    }

    @Post(':id/storage-usage')
    @HttpCode(200)
    @RequireApiTokenScope('agents:read')
    @SubjectAgentFromPath('id')
    async storageUsage(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentStorageUsageResponse> {
        return this.diagnostics.storageUsage(user.userId, id, false)
    }

    // Measures now; on a sleeping sandbox that wakes it.
    @Post(':id/storage-usage/refresh')
    @HttpCode(200)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromPath('id')
    async refreshStorageUsage(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentStorageUsageResponse> {
        return this.diagnostics.refreshStorageUsage(user.userId, id, false)
    }

    @Get(':id/credentials')
    @RequireApiTokenScope('secrets:read')
    @SubjectAgentFromPath('id')
    async getCredentials(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentCredentialsView> {
        return this.credentials.getView(user.userId, id, false)
    }

    @Get(':id/credentials/reveal')
    @RequireApiTokenScope('secrets:read')
    @SubjectAgentFromPath('id')
    async revealCredentials(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RevealAgentCredentialsResponse> {
        return this.credentials.reveal(user.userId, id, false)
    }

    @Patch(':id/credentials')
    @RequireApiTokenScope('secrets:edit')
    @SubjectAgentFromPath('id')
    async updateCredentials(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: UpdateAgentCredentialsDto
    ): Promise<AgentCredentialsView> {
        return this.credentials.update(
            user.userId,
            id,
            body as UpdateAgentCredentialsBody,
            false
        )
    }
}

export const boundAgentIdFromUser = (user: AuthPrincipal): string | undefined => {
    // Runtime tokens are self-scoped by default: list endpoints see only the
    // agent's own resources — UNLESS the request opted into account scope
    // (ADR-0010), where the guard has authorized account-wide reach and the
    // list widens to the whole account. A2A grants retain their target filter.
    if (user.kind === 'agent-runtime')
        return user.accountScope ? undefined : user.agentId
    if (user.kind === 'legacy-runtime') return user.agentId
    return undefined
}
