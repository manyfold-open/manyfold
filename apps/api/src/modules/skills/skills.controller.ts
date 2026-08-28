import type {
    AgentSkillsGroup,
    DiscoverableSkillSummary,
    DiscoverableSkillsPage,
    InstallSkillBatchResult,
    InstalledSkillSummary,
    SkillReadmeResponse,
    SkillRepoSummary
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Optional,
    Param,
    Patch,
    Post,
    Query,
    UseGuards
} from '@nestjs/common'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    parseCatalogLimit,
    parseCatalogSort
} from '@/common/catalog-query'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    AllowBoundTokenWithoutSubject,
    DenyBoundToken,
    SubjectAgentFromBody,
    SubjectAgentFromQuery,
    SubjectAgentFromResource
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import {
    CreateSkillRepoDto,
    InstallSkillBatchDto,
    InstallSkillDto,
    UpdateSkillRepoDto,
    UpdateUserSkillDto
} from './dto/skills.dto'
import { SkillsService } from './skills.service'

@Controller('skills')
@UseGuards(AuthGuard)
export class SkillsController {
    constructor(
        private readonly service: SkillsService,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    @Get('installed')
    @RequireApiTokenScope('skills:read')
    @SubjectAgentFromQuery('agentId')
    installed(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string,
        @Query('includeRuntime') includeRuntime?: string
    ): Promise<AgentSkillsGroup[]> {
        const effective = agentId ?? boundAgentIdFromUser(user)
        return this.service.installed(user.userId, effective, {
            includeRuntime: includeRuntime === 'true'
        })
    }

    // Legacy shape (bare array) is preserved for released CLI binaries that
    // call this endpoint without any of the new pagination/filter params.
    @Get('discover')
    @RequireApiTokenScope('skills:read')
    @SubjectAgentFromQuery('agentId')
    discover(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string,
        @Query('q') q?: string,
        @Query('repoId') repoId?: string,
        @Query('category') category?: string,
        @Query('tag') tag?: string,
        @Query('sort') sort?: string,
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string
    ): Promise<DiscoverableSkillSummary[] | DiscoverableSkillsPage> {
        const base = {
            userId: user.userId,
            agentId: agentId ?? boundAgentIdFromUser(user),
            q,
            repoId
        }
        const paged =
            category !== undefined ||
            tag !== undefined ||
            sort !== undefined ||
            cursor !== undefined ||
            limit !== undefined
        // The shape split is the removal gate for the bare-array branch: it
        // can only go once this event reports zero shape=bare over a window
        // covering the released binaries still calling without params
        // (legacy-inventory §4.7).
        this.telemetry?.event('skills.discover.shape', {
            shape: paged ? 'paged' : 'bare'
        })
        if (!paged) return this.service.discover(base)
        return this.service.discoverPage({
            ...base,
            categoryId: category,
            tag,
            sort: parseCatalogSort(sort),
            cursor,
            limit: parseCatalogLimit(limit)
        })
    }

    @Get('discover/:skillId')
    @RequireApiTokenScope('skills:read')
    @SubjectAgentFromQuery('agentId')
    discoverDetail(
        @CurrentUser() user: AuthPrincipal,
        @Param('skillId') skillId: string,
        @Query('agentId') agentId?: string
    ): Promise<DiscoverableSkillSummary> {
        return this.service.detail({
            userId: user.userId,
            skillId,
            agentId: agentId ?? boundAgentIdFromUser(user)
        })
    }

    @Get('discover/:skillId/readme')
    @RequireApiTokenScope('skills:read')
    @AllowBoundTokenWithoutSubject(
        'catalog readme is read-only content with no subject agent'
    )
    discoverReadme(
        @CurrentUser() user: AuthPrincipal,
        @Param('skillId') skillId: string
    ): Promise<SkillReadmeResponse> {
        return this.service.readme(user.userId, skillId)
    }

    @Post('discover/refresh')
    @HttpCode(200)
    @RequireApiTokenScope('skills:read')
    @SubjectAgentFromQuery('agentId')
    refreshDiscover(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string,
        @Query('q') q?: string,
        @Query('repoId') repoId?: string
    ): Promise<DiscoverableSkillSummary[]> {
        return this.service.refreshDiscover({
            userId: user.userId,
            agentId: agentId ?? boundAgentIdFromUser(user),
            q,
            repoId
        })
    }

    @Get('repos')
    repos(@CurrentUser() user: AuthPrincipal): Promise<SkillRepoSummary[]> {
        return this.service.repos(user.userId)
    }

    @Post('repos')
    @HttpCode(201)
    createRepo(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateSkillRepoDto
    ): Promise<SkillRepoSummary> {
        return this.service.createRepo(user.userId, dto)
    }

    @Patch('repos/:id')
    updateRepo(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateSkillRepoDto
    ): Promise<SkillRepoSummary> {
        return this.service.updateRepo(user.userId, id, dto)
    }

    @Delete('repos/:id')
    @HttpCode(204)
    async deleteRepo(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.service.deleteRepo(user.userId, id)
    }

    @Post('install')
    @HttpCode(201)
    @RequireApiTokenScope('skills:edit')
    @SubjectAgentFromBody('agentId')
    install(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: InstallSkillDto
    ): Promise<InstalledSkillSummary> {
        return this.service.install({
            userId: user.userId,
            skillId: dto.skillId,
            agentId: dto.agentId
        })
    }

    @Post('install/batch')
    @HttpCode(200)
    @RequireApiTokenScope('skills:edit')
    @DenyBoundToken()
    installBatch(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: InstallSkillBatchDto
    ): Promise<InstallSkillBatchResult> {
        return this.service.installBatch({
            userId: user.userId,
            skillId: dto.skillId,
            agentIds: dto.agentIds
        })
    }

    @Patch(':id')
    @RequireApiTokenScope('skills:edit')
    @SubjectAgentFromResource('userSkill', 'id')
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateUserSkillDto
    ): Promise<InstalledSkillSummary> {
        return this.service.update({
            userId: user.userId,
            userSkillId: id,
            enabled: dto.enabled
        })
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('skills:edit')
    @SubjectAgentFromResource('userSkill', 'id')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.service.delete(user.userId, id)
    }
}
