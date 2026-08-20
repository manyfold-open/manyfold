import type {
    AuthSessionResponse,
    AuthWhoamiResponse,
    ExperimentAssignments,
    PublicAuthConfig,
    UserRole
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Req,
    UseGuards
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AllowRuntimeSelf } from '@/common/decorators/allow-runtime-self.decorator'
import { AllowBoundTokenWithoutSubject } from '@/common/decorators/subject-agent.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AccountProfileService } from '@/modules/auth/account-profile.service'
import { AuthService } from '@/modules/auth/auth.service'
import { AuthSettingsService } from '@/modules/auth/auth-settings.service'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { PasswordService } from '@/modules/auth/password.service'
import { SessionService } from '@/modules/auth/session.service'
import { clientKey } from '@/modules/auth/cli-auth.controller'
import { normalizeEmail } from '@/modules/auth/linked-identities'
import { AuthSetupDto } from '@/modules/auth/dto/auth-settings.dto'
import {
    EXPERIMENT_ASSIGNMENT_PORT,
    type ExperimentAssignmentPort
} from '@/common/ports/experiment-assignment.ports'

interface AuthMeResponse {
    id: string
    email: string
    role: string
    displayName: string | null
    // Cache-buster for the avatar fetch; null = no custom avatar.
    avatarUpdatedAt: string | null
    experiments: ExperimentAssignments
}

@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly bearerAuth: BearerAuthService,
        private readonly authSettings: AuthSettingsService,
        private readonly passwords: PasswordService,
        private readonly profile: AccountProfileService,
        private readonly sessions: SessionService,
        @Inject(EXPERIMENT_ASSIGNMENT_PORT)
        private readonly experiments: ExperimentAssignmentPort
    ) {}

    @Get('config')
    config(): Promise<PublicAuthConfig> {
        return this.authSettings.getPublicConfig()
    }

    // First-run setup: persist the native provider config AND bootstrap the
    // first admin (email + password, email pre-verified) so a greenfield install
    // can sign in without email delivery configured yet. Returns a live session.
    @Post('setup')
    async setup(
        @Body() dto: AuthSetupDto,
        @Req() req: FastifyRequest
    ): Promise<AuthSessionResponse> {
        const adminEmail = normalizeEmail(dto.adminEmail)
        if (!adminEmail)
            throw new BadRequestException({
                code: 'auth.invalid_email',
                message: 'a valid adminEmail is required'
            })
        this.passwords.validatePolicy(dto.adminPassword)
        const initialAdminEmails = Array.from(
            new Set([...(dto.initialAdminEmails ?? []), adminEmail])
        )
        await this.authSettings.setup({ ...dto, initialAdminEmails })

        const user = await this.auth.upsertExternalIdentity({
            provider: 'email',
            subject: adminEmail,
            email: adminEmail
        })
        await this.passwords.set(user.id, dto.adminPassword)
        const session = await this.sessions.mint({
            userId: user.id,
            provider: 'email',
            subject: adminEmail,
            userAgent: req.headers['user-agent'] ?? null,
            ip: clientKey(req)
        })
        return {
            token: session.token,
            user: { id: user.id, email: user.email, role: user.role }
        }
    }

    @Get('me')
    @UseGuards(AuthGuard)
    async me(@CurrentUser() user: AuthPrincipal): Promise<AuthMeResponse> {
        const row = await this.resolveUser(user)
        const experiments = await this.resolveExperiments(row.id)
        const profile = await this.profile.getSummary(row.id)
        return {
            id: row.id,
            email: row.email,
            role: row.role,
            displayName: profile.displayName,
            avatarUpdatedAt: profile.avatarUpdatedAt,
            experiments
        }
    }

    @Get('whoami')
    @UseGuards(AuthGuard)
    @AllowRuntimeSelf()
    @AllowBoundTokenWithoutSubject('auth whoami reports the caller principal')
    async whoami(
        @CurrentUser() user: AuthPrincipal
    ): Promise<AuthWhoamiResponse> {
        if (user.kind === 'agent-runtime')
            return {
                kind: user.kind,
                userId: user.userId,
                agentId: user.agentId
            }
        const row = await this.resolveUser(user)
        const base = {
            userId: row.id,
            email: row.email,
            role: row.role
        }
        if (user.kind === 'legacy-runtime')
            return {
                ...base,
                kind: user.kind,
                agentId: user.agentId,
                tokenId: user.tokenId,
                enforceAgentBinding: user.enforceAgentBinding,
                createdVia: user.createdVia
            }
        return { ...base, kind: user.kind }
    }

    private async resolveUser(user: AuthPrincipal): Promise<{
        id: string
        email: string
        role: UserRole
    }> {
        const email =
            user.email || (await this.bearerAuth.getUserEmail(user.userId)) || ''
        return this.auth.upsertUser({
            id: user.userId,
            email
        })
    }

    private async resolveExperiments(
        userId: string
    ): Promise<ExperimentAssignments> {
        try {
            return await this.experiments.assignAllFor(userId)
        } catch {
            return {}
        }
    }
}
