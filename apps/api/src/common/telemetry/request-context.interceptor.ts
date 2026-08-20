import {
    Injectable,
    type CallHandler,
    type ExecutionContext,
    type NestInterceptor
} from '@nestjs/common'
import { trace } from '@opentelemetry/api'
import type { FastifyRequest } from 'fastify'
import type { Observable } from 'rxjs'
import type { AuthPrincipal } from '@/modules/auth/auth-principal'
import { setSentryRequestContext } from '@/sentry'

type ParamsBag = Record<string, string | undefined>

const tagSpan = (req: FastifyRequest & { auth?: AuthPrincipal }): void => {
    const params = (req.params ?? {}) as ParamsBag
    const attrs: Record<string, string> = {}

    if (req.auth?.userId) attrs['nca.user_id'] = req.auth.userId
    if (params.agentId) attrs['nca.agent_id'] = params.agentId
    if (params.sessionId) attrs['nca.session_id'] = params.sessionId
    if (params.runtimeId) attrs['nca.runtime_id'] = params.runtimeId
    if (params.messageId) attrs['nca.message_id'] = params.messageId

    const span = trace.getActiveSpan()
    if (span && Object.keys(attrs).length > 0) span.setAttributes(attrs)

    setSentryRequestContext(req.auth?.userId, attrs)
}

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
    intercept(
        context: ExecutionContext,
        next: CallHandler
    ): Observable<unknown> {
        if (context.getType() === 'http') {
            const req = context
                .switchToHttp()
                .getRequest<FastifyRequest & { auth?: AuthPrincipal }>()
            tagSpan(req)
        }
        return next.handle()
    }
}
