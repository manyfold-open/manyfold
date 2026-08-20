import { Body, Controller, Post, Req, Res } from '@nestjs/common'
import { RouteConfig } from '@nestjs/platform-fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'

// base64 file content rides in the JSON body; raise the per-route limit above
// Fastify's ~1 MB default. Other JSON routes keep the small default.
const CHAT_COMPLETIONS_BODY_LIMIT = 32 * 1024 * 1024
import { ApiQuotaService } from '@/common/api-quota/api-quota.service'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { AllowBoundTokenWithoutSubject } from '@/common/decorators/subject-agent.decorator'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import type { AuthPrincipal } from '@/modules/auth/auth-principal'
import { authenticateOpenAiRequest } from './openai-auth'
import {
    OpenAiChatCompletionsService,
    OpenAiCompatError,
    openAiDeltaForEvent,
    openAiErrorBody,
    toOpenAiCompatError
} from './openai-chat-completions.service'

@Controller('v1/chat')
export class OpenAiChatCompletionsController {
    constructor(
        private readonly auth: BearerAuthService,
        private readonly completions: OpenAiChatCompletionsService,
        private readonly apiQuota: ApiQuotaService
    ) {}

    @Post('completions')
    @RouteConfig({ bodyLimit: CHAT_COMPLETIONS_BODY_LIMIT })
    @RequireApiTokenScope('chat.completions')
    @AllowBoundTokenWithoutSubject(
        'OpenAI-compatible chat.completions; binds to model not agent'
    )
    async create(
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply,
        @Body() body: unknown
    ): Promise<void> {
        try {
            const user = await authenticateOpenAiRequest(this.auth, req)
            await this.apiQuota.assertAndIncrement(user.userId)
            const turn = await this.completions.prepare(user, body)
            if (turn.stream) {
                await this.streamCompletion(user, turn, req, res)
                return
            }
            const state = this.completions.createTurnState()
            const sent = await this.completions.startTurn(
                user,
                turn,
                state.observe
            )
            const outcome = await state.done
            if (outcome.error) throw outcome.error
            res.header('x-session-id', turn.sessionId)
                .status(200)
                .send(
                    this.completions.buildFinalResponse({
                        turn,
                        assistantMessageId: sent.assistantMessageId,
                        text: state.text(),
                        reasoning: state.reasoning(),
                        replaced: state.replacement() !== null,
                        usage: state.usage()
                    })
                )
        } catch (err) {
            const error = toOpenAiCompatError(err)
            res.status(error.status).send(openAiErrorBody(error))
        }
    }

    private async streamCompletion(
        user: AuthPrincipal,
        turn: Awaited<ReturnType<OpenAiChatCompletionsService['prepare']>>,
        req: FastifyRequest,
        res: FastifyReply
    ): Promise<void> {
        res.hijack()
        res.raw.socket?.setNoDelay(true)
        res.raw.writeHead(200, {
            ...corsHeadersForOrigin(req.headers),
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-session-id': turn.sessionId
        })

        const state = this.completions.createTurnState()
        const writeData = (payload: unknown): void => {
            res.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
        }
        writeData(this.completions.buildRoleChunk(turn))

        try {
            await this.completions.startTurn(user, turn, (event) => {
                state.observe(event)
                const delta = openAiDeltaForEvent(event)
                if (delta?.text)
                    writeData(this.completions.buildDeltaChunk(turn, delta))
            })
            const outcome = await state.done
            if (outcome.error) {
                writeData(openAiErrorBody(outcome.error))
            } else {
                // Deltas already on the wire cannot be retracted, so the
                // superseding answer goes out once, at the end, and the finish
                // reason tells the caller the earlier text was moderated away.
                const replacement = state.replacement()
                if (replacement)
                    writeData(
                        this.completions.buildDeltaChunk(turn, {
                            channel: 'content',
                            text: replacement
                        })
                    )
                writeData(
                    this.completions.buildDoneChunk(turn, replacement !== null)
                )
                if (turn.includeUsage)
                    writeData(
                        this.completions.buildUsageChunk(turn, state.usage())
                    )
            }
            res.raw.write('data: [DONE]\n\n')
            res.raw.end()
        } catch (err) {
            const error =
                err instanceof OpenAiCompatError
                    ? err
                    : toOpenAiCompatError(err)
            writeData(openAiErrorBody(error))
            res.raw.write('data: [DONE]\n\n')
            res.raw.end()
        }
    }
}
