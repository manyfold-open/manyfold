import {
    Body,
    Controller,
    HttpException,
    Param,
    Post,
    Req,
    Res
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { trace } from '@opentelemetry/api'
import {
    A2aErrorCode,
    type A2aStreamEvent,
    type MessageSendParams
} from '@manyfold/a2a'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { ApiQuotaService } from '@/common/api-quota/api-quota.service'
import { ApiTokenService } from '@/modules/auth/api-token.service'
import { A2aService, type A2aAuthContext, type A2aStreamEmit } from './a2a.service'
import { A2aRateLimitService, clientKey } from './a2a-rate-limit.service'
import { A2aTicketService } from './a2a-ticket.service'
import { A2aHttpError, authenticateA2aRequest, toJsonRpcError } from './a2a-http'

const RPC_LIMIT_PER_MIN = 120

interface RpcRequest {
    id: string | number | null
    method: string
    params: unknown
}

@Controller('a2a')
export class A2aRpcController {
    constructor(
        private readonly a2a: A2aService,
        private readonly bearerAuth: BearerAuthService,
        private readonly apiQuota: ApiQuotaService,
        private readonly rateLimit: A2aRateLimitService,
        private readonly tokens: ApiTokenService,
        private readonly tickets: A2aTicketService
    ) {}

    @Post('agents/:agentId/rpc')
    async rpc(
        @Param('agentId') agentId: string,
        @Body() body: unknown,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        let ctx: A2aAuthContext
        try {
            this.rateLimit.consume({
                key: `a2a:rpc:${clientKey(req)}:${agentId}`,
                limit: RPC_LIMIT_PER_MIN,
                windowMs: 60_000
            })
            ctx = await authenticateA2aRequest(
                this.bearerAuth,
                req,
                agentId,
                this.tickets,
                this.tokens
            )
            const exposure = await this.a2a.getExposure(agentId)
            if (!exposure?.enabled) throw new A2aHttpError(404, 'not found')
            // Real-time revoke: an internal caller's grant must still be active
            // on every call, so a revoked grant cuts off existing ephemerals at
            // once rather than at their TTL.
            if (
                ctx.callerAgentId &&
                !(await this.tokens.isActiveA2aGrant(
                    ctx.callerAgentId,
                    ctx.targetAgentId
                ))
            )
                throw new A2aHttpError(403, 'a2a grant revoked or expired')
            await this.apiQuota.assertAndIncrement(ctx.userId)
        } catch (err) {
            return this.sendHttpError(res, err)
        }

        const rpc = this.parseRpc(body)
        if (!rpc) {
            res.status(200).send({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: A2aErrorCode.invalidRequest,
                    message: 'invalid JSON-RPC request'
                }
            })
            return
        }

        const span = trace.getActiveSpan()
        try {
            switch (rpc.method) {
                case 'message/send': {
                    const task = await this.a2a.sendMessage(
                        ctx,
                        rpc.params as MessageSendParams
                    )
                    span?.setAttribute('nca.a2a_task_id', task.id)
                    this.sendResult(res, rpc, task)
                    return
                }
                case 'message/stream':
                    await this.streamSse(res, rpc, (emit) =>
                        this.a2a.sendMessage(
                            ctx,
                            rpc.params as MessageSendParams,
                            emit
                        )
                    )
                    return
                case 'tasks/get': {
                    const task = await this.a2a.getTask(ctx, this.taskId(rpc))
                    this.sendResult(res, rpc, task)
                    return
                }
                case 'tasks/cancel': {
                    const task = await this.a2a.cancelTask(ctx, this.taskId(rpc))
                    this.sendResult(res, rpc, task)
                    return
                }
                case 'tasks/list': {
                    const params = (rpc.params ?? {}) as {
                        limit?: number
                        cursor?: string
                        contextId?: string
                    }
                    const result = await this.a2a.listTasks(ctx, params)
                    this.sendResult(res, rpc, result)
                    return
                }
                case 'tasks/resubscribe':
                    await this.streamSse(res, rpc, (emit) =>
                        this.a2a.resubscribe(ctx, this.taskId(rpc), emit)
                    )
                    return
                default:
                    res.status(200).send({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        error: {
                            code: A2aErrorCode.methodNotFound,
                            message: `method not found: ${rpc.method}`
                        }
                    })
            }
        } catch (err) {
            res.status(200).send({
                jsonrpc: '2.0',
                id: rpc.id,
                error: toJsonRpcError(err)
            })
        }
    }

    private taskId(rpc: RpcRequest): string {
        const params = (rpc.params ?? {}) as { id?: string }
        return params.id ?? ''
    }

    private sendResult(res: FastifyReply, rpc: RpcRequest, result: unknown): void {
        res.status(200).send({ jsonrpc: '2.0', id: rpc.id, result })
    }

    private async streamSse(
        res: FastifyReply,
        rpc: RpcRequest,
        run: (emit: A2aStreamEmit) => Promise<unknown>
    ): Promise<void> {
        res.hijack()
        res.raw.socket?.setNoDelay(true)
        res.raw.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        })
        const emit = (event: A2aStreamEvent): void => {
            res.raw.write(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: event })}\n\n`
            )
        }
        try {
            await run(emit)
        } catch (err) {
            res.raw.write(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: toJsonRpcError(err) })}\n\n`
            )
        }
        res.raw.end()
    }

    private parseRpc(body: unknown): RpcRequest | null {
        if (!body || typeof body !== 'object') return null
        const b = body as Record<string, unknown>
        if (b.jsonrpc !== '2.0' || typeof b.method !== 'string') return null
        const id = b.id
        return {
            id:
                typeof id === 'string' || typeof id === 'number'
                    ? id
                    : null,
            method: b.method,
            params: b.params
        }
    }

    private sendHttpError(res: FastifyReply, err: unknown): void {
        if (err instanceof A2aHttpError) {
            res.status(err.status).send({ error: err.message })
            return
        }
        if (err instanceof HttpException) {
            res.status(err.getStatus()).send({ error: err.message })
            return
        }
        res.status(500).send({ error: 'internal error' })
    }
}
