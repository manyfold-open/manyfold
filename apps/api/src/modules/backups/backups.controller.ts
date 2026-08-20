import type {
    AgentBackupRestoreSummary,
    AgentBackupSummary,
    CreateAgentBackupResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    SubjectAgentFromPath,
    SubjectAgentFromQuery,
    SubjectAgentFromResource
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import { BackupsService } from '@/modules/backups/backups.service'
import { RestoreBackupDto } from '@/modules/backups/dto/restore-backup.dto'

@Controller()
@UseGuards(AuthGuard)
export class BackupsController {
    constructor(private readonly backups: BackupsService) {}

    @Get('backups')
    @RequireApiTokenScope('backups:read')
    @SubjectAgentFromQuery('agentId')
    list(
        @CurrentUser() user: AuthPrincipal,
        @Query('agentId') agentId?: string
    ): Promise<AgentBackupSummary[]> {
        return this.backups.listBackups({
            callerUserId: user.userId,
            isAdmin: false,
            agentId: agentId ?? boundAgentIdFromUser(user)
        })
    }

    @Post('agents/:id/backups')
    @HttpCode(202)
    @RequireApiTokenScope('backups:edit')
    @SubjectAgentFromPath('id')
    create(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string
    ): Promise<CreateAgentBackupResponse> {
        return this.backups.createBackup(user.userId, agentId, false)
    }

    @Delete('backups/:backupId')
    @HttpCode(204)
    @RequireApiTokenScope('backups:edit')
    @SubjectAgentFromResource('backup', 'backupId')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('backupId') backupId: string
    ): Promise<void> {
        await this.backups.deleteBackup(user.userId, backupId, false)
    }

    @Post('agents/:id/restores')
    @HttpCode(202)
    @RequireApiTokenScope('backups:edit')
    @SubjectAgentFromPath('id')
    restore(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: RestoreBackupDto
    ): Promise<AgentBackupRestoreSummary> {
        return this.backups.restoreToAgent(
            user.userId,
            agentId,
            body.backupId,
            false
        )
    }

    @Get('restores/:restoreId')
    @RequireApiTokenScope('backups:read')
    @SubjectAgentFromResource('backupRestore', 'restoreId')
    getRestore(
        @CurrentUser() user: AuthPrincipal,
        @Param('restoreId') restoreId: string
    ): Promise<AgentBackupRestoreSummary> {
        return this.backups.getRestore(user.userId, restoreId, false)
    }
}

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminBackupsController {
    constructor(private readonly backups: BackupsService) {}

    @Get('backups')
    list(
        @CurrentUser() user: AuthPrincipal,
        @Query('userId') userId?: string,
        @Query('agentId') agentId?: string
    ): Promise<AgentBackupSummary[]> {
        return this.backups.listBackups({
            callerUserId: user.userId,
            isAdmin: true,
            userId,
            agentId
        })
    }

    @Post('agents/:id/backups')
    @HttpCode(202)
    create(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string
    ): Promise<CreateAgentBackupResponse> {
        return this.backups.createBackup(user.userId, agentId, true)
    }

    @Delete('backups/:backupId')
    @HttpCode(204)
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('backupId') backupId: string
    ): Promise<void> {
        await this.backups.deleteBackup(user.userId, backupId, true)
    }

    @Post('agents/:id/restores')
    @HttpCode(202)
    restore(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Body() body: RestoreBackupDto
    ): Promise<AgentBackupRestoreSummary> {
        return this.backups.restoreToAgent(
            user.userId,
            agentId,
            body.backupId,
            true
        )
    }

    @Get('restores/:restoreId')
    getRestore(
        @CurrentUser() user: AuthPrincipal,
        @Param('restoreId') restoreId: string
    ): Promise<AgentBackupRestoreSummary> {
        return this.backups.getRestore(user.userId, restoreId, true)
    }
}
