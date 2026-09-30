import type {
    AgentRuntimeSummary,
    SandboxServiceSummary,
    SandboxStopResponse,
    SandboxSummary,
    SandboxTaskSummary
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
import { SandboxesService } from './sandboxes.service'
import {
    CliUpgradeDto,
    CreateSandboxDto,
    InstallSandboxFrameworkDto,
    DetectSandboxFrameworksDto,
    RenameSandboxDto,
    SetSandboxKeepAwakeDto,
    SetSandboxTerminalDto,
    SetSandboxTerminalModelCredentialsDto
} from './dto/sandbox.dto'

@Controller('sandboxes')
@UseGuards(AuthGuard)
export class SandboxesController {
    constructor(private readonly sandboxes: SandboxesService) {}

    @Get()
    @RequireApiTokenScope('sandboxes:read')
    async list(@CurrentUser() user: AuthPrincipal): Promise<SandboxSummary[]> {
        return this.sandboxes.list(user.userId)
    }

    @Get(':id')
    @RequireApiTokenScope('sandboxes:read')
    async get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.get(user.userId, id)
    }

    @Post()
    @RequireApiTokenScope('sandboxes:edit')
    async create(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: CreateSandboxDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.create(user.userId, body)
    }

    @Post(':id/retry')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:edit')
    async retry(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.retry(user.userId, id)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('sandboxes:edit')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.sandboxes.delete(user.userId, id)
    }

    @Patch(':id/terminal')
    @RequireApiTokenScope('sandboxes:edit')
    async setTerminal(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetSandboxTerminalDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.setTerminal(user.userId, id, body)
    }

    // The host's keep-awake switch (ADR-0037 R7): keeps the machine running.
    @Patch(':id/keep-awake')
    @RequireApiTokenScope('sandboxes:edit')
    async setKeepAwake(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetSandboxKeepAwakeDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.setKeepAwake(user.userId, id, !!body.enabled)
    }

    @Patch(':id/terminal-model-credentials')
    @RequireApiTokenScope('sandboxes:edit')
    async setTerminalModelCredentials(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetSandboxTerminalModelCredentialsDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.setTerminalModelCredentials(user.userId, id, body)
    }

    @Patch(':id/name')
    @RequireApiTokenScope('sandboxes:edit')
    async rename(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: RenameSandboxDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.rename(user.userId, id, body.name)
    }

    // What the sandbox has. Without `probe` this reads the inventory its
    // daemon last reported and costs nothing; with it, the sandbox is probed
    // now through its daemon, which wakes it.
    @Post(':id/detect-frameworks')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:read')
    async detectFrameworks(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body?: DetectSandboxFrameworksDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.detectFrameworks(user.userId, id, false, {
            probe: body?.probe === true
        })
    }

    @Post(':id/refresh-status')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:read')
    async refreshStatus(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.refreshStatus(user.userId, id)
    }

    @Post(':id/cli/upgrade')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:edit')
    async upgradeCli(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body?: CliUpgradeDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.upgradeCli(user.userId, id, body?.targetVersion)
    }

    // Install or upgrade herdr inside the sandbox (ADR-0031).
    @Post(':id/herdr/upgrade')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:edit')
    async upgradeHerdr(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.upgradeHerdr(user.userId, id)
    }

    // Install (or move to a version of) a coding CLI on a sandbox that has no
    // runtime for it yet — the create form's Install / Upgrade before the agent
    // exists. Runs in the sandbox and may take a minute.
    @Post(':id/frameworks/:framework/install')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:edit')
    async installFramework(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('framework') framework: string,
        @Body() body?: InstallSandboxFrameworkDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.installFramework(
            user.userId,
            id,
            framework,
            body?.targetVersion
        )
    }

    // Bring a framework up on this sandbox with no agent for it yet: a coding
    // CLI gets its runtime row (so accounts can be added before any agent
    // exists); a service framework is installed and started. The first agent
    // then joins the runtime the way any later one would. Idempotent: an
    // existing live runtime for the framework is returned as is.
    @Post(':id/frameworks/:framework/runtime')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:edit')
    async prepareRuntime(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('framework') framework: string
    ): Promise<AgentRuntimeSummary> {
        return this.sandboxes.prepareRuntime(user.userId, id, framework)
    }

    @Get(':id/services')
    @RequireApiTokenScope('sandboxes:read')
    async listServices(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxServiceSummary[]> {
        return this.sandboxes.listServices(user.userId, id)
    }

    @Delete(':id/services/:name')
    @HttpCode(204)
    @RequireApiTokenScope('sandboxes:edit')
    async deleteService(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<void> {
        await this.sandboxes.deleteService(user.userId, id, name)
    }

    @Get(':id/tasks')
    @RequireApiTokenScope('sandboxes:read')
    async listTasks(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxTaskSummary[]> {
        return this.sandboxes.listTasks(user.userId, id)
    }

    @Delete(':id/tasks/:name')
    @HttpCode(204)
    @RequireApiTokenScope('sandboxes:edit')
    async deleteTask(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<void> {
        await this.sandboxes.deleteTask(user.userId, id, name)
    }

    @Post(':id/stop')
    @HttpCode(200)
    @RequireApiTokenScope('sandboxes:edit')
    async stop(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxStopResponse> {
        return this.sandboxes.stop(user.userId, id)
    }
}
