import type {
    ModelPriceEntryView,
    ModelPriceSourcesView,
    ProviderModelPricesView,
    ProviderTestResult,
    RevealUserModelProviderResponse,
    UserModelProviderSummary,
    UserModelProviderUsageReport
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    Inject,
    Optional,
    Param,
    Patch,
    Post,
    Put,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    AllowBoundTokenWithoutSubject,
    DenyBoundToken
} from '@/common/decorators/subject-agent.decorator'
import { runtimeAgentId } from '@/modules/auth/auth-principal'
import { AuthService } from '@/modules/auth/auth.service'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import {
    MANAGED_MODELS_PORT,
    noManagedModelsPort,
    type ManagedModelsPort
} from '@/common/ports/managed-models.ports'
import {
    CreateBuiltInUserModelProviderDto,
    CreateUserModelProviderDto,
    TestInlineProviderDto,
    UpdateUserModelProviderDto
} from '@/modules/model-providers/dto/model-provider.dto'
import { UpsertProviderModelPriceDto } from '@/modules/model-providers/dto/scoped-model-prices.dto'
import { ModelProvidersService } from '@/modules/model-providers/model-providers.service'
import { ScopedModelPricesService } from '@/modules/model-providers/scoped-model-prices.service'

@Controller('me/model-providers')
@UseGuards(AuthGuard)
export class ModelProvidersController {
    constructor(
        private readonly service: ModelProvidersService,
        private readonly auth: AuthService,
        private readonly bearerAuth: BearerAuthService,
        private readonly modelPrices: ScopedModelPricesService,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means no managed business (nothing to ensure or
        // delete on the managed side).
        @Optional()
        @Inject(MANAGED_MODELS_PORT)
        private readonly managedModels: ManagedModelsPort = noManagedModelsPort
    ) {}

    @Get()
    @RequireApiTokenScope('model-providers:read')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async list(
        @CurrentUser() user: AuthPrincipal
    ): Promise<UserModelProviderSummary[]> {
        const email = await this.ensureLocalUser(user.userId)
        await this.managedModels.ensureDefaultProviders({
            userId: user.userId,
            email
        })
        return this.service.list(user.userId)
    }

    // Declared above the `:id` routes: there is no bare @Get(':id') on this
    // controller today, but adding one later would otherwise swallow `usage`.
    @Get('usage')
    @RequireApiTokenScope('model-providers:read')
    // Unlike list(), which masks keys, this returns the owner's total spend
    // across every provider — not something a runtime-bound agent token
    // should be able to read on its owner's behalf.
    @DenyBoundToken()
    async usage(
        @CurrentUser() user: AuthPrincipal,
        @Query('from') from?: string,
        @Query('to') to?: string
    ): Promise<UserModelProviderUsageReport> {
        return this.service.listUsage(user.userId, { from, to })
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('model-providers:edit')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateUserModelProviderDto
    ): Promise<UserModelProviderSummary> {
        await this.ensureLocalUser(user.userId)
        return this.service.create({
            userId: user.userId,
            inferenceProtocol: dto.inferenceProtocol,
            providerName: dto.providerName,
            apiKey: dto.apiKey,
            baseUrl: dto.baseUrl,
            modelsListUrl: dto.modelsListUrl ?? null
        })
    }

    @Post('built-in')
    @HttpCode(201)
    @RequireApiTokenScope('model-providers:edit')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async createBuiltIn(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateBuiltInUserModelProviderDto
    ): Promise<UserModelProviderSummary> {
        await this.ensureLocalUser(user.userId)
        return this.service.createBuiltIn({
            userId: user.userId,
            builtInId: dto.builtInId,
            providerName: dto.providerName,
            apiKey: dto.apiKey
        })
    }

    @Patch(':id')
    @RequireApiTokenScope('model-providers:edit')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateUserModelProviderDto
    ): Promise<UserModelProviderSummary> {
        return this.service.update({
            userId: user.userId,
            id,
            providerName: dto.providerName,
            inferenceProtocol: dto.inferenceProtocol,
            apiKey: dto.apiKey,
            baseUrl: dto.baseUrl ?? undefined,
            modelsListUrl: dto.modelsListUrl ?? undefined,
            enabledModels: dto.enabledModels
        })
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('model-providers:edit')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        const deletedManaged = await this.managedModels.deleteManagedProvider(
            user.userId,
            id
        )
        if (deletedManaged) return
        await this.service.delete(user.userId, id)
    }

    @Get(':id/reveal')
    @RequireApiTokenScope('secrets:read')
    @AllowBoundTokenWithoutSubject(
        'user-level provider reveal; agent tokens denied'
    )
    async reveal(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<RevealUserModelProviderResponse> {
        if (runtimeAgentId(user))
            throw new ForbiddenException(
                'provider key reveal requires a human session or account API token'
            )
        return this.service.reveal(user.userId, id)
    }

    @Post('test')
    @HttpCode(200)
    @RequireApiTokenScope('model-providers:read')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async testInline(
        @CurrentUser() _user: AuthPrincipal,
        @Body() dto: TestInlineProviderDto
    ): Promise<ProviderTestResult> {
        return this.service.testInline({
            inferenceProtocol: dto.inferenceProtocol,
            apiKey: dto.apiKey,
            baseUrl: dto.baseUrl,
            modelsListUrl: dto.modelsListUrl ?? null
        })
    }

    @Post(':id/test')
    @HttpCode(200)
    @RequireApiTokenScope('model-providers:read')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async testSaved(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ProviderTestResult> {
        return this.service.testSaved(user.userId, id)
    }

    // Per-model prices for this provider row. Model ids carry '/', so they
    // travel as query params or body fields, never as path segments. Reads work
    // on managed rows too (the platform's numbers, shown read-only); writes are
    // BYO-only and refused there.
    @Get(':id/model-prices')
    @RequireApiTokenScope('model-providers:read')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async modelPricesList(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ProviderModelPricesView> {
        const row = await this.service.getOwned(user.userId, id)
        return this.modelPrices.providerModelPrices(row)
    }

    @Get(':id/model-prices/candidates')
    @RequireApiTokenScope('model-providers:read')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async modelPricesCandidates(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('model') model: string,
        @Query('q') query?: string
    ): Promise<ModelPriceSourcesView> {
        const row = await this.service.getOwned(user.userId, id)
        return this.modelPrices.providerCandidates(
            row,
            model ?? '',
            query?.trim() || undefined
        )
    }

    @Put(':id/model-prices')
    @RequireApiTokenScope('model-providers:edit')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async modelPricesUpsert(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpsertProviderModelPriceDto
    ): Promise<ModelPriceEntryView> {
        const row = await this.service.getOwned(user.userId, id)
        return this.modelPrices.providerUpsert(row, dto, user.userId)
    }

    @Delete(':id/model-prices')
    @HttpCode(204)
    @RequireApiTokenScope('model-providers:edit')
    @AllowBoundTokenWithoutSubject(
        'user-level resource; scope alone gates access'
    )
    async modelPricesDelete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('model') model: string
    ): Promise<void> {
        const row = await this.service.getOwned(user.userId, id)
        await this.modelPrices.providerDelete(row, model ?? '', user.userId)
    }

    private async ensureLocalUser(userId: string): Promise<string> {
        const email =
            (await this.bearerAuth.getUserEmail(userId)) ??
            `${userId.replace(/[^a-zA-Z0-9_.-]/g, '-')}@unknown.nca.local`
        await this.auth.upsertUser({ id: userId, email })
        return email
    }
}
