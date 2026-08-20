import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { DaemonAuthContext } from './daemon-token.service'

export const CurrentDaemon = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): DaemonAuthContext => {
        const req = ctx.switchToHttp().getRequest<FastifyRequest>()
        if (!req.daemonAuth)
            throw new Error('CurrentDaemon used without DaemonAuthGuard')
        return req.daemonAuth
    }
)
