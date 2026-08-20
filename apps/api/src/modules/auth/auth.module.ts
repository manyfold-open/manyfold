import { Module } from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { EmailModule } from '@/modules/email/email.module'
import { ApiTokenService } from '@/modules/auth/api-token.service'
import { ApiTokensController } from '@/modules/auth/api-tokens.controller'
import { AuthController } from '@/modules/auth/auth.controller'
import { NativeAuthController } from '@/modules/auth/native-auth.controller'
import { IdentitiesController } from '@/modules/auth/identities.controller'
import { AccountEmailController } from '@/modules/auth/account-email.controller'
import { AccountPasswordController } from '@/modules/auth/account-password.controller'
import { AccountProfileController } from '@/modules/auth/account-profile.controller'
import { AccountProfileService } from '@/modules/auth/account-profile.service'
import { AuthService } from '@/modules/auth/auth.service'
import { AuthSettingsService } from '@/modules/auth/auth-settings.service'
import { AuthzService } from '@/modules/auth/authz.service'
import { CliAuthController } from '@/modules/auth/cli-auth.controller'
import { CliAuthRateLimitService } from '@/modules/auth/cli-auth-rate-limit.service'
import { CliAuthService } from '@/modules/auth/cli-auth.service'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import { EmailVerificationService } from '@/modules/auth/email-verification.service'
import { GrantsController } from '@/modules/auth/grants.controller'
import { AgentPermissionsController } from '@/modules/auth/agent-permissions.controller'
import { AgentPermissionsService } from '@/modules/auth/agent-permissions.service'
import { OauthFlowService } from '@/modules/auth/oauth-flow.service'
import { OidcTokenVerifierService } from '@/modules/auth/oidc-token-verifier.service'
import { NetmindTokenVerifierService } from '@/modules/auth/netmind-token-verifier.service'
import { PasswordService } from '@/modules/auth/password.service'
import { RuntimeTokenService } from '@/modules/auth/runtime-token.service'
import { SessionService } from '@/modules/auth/session.service'
import { AgentRuntimeAgentResolver } from '@/modules/auth/resolvers/agent-runtime-agent.resolver'
import { AutomationAgentResolver } from '@/modules/auth/resolvers/automation-agent.resolver'
import { BackupAgentResolver } from '@/modules/auth/resolvers/backup-agent.resolver'
import { BackupRestoreAgentResolver } from '@/modules/auth/resolvers/backup-restore-agent.resolver'
import { ChannelAgentResolver } from '@/modules/auth/resolvers/channel-agent.resolver'
import { UserSkillAgentResolver } from '@/modules/auth/resolvers/user-skill-agent.resolver'

@Module({
    imports: [EmailModule],
    controllers: [
        AuthController,
        NativeAuthController,
        IdentitiesController,
        AccountEmailController,
        AccountPasswordController,
        AccountProfileController,
        ApiTokensController,
        CliAuthController,
        GrantsController,
        AgentPermissionsController
    ],
    providers: [
        ApiTokenService,
        RuntimeTokenService,
        AgentPermissionsService,
        CliAuthRateLimitService,
        CliAuthService,
        OidcTokenVerifierService,
        NetmindTokenVerifierService,
        BearerAuthService,
        AuthGuard,
        AccountProfileService,
        AuthService,
        AuthSettingsService,
        AuthzService,
        SessionService,
        PasswordService,
        EmailVerificationService,
        OauthFlowService,
        ChannelAgentResolver,
        AutomationAgentResolver,
        UserSkillAgentResolver,
        BackupAgentResolver,
        BackupRestoreAgentResolver,
        AgentRuntimeAgentResolver
    ],
    exports: [
        ApiTokenService,
        RuntimeTokenService,
        BearerAuthService,
        AuthGuard,
        AuthService,
        AuthSettingsService,
        AuthzService,
        SessionService,
        NetmindTokenVerifierService,
        CliAuthRateLimitService
    ]
})
export class AuthModule {}
