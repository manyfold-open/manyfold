import type {
    CloudflareConnectionResourcesResponse,
    ComposioConnectionToolsResponse,
    CreateCloudflareConnectionResult,
    GithubConnectionReposResponse,
    GithubConnectionStartResponse,
    RevealConnectionSecretResponse,
    UserConnectionSummary
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
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
import { AllowBoundTokenWithoutSubject } from '@/common/decorators/subject-agent.decorator'
import { runtimeAgentId } from '@/modules/auth/auth-principal'
import {
    CreateCloudflareConnectionDto,
    CreateComposioConnectionDto,
    RenameConnectionDto
} from '@/modules/connections/dto/connection.dto'
import { ConnectionsService } from '@/modules/connections/connections.service'

@Controller('me/connections')
@UseGuards(AuthGuard)
export class ConnectionsController {
    constructor(private readonly service: ConnectionsService) {}

    @Get()
    @RequireApiTokenScope('connections:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    list(@CurrentUser() user: AuthPrincipal): Promise<UserConnectionSummary[]> {
        return this.service.list(user.userId)
    }

    @Patch(':id')
    @RequireApiTokenScope('connections:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    rename(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: RenameConnectionDto
    ): Promise<UserConnectionSummary> {
        return this.service.rename(user.userId, id, dto.name)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('connections:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        return this.service.delete(user.userId, id)
    }

    @Post('github/start')
    @RequireApiTokenScope('connections:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    githubStart(@CurrentUser() user: AuthPrincipal): GithubConnectionStartResponse {
        return this.service.startGithub(user.userId)
    }

    @Post('cloudflare')
    @RequireApiTokenScope('connections:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    cloudflare(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateCloudflareConnectionDto
    ): Promise<CreateCloudflareConnectionResult> {
        return this.service.createCloudflare(user.userId, dto)
    }

    @Post('composio')
    @RequireApiTokenScope('connections:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    composio(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateComposioConnectionDto
    ): Promise<UserConnectionSummary> {
        return this.service.createComposio(user.userId, dto)
    }

    @Get(':id/github/repos')
    @RequireApiTokenScope('connections:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    githubRepos(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<GithubConnectionReposResponse> {
        return this.service.githubRepos(user.userId, id)
    }

    @Get(':id/cloudflare/resources')
    @RequireApiTokenScope('connections:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    cloudflareResources(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<CloudflareConnectionResourcesResponse> {
        return this.service.cloudflareResources(user.userId, id)
    }

    @Get(':id/composio/tools')
    @RequireApiTokenScope('connections:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    composioTools(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ComposioConnectionToolsResponse> {
        return this.service.composioTools(user.userId, id)
    }

    @Get(':id/reveal')
    @RequireApiTokenScope('secrets:read')
    @AllowBoundTokenWithoutSubject('user-level connection reveal; agent tokens denied')
    reveal(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RevealConnectionSecretResponse> {
        if (runtimeAgentId(user))
            throw new ForbiddenException(
                'connection secret reveal requires a human session or account API token'
            )
        return this.service.revealComposioKey(user.userId, id)
    }
}
