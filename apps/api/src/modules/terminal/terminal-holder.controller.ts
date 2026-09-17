import type {
    SessionHolderReleaseResponse,
    SessionImportAbandonResponse,
    SessionImportRetryResponse
} from '@manyfold/shared'
import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromPath } from '@/common/decorators/subject-agent.decorator'
import { SessionRecoveryService } from '@/modules/chat/recovery/session-recovery.service'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'

// The chat view's side of session ownership (ADR-0029 §7): give a held
// session back to the web from any tab, and settle or abandon the import a
// release left pending.
@Controller('agents/:agentId/sessions/:sessionId')
@UseGuards(AuthGuard)
export class TerminalHolderController {
    constructor(
        private readonly holder: TerminalHolderService,
        private readonly recovery: SessionRecoveryService
    ) {}

    @Post('holder/release')
    @HttpCode(200)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async release(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<SessionHolderReleaseResponse> {
        return this.holder.releaseByUser(user.userId, agentId, sessionId)
    }

    @Post('import/retry')
    @HttpCode(200)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async retryImport(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<SessionImportRetryResponse> {
        return this.recovery.settlePendingImport(
            user.userId,
            agentId,
            sessionId
        )
    }

    @Post('import/abandon')
    @HttpCode(200)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async abandonImport(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<SessionImportAbandonResponse> {
        return this.recovery.abandonPendingImport(
            user.userId,
            agentId,
            sessionId,
            'user'
        )
    }
}
