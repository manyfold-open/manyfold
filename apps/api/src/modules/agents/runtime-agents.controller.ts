import type {
    AgentFramework,
    AgentSummary,
    FrameworkAgentSummary
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromResource } from '@/common/decorators/subject-agent.decorator'
import {
    ACQUISITION_PORT,
    type AcquisitionPort
} from '@/common/ports/acquisition.ports'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { AddRuntimeAgentDto } from '@/modules/agents/dto/add-runtime-agent.dto'
import { RuntimeAgentAttachService } from '@/modules/agents/orchestration/runtime-agent-attach.service'

@Controller('agent-runtimes')
@UseGuards(AuthGuard)
export class RuntimeAgentsController {
    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly attach: RuntimeAgentAttachService,
        @Inject(ACQUISITION_PORT)
        private readonly attribution: AcquisitionPort
    ) {}

    @Post(':id/agents')
    @HttpCode(201)
    @RequireApiTokenScope('agents:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async addAgent(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') runtimeId: string,
        @Body() dto: AddRuntimeAgentDto
    ): Promise<AgentSummary> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime || runtime.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        const summary = await this.attach.attach({
            runtime,
            name: dto.name,
            workspace: dto.workspace,
            model: dto.model,
            cloneFrom: dto.cloneFrom
        })
        // This route never enters orchestrator.create, so the activation
        // conversion hooks here; the owner check above guarantees actor ==
        // owner. The admin controller below is on-behalf and doesn't count.
        await this.attribution.recordFirstAgentCreated({
            userId: user.userId
        })
        return summary
    }

    @Get(':id/framework-agents')
    @RequireApiTokenScope('agents:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async listFrameworkAgents(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') runtimeId: string
    ): Promise<FrameworkAgentSummary[]> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime || runtime.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return listFrameworkAgents(this.adapterRegistry, runtime)
    }
}

@Controller('admin/agent-runtimes')
@UseGuards(AuthGuard, AdminGuard)
export class AdminRuntimeAgentsController {
    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly adapterRegistry: AgentAdapterRegistry,
        private readonly attach: RuntimeAgentAttachService
    ) {}

    @Post(':id/agents')
    @HttpCode(201)
    async addAgent(
        @Param('id') runtimeId: string,
        @Body() dto: AddRuntimeAgentDto
    ): Promise<AgentSummary> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return this.attach.attach({
            runtime,
            name: dto.name,
            workspace: dto.workspace,
            model: dto.model,
            cloneFrom: dto.cloneFrom
        })
    }

    @Get(':id/framework-agents')
    async listFrameworkAgents(
        @Param('id') runtimeId: string
    ): Promise<FrameworkAgentSummary[]> {
        const runtime = await this.runtimes.findById(runtimeId)
        if (!runtime)
            throw new NotFoundException(`agent runtime ${runtimeId} not found`)
        return listFrameworkAgents(this.adapterRegistry, runtime)
    }
}

const SUPPORTED_FRAMEWORKS_FOR_LIVE_AGENTS: ReadonlySet<AgentFramework> =
    new Set<AgentFramework>([
        'claude-code',
        'codex',
        'gemini-cli',
        'openclaw',
        'hermes'
    ])

const listFrameworkAgents = async (
    adapterRegistry: AgentAdapterRegistry,
    runtime: Awaited<ReturnType<AgentRuntimesService['findById']>> & {}
): Promise<FrameworkAgentSummary[]> => {
    if (!runtime) throw new BadRequestException('runtime required')
    if (!SUPPORTED_FRAMEWORKS_FOR_LIVE_AGENTS.has(runtime.framework))
        throw new ConflictException(
            `framework ${runtime.framework} does not support live agent listing`
        )
    const adapter = adapterRegistry.get(runtime.framework)
    return adapter.listAgents({
        runtime,
        primaryAgentId: runtime.primaryAgentId ?? null
    })
}

