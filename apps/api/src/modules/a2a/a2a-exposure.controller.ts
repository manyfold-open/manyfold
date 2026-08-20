import type {
    A2aExposure,
    A2aTaskTracePage,
    SetExposureBody
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Get,
    Param,
    Put,
    Query,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { A2aService } from './a2a.service'

// Owner-facing toggle for "expose this agent as an A2A server". The public
// Agent Card route reads the same agents.extras.a2aExposure with no auth.
@Controller('a2a')
@UseGuards(AuthGuard)
export class A2aExposureController {
    constructor(private readonly a2a: A2aService) {}

    @Get('agents/:agentId/exposure')
    @RequireAuthSession()
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string
    ): Promise<A2aExposure> {
        await this.a2a.assertOwner(agentId, user.userId)
        return (await this.a2a.getExposure(agentId)) ?? { enabled: false }
    }

    @Put('agents/:agentId/exposure')
    @RequireAuthSession()
    async set(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: SetExposureBody
    ): Promise<A2aExposure> {
        await this.a2a.assertOwner(agentId, user.userId)
        return this.a2a.setExposure(agentId, {
            enabled: body?.enabled ?? false,
            skillId: body?.skillId?.trim() || undefined
        })
    }

    @Get('agents/:agentId/tasks')
    @RequireAuthSession()
    async tasks(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Query('cursor') cursor?: string,
        @Query('state') state?: string
    ): Promise<A2aTaskTracePage> {
        await this.a2a.assertOwner(agentId, user.userId)
        return this.a2a.listAgentTasks(user.userId, agentId, {
            cursor: cursor?.trim() || undefined,
            state: state?.trim() || undefined
        })
    }
}
