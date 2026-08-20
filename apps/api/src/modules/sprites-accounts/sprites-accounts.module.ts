import { Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { AuthModule } from '@/modules/auth/auth.module'
import { AdminGuard } from '@/common/guards/admin.guard'
import { SpritesAccountsController } from '@/modules/sprites-accounts/sprites-accounts.controller'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'

@Module({
    imports: [AuthModule],
    controllers: [SpritesAccountsController],
    providers: [AdminGuard, SpritesAccountsService],
    exports: [SpritesAccountsService]
})
export class SpritesAccountsModule {
    constructor(registry: CapabilitiesRegistry, accounts: SpritesAccountsService) {
        registry.register(
            'spritesAccounts',
            async () => (await accounts.list()).length > 0
        )
    }
}
