import type {
    A2aTurnTimeoutsSettings,
    AutomationRetentionSettings,
    BuiltinSkillReposSettings,
    ChatExecTimeoutsSettings,
    CliMinimumVersionSettings,
    EmailProviderSettings,
    FeatureTogglesView,
    FrameworkDefaultVersionsSettings,
    FrameworkRuntimeDefaultsSettings,
    LoginProviderSettings,
    SendTestEmailResult,
    SpritesVendorCapacityView,
    SpritesWholesaleCapSettings
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Post,
    Put,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import {
    UpdateA2aTurnTimeoutsSettingsDto,
    UpdateAutomationRetentionSettingsDto,
    UpdateBuiltinSkillReposSettingsDto,
    UpdateChatExecTimeoutsSettingsDto,
    UpdateCliMinimumVersionSettingsDto,
    UpdateFeatureToggleDto,
    UpdateFrameworkRuntimeDefaultsSettingsDto,
    UpdateFrameworkDefaultVersionsSettingsDto,
    UpdateSpritesWholesaleCapSettingsDto
} from '@/modules/admin-settings/dto/admin-settings.dto'
import { AuthSettingsService } from '@/modules/auth/auth-settings.service'
import { UpdateLoginProviderSettingsDto } from '@/modules/auth/dto/auth-settings.dto'
import { EmailSettingsService } from '@/modules/email/email-settings.service'
import { EmailService } from '@/modules/email/email.service'
import { renderEmail } from '@/modules/email/templates/render-email'
import {
    SendTestEmailDto,
    UpdateEmailProviderSettingsDto
} from '@/modules/email/dto/email-settings.dto'

@Controller('admin/settings')
@UseGuards(AuthGuard, AdminGuard)
export class AdminSettingsController {
    constructor(
        private readonly settings: AdminSettingsService,
        private readonly authSettings: AuthSettingsService,
        private readonly emailSettings: EmailSettingsService,
        private readonly email: EmailService
    ) {}

    @Get('login-provider')
    getLoginProvider(): Promise<LoginProviderSettings> {
        return this.authSettings.getView()
    }

    @Put('login-provider')
    updateLoginProvider(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateLoginProviderSettingsDto
    ): Promise<LoginProviderSettings> {
        return this.authSettings.update(user.userId, dto)
    }

    @Get('builtin-skill-repos')
    getBuiltinSkillRepos(): Promise<BuiltinSkillReposSettings> {
        return this.settings.getBuiltinSkillRepos()
    }

    @Put('builtin-skill-repos')
    updateBuiltinSkillRepos(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateBuiltinSkillReposSettingsDto
    ): Promise<BuiltinSkillReposSettings> {
        return this.settings.updateBuiltinSkillRepos(user.userId, dto.repos)
    }

    @Get('sprites-wholesale-cap')
    getSpritesWholesaleCap(): Promise<SpritesWholesaleCapSettings> {
        return this.settings.getSpritesWholesaleCap()
    }

    // Read-only on purpose: this is what sprites.dev reports, not something an
    // operator sets. Editing happens on sprites.dev (or via the policy PUT above).
    @Get('sprites-vendor-capacity')
    getSpritesVendorCapacity(): Promise<SpritesVendorCapacityView> {
        return this.settings.getSpritesVendorCapacity()
    }

    @Put('sprites-wholesale-cap')
    updateSpritesWholesaleCap(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateSpritesWholesaleCapSettingsDto
    ): Promise<SpritesWholesaleCapSettings> {
        return this.settings.updateSpritesWholesaleCap(user.userId, dto)
    }

    @Get('automation-retention')
    getAutomationRetention(): Promise<AutomationRetentionSettings> {
        return this.settings.getAutomationRetention()
    }

    @Put('automation-retention')
    updateAutomationRetention(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateAutomationRetentionSettingsDto
    ): Promise<AutomationRetentionSettings> {
        return this.settings.updateAutomationRetention(user.userId, dto)
    }

    @Get('chat-exec-timeouts')
    getChatExecTimeouts(): Promise<ChatExecTimeoutsSettings> {
        return this.settings.getChatExecTimeouts()
    }

    @Put('chat-exec-timeouts')
    updateChatExecTimeouts(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateChatExecTimeoutsSettingsDto
    ): Promise<ChatExecTimeoutsSettings> {
        return this.settings.updateChatExecTimeouts(user.userId, dto)
    }

    @Get('a2a-turn-timeouts')
    getA2aTurnTimeouts(): Promise<A2aTurnTimeoutsSettings> {
        return this.settings.getA2aTurnTimeouts()
    }

    @Put('a2a-turn-timeouts')
    updateA2aTurnTimeouts(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateA2aTurnTimeoutsSettingsDto
    ): Promise<A2aTurnTimeoutsSettings> {
        return this.settings.updateA2aTurnTimeouts(user.userId, dto)
    }

    @Get('cli-minimum-version')
    getCliMinimumVersion(): Promise<CliMinimumVersionSettings> {
        return this.settings.getCliMinimumVersion()
    }

    @Put('cli-minimum-version')
    updateCliMinimumVersion(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateCliMinimumVersionSettingsDto
    ): Promise<CliMinimumVersionSettings> {
        return this.settings.updateCliMinimumVersion(user.userId, dto)
    }

    @Get('framework-runtime-defaults')
    getFrameworkRuntimeDefaults(): Promise<FrameworkRuntimeDefaultsSettings> {
        return this.settings.getFrameworkRuntimeDefaults()
    }

    @Put('framework-runtime-defaults')
    updateFrameworkRuntimeDefaults(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateFrameworkRuntimeDefaultsSettingsDto
    ): Promise<FrameworkRuntimeDefaultsSettings> {
        return this.settings.updateFrameworkRuntimeDefaults(user.userId, dto)
    }

    @Get('framework-default-versions')
    getFrameworkDefaultVersions(): Promise<FrameworkDefaultVersionsSettings> {
        return this.settings.getFrameworkDefaultVersions()
    }

    @Put('framework-default-versions')
    updateFrameworkDefaultVersions(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateFrameworkDefaultVersionsSettingsDto
    ): Promise<FrameworkDefaultVersionsSettings> {
        return this.settings.updateFrameworkDefaultVersions(user.userId, dto)
    }

    @Get('email-provider')
    getEmailProvider(): Promise<EmailProviderSettings> {
        return this.emailSettings.getView()
    }

    @Put('email-provider')
    updateEmailProvider(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateEmailProviderSettingsDto
    ): Promise<EmailProviderSettings> {
        return this.emailSettings.update(user.userId, dto)
    }

    @Post('email-provider/test')
    async sendTestEmail(
        @Body() dto: SendTestEmailDto
    ): Promise<SendTestEmailResult> {
        const config = await this.emailSettings.getResolvedConfig()
        try {
            await this.email.send({
                to: dto.to,
                subject: 'Manyfold test email',
                tag: 'admin.email_provider_test',
                // Rendered through the real template so the test proves the
                // HTML part delivers too, not just the plain-text fallback.
                ...renderEmail({
                    preheader: 'Outbound email is working.',
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: 'This is a test email sent from the Manyfold admin panel. If you received it, outbound email is working.'
                        },
                        {
                            kind: 'callout',
                            label: 'Active provider',
                            text: config.provider
                        }
                    ]
                })
            })
        } catch (err) {
            throw new BadRequestException(
                `test email failed: ${(err as Error).message}`
            )
        }
        return { ok: true, provider: config.provider }
    }

    @Get('feature-toggles')
    getFeatureToggles(): Promise<FeatureTogglesView> {
        return this.settings.getFeatureToggles()
    }

    @Put('feature-toggles')
    updateFeatureToggle(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: UpdateFeatureToggleDto
    ): Promise<FeatureTogglesView> {
        return this.settings.updateFeatureToggle(
            user.userId,
            dto.key,
            dto.enabled
        )
    }

}
