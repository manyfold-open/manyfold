import {
    AgentCreateEvent,
    AgentCreateStep,
    AgentModelConfigView,
    AgentStopResponse,
    AgentStorageUsageResponse,
    AgentSummary,
    FrameworkUpgradeEvent,
    FrameworkUpgradeStep,
    RefreshAgentModelConfigModelsResponse,
    stepsFor
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Logger,
    Param,
    Patch,
    Post,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { UsersService } from '@/modules/users/users.service'
import {
    AgentsService,
    agentRowToSummary
} from '@/modules/agents/agents.service'
import {
    AgentOrchestratorService,
    resolveRuntime,
    type AgentProgressEmitter
} from '@/modules/agents/orchestration/agent-orchestrator.service'
import {
    classifyError,
    sanitizeMessage
} from '@/modules/agents/agents.controller'
import { AgentDiagnosticsService } from '@/modules/agents/agent-diagnostics.service'
import { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import { UpdateAgentDto } from '@/modules/agents/dto/update-agent.dto'
import {
    RefreshAgentModelConfigModelsDto,
    UpdateAgentModelConfigDto
} from '@/modules/agents/dto/update-agent-model-config.dto'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { FrameworkVersionProbeService } from '@/modules/agents/framework-versions/framework-version-probe.service'
import { FrameworkUpgradeService } from '@/modules/agents/framework-versions/framework-upgrade.service'
import { AgentServiceRestartService } from '@/modules/agents/agent-service-restart.service'
import { UpgradeFrameworkVersionDto } from '@/modules/agents/dto/upgrade-framework-version.dto'

@Controller('admin/agents')
@UseGuards(AuthGuard, AdminGuard)
export class AdminAgentsController {
    private readonly log = new Logger(AdminAgentsController.name)

    constructor(
        private readonly agents: AgentsService,
        private readonly orchestrator: AgentOrchestratorService,
        private readonly diagnostics: AgentDiagnosticsService,
        private readonly modelConfig: AgentModelConfigService,
        private readonly adminSettings: AdminSettingsService,
        private readonly users: UsersService,
        private readonly frameworkVersionProbe: FrameworkVersionProbeService,
        private readonly frameworkUpgrade: FrameworkUpgradeService,
        private readonly serviceRestart: AgentServiceRestartService
    ) {}

    @Get()
    async list(): Promise<AgentSummary[]> {
        const rows = await this.agents.listAll()
        return rows.map((r) =>
            agentRowToSummary(
                r.agent,
                r.clusterName,
                false,
                r.dashboardFlags
            )
        )
    }

    @Post()
    @HttpCode(201)
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateAgentDto,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        const ownerUserId = await this.resolveOwnerUserId(
            user.userId,
            dto.targetUserId
        )
        const accept = (req.headers['accept'] ?? '') as string
        if (!accept.includes('application/x-ndjson')) {
            const agent = await this.orchestrator.create({
                userId: ownerUserId,
                actorUserId: user.userId,
                dto,
                isAdmin: true
            })
            await res.code(201).send(agent)
            return
        }

        res.hijack()
        const [defaults, userOverrides] = await Promise.all([
            this.adminSettings.getCachedFrameworkRuntimeDefaults(),
            this.users.getFrameworkRuntimeOverrides(ownerUserId)
        ])
        const runtime = resolveRuntime(
            dto.framework,
            dto.runtime,
            defaults,
            userOverrides
        )
        const steps = stepsFor(dto.framework, runtime)
        let lastIndex = -1
        const indexOf = (s: AgentCreateStep): number => {
            const idx = steps.indexOf(s)
            if (idx === -1) {
                this.log.warn(
                    `progress step "${s}" not in stepsFor(${dto.framework}, ${runtime}); UI progress would reset — using fallback index ${lastIndex}`
                )
                return Math.max(lastIndex, 0)
            }
            lastIndex = idx
            return idx
        }
        res.raw.writeHead(201, {
            ...corsHeadersForOrigin(res.request.headers),
            'content-type': 'application/x-ndjson',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no'
        })
        const write = (ev: AgentCreateEvent): void => {
            res.raw.write(JSON.stringify(ev) + '\n')
        }

        let lastStep: AgentCreateStep | null = null
        const emitter: AgentProgressEmitter = {
            step: (s): void => {
                lastStep = s
                write({
                    type: 'step',
                    step: s,
                    index: indexOf(s),
                    total: steps.length,
                    startedAt: new Date().toISOString()
                })
            }
        }

        try {
            const agent = await this.orchestrator.create(
                {
                    userId: ownerUserId,
                    actorUserId: user.userId,
                    dto,
                    isAdmin: true
                },
                emitter
            )
            write({ type: 'complete', agent })
        } catch (err) {
            write({
                type: 'error',
                step: lastStep,
                errorClass: classifyError(err),
                message: sanitizeMessage(err)
            })
        } finally {
            res.raw.end()
        }
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.orchestrator.delete(id, user.userId, true)
    }

    @Post(':id/stop')
    @HttpCode(200)
    async stop(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentStopResponse> {
        return this.agents.stopSprite(id, user.userId, true)
    }

    @Post(':id/restart')
    @HttpCode(200)
    async restart(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentSummary> {
        return this.serviceRestart.restart(id, user.userId, true)
    }

    @Get(':id')
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentSummary> {
        return this.agents.get(id, user.userId, true)
    }

    @Patch(':id')
    async update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateAgentDto
    ): Promise<AgentSummary> {
        return this.agents.update(id, user.userId, dto, true)
    }

    @Get(':id/model-config')
    async getModelConfig(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentModelConfigView> {
        return this.modelConfig.getForAgent(user.userId, id, true)
    }

    @Patch(':id/model-config')
    async updateModelConfig(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateAgentModelConfigDto
    ): Promise<AgentModelConfigView> {
        return this.modelConfig.updateForAgent(user.userId, id, dto, true)
    }

    @Post(':id/model-config/refresh-models')
    @HttpCode(200)
    async refreshModelConfigModels(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: RefreshAgentModelConfigModelsDto
    ): Promise<RefreshAgentModelConfigModelsResponse> {
        return this.modelConfig.refreshProviderModels(
            user.userId,
            id,
            true,
            dto?.source
        )
    }

    @Post(':id/storage-usage')
    @HttpCode(200)
    async storageUsage(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentStorageUsageResponse> {
        return this.diagnostics.storageUsage(user.userId, id, true)
    }

    @Post(':id/framework-version/refresh')
    @HttpCode(200)
    async refreshFrameworkVersion(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentSummary> {
        return this.frameworkVersionProbe.refresh(id, user.userId, true)
    }

    @Post(':id/framework-version/upgrade')
    @HttpCode(200)
    async upgradeFrameworkVersion(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto
    ): Promise<AgentSummary> {
        return this.frameworkUpgrade.upgrade(
            id,
            user.userId,
            dto.targetVersion,
            true
        )
    }

    @Post(':id/framework-version/upgrade-stream')
    async upgradeFrameworkStream(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpgradeFrameworkVersionDto,
        @Res() res: FastifyReply
    ): Promise<void> {
        res.hijack()
        res.raw.writeHead(200, {
            ...corsHeadersForOrigin(res.request.headers),
            'content-type': 'application/x-ndjson',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no'
        })
        const write = (ev: FrameworkUpgradeEvent): void => {
            res.raw.write(JSON.stringify(ev) + '\n')
        }
        let lastStep: FrameworkUpgradeStep | null = null
        try {
            const agent = await this.frameworkUpgrade.upgradeStreaming(
                id,
                user.userId,
                dto.targetVersion,
                true,
                {
                    step: (s): void => {
                        lastStep = s
                        write({ type: 'step', step: s })
                    }
                }
            )
            write({ type: 'complete', agent })
        } catch (err) {
            write({ type: 'error', step: lastStep, message: sanitizeMessage(err) })
        } finally {
            res.raw.end()
        }
    }

    private async resolveOwnerUserId(
        callerUserId: string,
        targetUserId: string | undefined
    ): Promise<string> {
        if (!targetUserId || targetUserId === callerUserId) return callerUserId
        const exists = await this.agents.userExists(targetUserId)
        if (!exists)
            throw new BadRequestException(
                `targetUserId ${targetUserId} does not exist`
            )
        return targetUserId
    }
}
