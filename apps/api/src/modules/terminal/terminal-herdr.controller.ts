import type {
    SessionHerdrFocusResponse,
    SessionHerdrOpenRequest,
    SessionHerdrOpenResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromPath } from '@/common/decorators/subject-agent.decorator'
import { TerminalHerdrService } from '@/modules/terminal/terminal-herdr.service'

const TITLE_MAX_LENGTH = 120

// Shape only: the title is a label, and the service falls back to the
// session's own when it is missing.
export const parseSessionHerdrOpenRequest = (
    raw: unknown
): SessionHerdrOpenRequest => {
    const body =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {}
    if (body.title === undefined || body.title === null) return {}
    if (typeof body.title !== 'string' || body.title.length > TITLE_MAX_LENGTH)
        throw new BadRequestException({
            code: 'herdr_open_invalid',
            message: `title must be a string of at most ${TITLE_MAX_LENGTH} characters`
        })
    return { title: body.title }
}

// The chat view's herdr side of session ownership (ADR-0031): hand the
// session to herdr on the agent's machine, and raise it there again.
@Controller('agents/:agentId/sessions/:sessionId/herdr')
@UseGuards(AuthGuard)
export class TerminalHerdrController {
    constructor(private readonly herdr: TerminalHerdrService) {}

    @Post('open')
    @HttpCode(200)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async open(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Body() raw: unknown
    ): Promise<SessionHerdrOpenResponse> {
        return this.herdr.open(
            user.userId,
            agentId,
            sessionId,
            parseSessionHerdrOpenRequest(raw)
        )
    }

    @Post('focus')
    @HttpCode(200)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async focus(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<SessionHerdrFocusResponse> {
        return this.herdr.focus(user.userId, agentId, sessionId)
    }
}
