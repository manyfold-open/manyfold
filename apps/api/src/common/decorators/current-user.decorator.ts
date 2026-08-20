import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { AuthPrincipal } from '@/common/guards/auth.guard'

export const CurrentUser = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
        const req = ctx
            .switchToHttp()
            .getRequest<FastifyRequest & { auth?: AuthPrincipal }>()
        if (!req.auth) throw new Error('CurrentUser used without AuthGuard')
        return req.auth
    }
)
