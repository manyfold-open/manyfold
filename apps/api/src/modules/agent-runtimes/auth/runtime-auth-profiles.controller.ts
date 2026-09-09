import type {
    RuntimeAuthListView,
    RuntimeAuthOperationView,
    RuntimeAuthProfileView
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
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromResource } from '@/common/decorators/subject-agent.decorator'
import { CreateRuntimeAuthProfileDto } from './dto/create-runtime-auth-profile.dto'
import { RuntimeAuthOperationDto } from './dto/runtime-auth-operation.dto'
import { SetRuntimeDefaultAuthDto } from './dto/set-runtime-default-auth.dto'
import { RuntimeAuthProfilesService } from './runtime-auth-profiles.service'

// Runtime auth profiles: the vendor sign-ins a runtime's host holds, and the
// operations that change them. Reads are runtime-read; every mutation is
// runtime-edit and refused to agent-runtime principals inside the service.
@Controller()
@UseGuards(AuthGuard)
export class RuntimeAuthProfilesController {
    constructor(private readonly profiles: RuntimeAuthProfilesService) {}

    @Get('agent-runtimes/:id/auth-profiles')
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    list(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RuntimeAuthListView> {
        return this.profiles.list(user.userId, id)
    }

    @Post('agent-runtimes/:id/auth-profiles')
    @HttpCode(201)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    create(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: CreateRuntimeAuthProfileDto
    ): Promise<RuntimeAuthProfileView> {
        return this.profiles.create(user, id, body)
    }

    @Post('agent-runtimes/:id/auth-profiles/:profileId/inspect')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:read')
    @SubjectAgentFromResource('agentRuntime', 'id')
    inspect(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('profileId') profileId: string
    ): Promise<RuntimeAuthProfileView> {
        return this.profiles.inspect(user.userId, id, profileId)
    }

    @Post('agent-runtimes/:id/auth-profiles/:profileId/login')
    @HttpCode(202)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    login(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('profileId') profileId: string,
        @Body() body: RuntimeAuthOperationDto
    ): Promise<RuntimeAuthOperationView> {
        return this.profiles.startLogin(user, id, profileId, body)
    }

    @Post('agent-runtimes/:id/auth-profiles/:profileId/logout')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    logout(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('profileId') profileId: string,
        @Body() body: RuntimeAuthOperationDto
    ): Promise<RuntimeAuthOperationView> {
        return this.profiles.logout(user, id, profileId, body)
    }

    @Delete('agent-runtimes/:id/auth-profiles/:profileId')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    remove(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('profileId') profileId: string,
        @Body() body: RuntimeAuthOperationDto
    ): Promise<RuntimeAuthOperationView> {
        return this.profiles.remove(user, id, profileId, body)
    }

    @Patch('agent-runtimes/:id/default-auth')
    @RequireApiTokenScope('agent-runtimes:edit')
    @SubjectAgentFromResource('agentRuntime', 'id')
    setDefault(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetRuntimeDefaultAuthDto
    ): Promise<RuntimeAuthListView> {
        return this.profiles.setDefault(user, id, body.profileId)
    }

    @Get('runtime-auth-operations/:operationId')
    @RequireApiTokenScope('agent-runtimes:read')
    operation(
        @CurrentUser() user: AuthPrincipal,
        @Param('operationId') operationId: string
    ): Promise<RuntimeAuthOperationView> {
        return this.profiles.operation(user.userId, operationId)
    }
}
