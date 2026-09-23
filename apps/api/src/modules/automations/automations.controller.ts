import type {
    AutomationDetail,
    AutomationRunSummary,
    AutomationSummary
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    SubjectAgentFromBody,
    SubjectAgentFromQuery,
    SubjectAgentFromResource
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import { AutomationsService } from './automations.service'
import { CreateAutomationDto, UpdateAutomationDto } from './dto/automations.dto'

@Controller('automations')
@UseGuards(AuthGuard)
export class AutomationsController {
    constructor(private readonly automations: AutomationsService) {}

    @Get()
    @RequireApiTokenScope('automations:read')
    @SubjectAgentFromQuery('agentId')
    list(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string
    ): Promise<AutomationSummary[]> {
        const effective = agentId ?? boundAgentIdFromUser(user)
        return this.automations.list(user.userId, effective)
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('automations:edit')
    @SubjectAgentFromBody('agentId')
    create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateAutomationDto
    ): Promise<AutomationDetail> {
        return this.automations.create(user.userId, dto)
    }

    @Get(':id')
    @RequireApiTokenScope('automations:read')
    @SubjectAgentFromResource('automation', 'id')
    get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AutomationDetail> {
        return this.automations.get(user.userId, id)
    }

    @Patch(':id')
    @RequireApiTokenScope('automations:edit')
    @SubjectAgentFromResource('automation', 'id')
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateAutomationDto
    ): Promise<AutomationDetail> {
        return this.automations.update(user.userId, id, dto)
    }

    @Post(':id/run')
    @HttpCode(201)
    @RequireApiTokenScope('automations:edit')
    @SubjectAgentFromResource('automation', 'id')
    run(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<AutomationRunSummary> {
        return this.automations.runNow(user.userId, id)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('automations:edit')
    @SubjectAgentFromResource('automation', 'id')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.automations.delete(user.userId, id)
    }
}
