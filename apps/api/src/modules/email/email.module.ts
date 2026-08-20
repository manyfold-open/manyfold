import { Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { EmailService } from '@/modules/email/email.service'
import { EmailSettingsService } from '@/modules/email/email-settings.service'

@Module({
    providers: [EmailService, EmailSettingsService],
    exports: [EmailService, EmailSettingsService]
})
export class EmailModule {
    constructor(registry: CapabilitiesRegistry, settings: EmailSettingsService) {
        registry.register(
            'outboundEmail',
            async () => (await settings.getResolvedConfig()).provider !== 'console'
        )
    }
}
