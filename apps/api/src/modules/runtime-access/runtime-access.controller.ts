import type {
    RuntimeAccessSummary,
    SandboxUsageBreakdown
} from '@manyfold/shared'
import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AuthService } from '@/modules/auth/auth.service'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { RuntimeAccessService } from './runtime-access.service'

@Controller('me')
@UseGuards(AuthGuard)
export class RuntimeAccessController {
    constructor(
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly auth: AuthService,
        private readonly bearerAuth: BearerAuthService
    ) {}

    @Get('runtime-access')
    async summary(
        @CurrentUser() user: AuthPrincipal
    ): Promise<RuntimeAccessSummary> {
        await this.ensureLocalUser(user.userId)
        return this.runtimeAccess.summary(user.userId)
    }

    @Get('runtime-access/sandbox-usage')
    async sandboxUsage(
        @CurrentUser() user: AuthPrincipal
    ): Promise<SandboxUsageBreakdown> {
        await this.ensureLocalUser(user.userId)
        return this.runtimeAccess.sandboxUsage(user.userId)
    }

    private async ensureLocalUser(userId: string): Promise<void> {
        const email =
            (await this.bearerAuth.getUserEmail(userId)) ??
            `${userId.replace(/[^a-zA-Z0-9_.-]/g, '-')}@unknown.nca.local`
        await this.auth.upsertUser({ id: userId, email })
    }
}
