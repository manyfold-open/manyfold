import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { principalAgentId } from '@/modules/auth/auth-principal'
import { authenticateOpenAiRequest } from './openai-auth'
import {
    OpenAiCompatError,
    openAiErrorBody,
    toOpenAiCompatError
} from './openai-chat-completions.service'
import { OpenAiConversationsService } from './openai-conversations.service'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

// Read-only sibling of /v1/chat/completions. WHY guard-free + self-auth: the
// chat.completions scope deliberately ALSO grants reads (api.full passes), so a
// caller's existing completions token reads its own conversation history; and,
// like completions, these handlers catch every error to keep the body
// OpenAI-shaped — AuthGuard + the global HttpExceptionFilter would emit a
// brand-shaped apiError instead. Reads are NOT metered against the Monthly API
// request quota (no ApiQuotaService dependency). See ADR-0005.
@Controller('v1/conversations')
export class OpenAiConversationsController {
    constructor(
        private readonly auth: BearerAuthService,
        private readonly conversations: OpenAiConversationsService
    ) {}

    @Get()
    async list(
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply,
        @Query('model') model?: string,
        @Query('limit') limit?: string,
        @Query('after') after?: string,
        @Query('order') order?: string
    ): Promise<void> {
        try {
            const user = await authenticateOpenAiRequest(this.auth, req)
            const boundAgentId = principalAgentId(user) ?? null
            const requestedModel = normalizeString(model)
            if (
                boundAgentId &&
                requestedModel &&
                requestedModel !== boundAgentId
            )
                throw new OpenAiCompatError(
                    403,
                    `token is bound to ${boundAgentId} and cannot read other agents`,
                    'invalid_request_error',
                    'permission_denied'
                )
            const envelope = await this.conversations.listConversations(
                user.userId,
                {
                    agentId: boundAgentId ?? requestedModel,
                    limit: parseLimit(limit),
                    after: normalizeString(after),
                    order: parseOrder(order)
                }
            )
            res.status(200).send(envelope)
        } catch (err) {
            const error = toOpenAiCompatError(err)
            res.status(error.status).send(openAiErrorBody(error))
        }
    }

    @Get(':session_id/messages')
    async listMessages(
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply,
        @Param('session_id') sessionId: string,
        @Query('limit') limit?: string,
        @Query('after') after?: string,
        @Query('order') order?: string
    ): Promise<void> {
        try {
            const user = await authenticateOpenAiRequest(this.auth, req)
            const envelope =
                await this.conversations.listConversationMessages(
                    user.userId,
                    sessionId,
                    {
                        boundAgentId: principalAgentId(user) ?? null,
                        limit: parseLimit(limit),
                        after: normalizeString(after),
                        order: parseOrder(order)
                    }
                )
            res.status(200).send(envelope)
        } catch (err) {
            const error = toOpenAiCompatError(err)
            res.status(error.status).send(openAiErrorBody(error))
        }
    }
}

const normalizeString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const parseLimit = (value: unknown): number => {
    const str = normalizeString(value)
    if (str === null) return DEFAULT_LIMIT
    const n = Number(str)
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT)
        throw new OpenAiCompatError(
            400,
            `limit must be an integer from 1 to ${MAX_LIMIT}`,
            'invalid_request_error',
            'invalid_limit'
        )
    return n
}

const parseOrder = (value: unknown): 'asc' | 'desc' => {
    const str = normalizeString(value)
    if (str === null) return 'desc'
    const lowered = str.toLowerCase()
    if (lowered !== 'asc' && lowered !== 'desc')
        throw new OpenAiCompatError(
            400,
            "order must be 'asc' or 'desc'",
            'invalid_request_error',
            'invalid_order'
        )
    return lowered
}