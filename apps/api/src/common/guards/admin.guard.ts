import {
    ForbiddenException,
    Inject,
    Injectable,
    type CanActivate,
    type ExecutionContext
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { users, type Database } from '@manyfold/db'
import type { FastifyRequest } from 'fastify'
import { DRIZZLE } from '@/db/tokens'
import type { AuthPrincipal } from '@/common/guards/auth.guard'

@Injectable()
export class AdminGuard implements CanActivate {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context
            .switchToHttp()
            .getRequest<FastifyRequest & { auth?: AuthPrincipal }>()
        if (!req.auth)
            throw new ForbiddenException('Admin guard requires AuthGuard')

        const [row] = await this.db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, req.auth.userId))
            .limit(1)
        if (!row || row.role !== 'admin')
            throw new ForbiddenException('Admin role required')
        return true
    }
}
