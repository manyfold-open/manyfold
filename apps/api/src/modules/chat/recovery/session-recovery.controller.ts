import type {
    RuntimeSessionRebuildParsedResponse,
    RuntimeSessionRecoverRawResponse,
    RuntimeSessionRestoreResponse,
    RuntimeSessionViewResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { SessionRecoveryService } from './session-recovery.service'

interface RecoveryBody {
    sessionRef?: string
}

interface RuntimeSessionViewBody {
    sessionId?: string
    sessionRef?: string
    includeRaw?: boolean
}

interface RuntimeSessionRecoverRawBody {
    sessionId?: string
    sessionRef?: string
}

interface RuntimeSessionRebuildParsedBody {
    sessionId?: string
    sessionRef?: string
}

@Controller('agents/:agentId/runtime-sessions')
@UseGuards(AuthGuard)
export class RuntimeSessionController {
    constructor(private readonly recovery: SessionRecoveryService) {}

    @Post('view')
    @HttpCode(200)
    async view(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: RuntimeSessionViewBody | undefined
    ): Promise<RuntimeSessionViewResponse> {
        return this.recovery.viewRuntimeSession(
            user.userId,
            agentId,
            body?.sessionId?.trim() || undefined,
            body?.sessionRef?.trim() || undefined,
            body?.includeRaw === true
        )
    }

    @Post('recover-raw')
    @HttpCode(200)
    async recoverRaw(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: RuntimeSessionRecoverRawBody | undefined
    ): Promise<RuntimeSessionRecoverRawResponse> {
        return this.recovery.recoverRuntimeSessionRawSources(
            user.userId,
            agentId,
            body?.sessionId?.trim() || '',
            body?.sessionRef?.trim() || undefined
        )
    }

    @Post('rebuild-parsed')
    @HttpCode(200)
    async rebuildParsed(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: RuntimeSessionRebuildParsedBody | undefined
    ): Promise<RuntimeSessionRebuildParsedResponse> {
        return this.recovery.rebuildRuntimeSessionParsedMessages(
            user.userId,
            agentId,
            body?.sessionId?.trim() || '',
            body?.sessionRef?.trim() || undefined
        )
    }

    @Post('restore')
    @HttpCode(201)
    async restore(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: RecoveryBody | undefined
    ): Promise<RuntimeSessionRestoreResponse> {
        return this.recovery.restoreRuntimeSession(
            user.userId,
            agentId,
            body?.sessionRef?.trim() || ''
        )
    }
}
