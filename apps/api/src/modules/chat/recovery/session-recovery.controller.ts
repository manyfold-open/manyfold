import {
    agentSessionListLimits,
    type AgentSessionListBody,
    type AgentSessionListResponse,
    type RuntimeSessionRebuildParsedResponse,
    type RuntimeSessionRecoverRawResponse,
    type RuntimeSessionRestoreResponse,
    type RuntimeSessionSyncResponse,
    type RuntimeSessionViewResponse
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

interface RuntimeSessionSyncBody {
    sessionId?: string
}

const clampLocalLimit = (value: unknown): number => {
    const requested =
        typeof value === 'number' && Number.isFinite(value)
            ? Math.floor(value)
            : agentSessionListLimits.firstPage
    return Math.min(Math.max(requested, 1), agentSessionListLimits.maxLocal)
}

@Controller('agents/:agentId/runtime-sessions')
@UseGuards(AuthGuard)
export class RuntimeSessionController {
    constructor(private readonly recovery: SessionRecoveryService) {}

    @Post('list')
    @HttpCode(200)
    async list(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: AgentSessionListBody | undefined
    ): Promise<AgentSessionListResponse> {
        return this.recovery.listAgentSessions(user.userId, agentId, {
            local: body?.local === 'skip' ? 'skip' : 'scan',
            localLimit: clampLocalLimit(body?.localLimit)
        })
    }

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

    @Post('sync')
    @HttpCode(200)
    async sync(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() body: RuntimeSessionSyncBody | undefined
    ): Promise<RuntimeSessionSyncResponse> {
        return this.recovery.syncRuntimeSessionIntoCloud(
            user.userId,
            agentId,
            body?.sessionId?.trim() || ''
        )
    }
}
