import type {
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
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { SandboxesService } from './sandboxes.service'
import {
    CliUpgradeDto,
    RenameSandboxDto,
    SetSandboxTerminalDto
} from './dto/sandbox.dto'

@Controller('admin/sandboxes')
@UseGuards(AuthGuard, AdminGuard)
export class AdminSandboxesController {
    constructor(private readonly sandboxes: SandboxesService) {}

    @Get()
    list(): Promise<SandboxSummary[]> {
        return this.sandboxes.list('', true)
    }

    @Get(':id')
    get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.get(user.userId, id, true)
    }

    @Delete(':id')
    @HttpCode(204)
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.sandboxes.delete(user.userId, id, true)
    }

    @Patch(':id/terminal')
    setTerminal(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: SetSandboxTerminalDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.setTerminal(user.userId, id, body, true)
    }

    @Patch(':id/name')
    rename(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: RenameSandboxDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.rename(user.userId, id, body.name, true)
    }

    @Post(':id/detect-frameworks')
    @HttpCode(200)
    detectFrameworks(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.detectFrameworks(user.userId, id, true)
    }

    @Post(':id/refresh-status')
    @HttpCode(200)
    refreshStatus(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxSummary> {
        return this.sandboxes.refreshStatus(user.userId, id, true)
    }

    @Post(':id/cli/upgrade')
    @HttpCode(200)
    upgradeCli(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body?: CliUpgradeDto
    ): Promise<SandboxSummary> {
        return this.sandboxes.upgradeCli(user.userId, id, body?.targetVersion, true)
    }

    @Get(':id/services')
    listServices(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxServiceSummary[]> {
        return this.sandboxes.listServices(user.userId, id, true)
    }

    @Delete(':id/services/:name')
    @HttpCode(204)
    async deleteService(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<void> {
        await this.sandboxes.deleteService(user.userId, id, name, true)
    }

    @Get(':id/tasks')
    listTasks(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxTaskSummary[]> {
        return this.sandboxes.listTasks(user.userId, id, true)
    }

    @Delete(':id/tasks/:name')
    @HttpCode(204)
    async deleteTask(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<void> {
        await this.sandboxes.deleteTask(user.userId, id, name, true)
    }

    @Post(':id/stop')
    @HttpCode(200)
    async stop(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<SandboxStopResponse> {
        return this.sandboxes.stop(user.userId, id, true)
    }
}
