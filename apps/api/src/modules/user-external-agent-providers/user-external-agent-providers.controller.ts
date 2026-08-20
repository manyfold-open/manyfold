import type {
    ExternalAgentProviderKind,
    ExternalProviderTestResult,
    RevealUserExternalAgentProviderResponse,
    UserExternalAgentProviderSummary
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
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { AllowBoundTokenWithoutSubject } from '@/common/decorators/subject-agent.decorator'
import { runtimeAgentId } from '@/modules/auth/auth-principal'
import { AuthService } from '@/modules/auth/auth.service'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import {
    CreateUserExternalAgentProviderDto,
    TestExternalAgentProviderInlineDto,
    UpdateUserExternalAgentProviderDto
} from '@/modules/user-external-agent-providers/dto/external-agent-provider.dto'
import { UserExternalAgentProvidersService } from '@/modules/user-external-agent-providers/user-external-agent-providers.service'

@Controller('me/external-agent-providers')
@UseGuards(AuthGuard)
export class UserExternalAgentProvidersController {
    constructor(
        private readonly service: UserExternalAgentProvidersService,
        private readonly auth: AuthService,
        private readonly bearerAuth: BearerAuthService
    ) {}

    @Get()
    @RequireApiTokenScope('byo-providers:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    async list(
        @CurrentUser() user: AuthPrincipal,
        @Query('provider') provider?: ExternalAgentProviderKind
    ): Promise<UserExternalAgentProviderSummary[]> {
        await this.ensureLocalUser(user.userId)
        return this.service.list(user.userId, provider)
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('byo-providers:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateUserExternalAgentProviderDto
    ): Promise<UserExternalAgentProviderSummary> {
        await this.ensureLocalUser(user.userId)
        return this.service.create({
            userId: user.userId,
            provider: dto.provider,
            label: dto.label,
            endpointUrl: dto.endpointUrl,
            apiKey: dto.apiKey,
            metadata: dto.metadata
        })
    }

    @Patch(':id')
    @RequireApiTokenScope('byo-providers:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    async update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateUserExternalAgentProviderDto
    ): Promise<UserExternalAgentProviderSummary> {
        return this.service.update({
            userId: user.userId,
            id,
            label: dto.label,
            endpointUrl: dto.endpointUrl,
            apiKey: dto.apiKey,
            metadata: dto.metadata
        })
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('byo-providers:edit')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.service.delete(user.userId, id)
    }

    @Get(':id/reveal')
    @RequireApiTokenScope('secrets:read')
    @AllowBoundTokenWithoutSubject('user-level provider reveal; agent tokens denied')
    async reveal(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RevealUserExternalAgentProviderResponse> {
        if (runtimeAgentId(user))
            throw new ForbiddenException(
                'provider key reveal requires a human session or account API token'
            )
        return this.service.reveal(user.userId, id)
    }

    @Post('test')
    @HttpCode(200)
    @RequireApiTokenScope('byo-providers:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    async testInline(
        @CurrentUser() _user: AuthPrincipal,
        @Body() dto: TestExternalAgentProviderInlineDto
    ): Promise<ExternalProviderTestResult> {
        return this.service.testInline({
            provider: dto.provider,
            endpointUrl: dto.endpointUrl,
            apiKey: dto.apiKey
        })
    }

    @Post(':id/test')
    @HttpCode(200)
    @RequireApiTokenScope('byo-providers:read')
    @AllowBoundTokenWithoutSubject('user-level resource; scope alone gates access')
    async testSaved(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ExternalProviderTestResult> {
        return this.service.testSaved(user.userId, id)
    }

    private async ensureLocalUser(userId: string): Promise<string> {
        const email =
            (await this.bearerAuth.getUserEmail(userId)) ??
            `${userId.replace(/[^a-zA-Z0-9_.-]/g, '-')}@unknown.nca.local`
        await this.auth.upsertUser({ id: userId, email })
        return email
    }
}
