import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import {
    DaemonTokenService,
    type DaemonAuthContext
} from './daemon-token.service'

declare module 'fastify' {
    interface FastifyRequest {
        daemonAuth?: DaemonAuthContext
    }
}

@Injectable()
export class DaemonAuthGuard implements CanActivate {
    constructor(private readonly tokens: DaemonTokenService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<FastifyRequest>()
        const header = req.headers['authorization']
        const token = extractBearer(header)
        if (!token) throw new UnauthorizedException('missing daemon token')
        const auth = await this.tokens.verify(token)
        req.daemonAuth = auth
        return true
    }
}

const extractBearer = (
    header: string | string[] | undefined
): string | null => {
    if (!header) return null
    const value = Array.isArray(header) ? header[0] : header
    if (!value.startsWith('Bearer ')) return null
    return value.slice('Bearer '.length).trim() || null
}
