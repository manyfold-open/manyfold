import type { AgentRuntimeSummary, PodHostSummary } from '@manyfold/shared'
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
import { PodHostsService } from './pod-hosts.service'
import {
    CreatePodHostDto,
    PodHostCliUpgradeDto,
    RenamePodHostDto
} from './dto/pod-host.dto'

// Cloud computers: Kubernetes pod hosts (ADR-0035). A host is runtime
// infrastructure, so it rides the agent-runtimes token scopes.
@Controller('pod-hosts')
@UseGuards(AuthGuard)
export class PodHostsController {
    constructor(private readonly podHosts: PodHostsService) {}

    @Get()
    @RequireApiTokenScope('agent-runtimes:read')
    async list(@CurrentUser() user: AuthPrincipal): Promise<PodHostSummary[]> {
        return this.podHosts.list(user.userId)
    }

    @Get(':id')
    @RequireApiTokenScope('agent-runtimes:read')
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<PodHostSummary> {
        return this.podHosts.get(user.userId, id)
    }

    // Returns as soon as the host is recorded; it becomes ready (or failed)
    // in the background, which GET reports.
    @Post()
    @RequireApiTokenScope('agent-runtimes:edit')
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: CreatePodHostDto
    ): Promise<PodHostSummary> {
        return this.podHosts.create(user.userId, body)
    }

    @Patch(':id/name')
    @RequireApiTokenScope('agent-runtimes:edit')
    async rename(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: RenamePodHostDto
    ): Promise<PodHostSummary> {
        return this.podHosts.rename(user.userId, id, body.name)
    }

    // Deletes the host with every framework runtime and agent on it, and its
    // home volume.
    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('agent-runtimes:edit')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.podHosts.delete(user.userId, id)
    }

    // Installs a framework on the host with no agent for it yet: the runtime
    // the create form's host list needs (and the first agent later joins).
    @Post(':id/frameworks/:framework/runtime')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    async prepareRuntime(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('framework') framework: string
    ): Promise<AgentRuntimeSummary> {
        return this.podHosts.prepareRuntime(user.userId, id, framework)
    }

    @Post(':id/cli/upgrade')
    @HttpCode(200)
    @RequireApiTokenScope('agent-runtimes:edit')
    async upgradeCli(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body?: PodHostCliUpgradeDto
    ): Promise<PodHostSummary> {
        return this.podHosts.upgradeCli(user.userId, id, body?.targetVersion)
    }
}
