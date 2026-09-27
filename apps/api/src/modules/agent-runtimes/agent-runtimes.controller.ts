import type {
    AgentControlUiUrlResponse,
    AgentRuntimeSummary,
    RuntimeAccountView,
    SetControlUiBody,
    SetDashboardBody
} from '@manyfold/shared'
import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    InternalServerErrorException,
    NotFoundException,
    Param,
    Patch,
    Optional,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    ListFilteredByBoundAgent,
    SubjectAgentFromResource
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import { AgentRuntimesService } from './agent-runtimes.service'
import { RenameRuntimeDto } from './dto/rename-runtime.dto'
import { RuntimeDashboardService } from './orchestration/runtime-dashboard.service'
import { RuntimeAccountService } from './account/runtime-account.service'

export const RUNTIME_AGENTS_BOUND_CODE = 'runtime.agents_bound'

@Controller('agent-runtimes')
@UseGuards(AuthGuard)
export class AgentRuntimesController {
    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly dashboard: RuntimeDashboardService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent only there.
        @Optional()
        private readonly account?: RuntimeAccountService
    ) {}

    @Get()
    @RequireApiTokenScope('agent-runtimes:read')
    @ListFilteredByBoundAgent()
    async list(@CurrentUser() user: AuthPrincipal): Promise<AgentRuntimeSummary[]> {
        const rows = await this.runtimes.listByUser(user.userId, {
            boundAgentId: boundAgentIdFromUser(user)
        })
        return this.runtimes.toSummaries(rows)
    }

    @Get(':id')
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentRuntimeSummary> {
        const row = await this.runtimes.findById(id)
        if (!row || row.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        return this.runtimes.toSummary(row)
    }

    // R8: a runtime with agents on it is refused; an empty one is just a row.
    // agents.runtime_id cascades, so this is the only guard between a delete
    // and silently losing every agent on the runtime.
    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        const row = await this.runtimes.findById(id)
        if (!row || row.userId !== user.userId)
            throw new NotFoundException(`agent runtime ${id} not found`)
        const bound = await this.runtimes.agentsCount(row.id)
        if (bound > 0)
            throw new ConflictException({
                code: RUNTIME_AGENTS_BOUND_CODE,
                message: `runtime ${row.id} still has ${bound} agent(s); delete them first`
            })
        await this.runtimes.delete(row.id)
    }

    @Patch(':id/name')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async rename(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: RenameRuntimeDto
    ): Promise<AgentRuntimeSummary> {
        const updated = await this.runtimes.rename(user.userId, id, body.name)
        return this.runtimes.toSummary(updated)
    }

    @Patch(':id/control-ui')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async setControlUi(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetControlUiBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setControlUi(user.userId, id, !!body.enabled, false)
    }

    @Get(':id/control-ui-url')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async getControlUiUrl(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('agentId') agentId?: string
    ): Promise<AgentControlUiUrlResponse> {
        return this.dashboard.getControlUiUrl(id, user.userId, false, agentId)
    }

    // Who is signed in to the runtime's CLI and what that account has used.
    // A page open must not wake a sleeping sandbox; `wake=1` is the user's
    // explicit click and the only thing that starts the VM.
    @Get(':id/account')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async getAccount(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('wake') wake?: string,
        // `refreshUsage=1`: the user's explicit ask to read usage from the
        // vendor again instead of the kept answer.
        @Query('refreshUsage') refreshUsage?: string
    ): Promise<RuntimeAccountView> {
        if (!this.account)
            throw new InternalServerErrorException(
                'runtime account service unavailable'
            )
        return this.account.getView(user.userId, id, {
            wake: wake === '1' || wake === 'true',
            refreshUsage: refreshUsage === '1' || refreshUsage === 'true'
        })
    }

    @Patch(':id/dashboard')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    async setDashboard(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetDashboardBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setDashboard(user.userId, id, !!body.enabled, false)
    }
}
