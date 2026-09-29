import type {
    AgentControlUiUrlResponse,
    AgentRuntimeSummary,
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
    NotFoundException,
    Param,
    Patch,
    Post,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RUNTIME_AGENTS_BOUND_CODE } from './agent-runtimes.controller'
import { AgentRuntimesService } from './agent-runtimes.service'
import { RuntimeDashboardService } from './orchestration/runtime-dashboard.service'

// Same DTO and the same delete rule as the user route (R8), over every user.
@Controller('admin/agent-runtimes')
@UseGuards(AuthGuard, AdminGuard)
export class AdminAgentRuntimesController {
    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly dashboard: RuntimeDashboardService
    ) {}

    @Get()
    async list(): Promise<AgentRuntimeSummary[]> {
        return this.runtimes.toSummaries(await this.runtimes.listAll())
    }

    @Get(':id')
    async get(@Param('id') id: string): Promise<AgentRuntimeSummary> {
        const row = await this.runtimes.findById(id)
        if (!row) throw new NotFoundException(`agent runtime ${id} not found`)
        return this.runtimes.toSummary(row)
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(@Param('id') id: string): Promise<void> {
        const row = await this.runtimes.findById(id)
        if (!row) throw new NotFoundException(`agent runtime ${id} not found`)
        const bound = await this.runtimes.agentsCount(row.id)
        if (bound > 0)
            throw new ConflictException({
                code: RUNTIME_AGENTS_BOUND_CODE,
                message: `runtime ${row.id} still has ${bound} agent(s); delete them first`
            })
        await this.runtimes.delete(row.id)
    }

    @Patch(':id/control-ui')
    @HttpCode(200)
    async setControlUi(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetControlUiBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setControlUi(user.userId, id, !!body.enabled, true)
    }

    @Get(':id/control-ui-url')
    @HttpCode(200)
    async getControlUiUrl(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('agentId') agentId?: string
    ): Promise<AgentControlUiUrlResponse> {
        return this.dashboard.getControlUiUrl(id, user.userId, true, agentId)
    }

    @Post(':id/service/restart')
    @HttpCode(200)
    async restartService(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.restartService(user.userId, id, true)
    }

    @Patch(':id/dashboard')
    @HttpCode(200)
    async setDashboard(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetDashboardBody
    ): Promise<AgentRuntimeSummary> {
        return this.dashboard.setDashboard(user.userId, id, !!body.enabled, true)
    }
}
