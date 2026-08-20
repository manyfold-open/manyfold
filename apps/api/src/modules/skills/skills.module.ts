import { Module } from '@nestjs/common'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AdminSettingsModule } from '@/modules/admin-settings/admin-settings.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { DaemonModule } from '@/modules/daemon/daemon.module'
import { AdminSkillsCatalogController } from './admin-skills-catalog.controller'
import { LibrarySkillSharesService } from './library-skill-shares.service'
import { LibrarySkillsController } from './library-skills.controller'
import { LibrarySkillsService } from './library-skills.service'
import { SharedSkillsController } from './shared-skills.controller'
import { SkillDiscoveryService } from './skill-discovery.service'
import { SkillMaterializerService } from './skill-materializer.service'
import { ShareRateLimitService } from '@/common/share-rate-limit.service'
import { SkillsController } from './skills.controller'
import { SkillsService } from './skills.service'

@Module({
    imports: [AuthModule, SpritesAccountsModule, DaemonModule, AdminSettingsModule],
    controllers: [
        SkillsController,
        LibrarySkillsController,
        SharedSkillsController,
        AdminSkillsCatalogController
    ],
    providers: [
        AdminGuard,
        SkillDiscoveryService,
        SkillMaterializerService,
        SkillsService,
        LibrarySkillsService,
        LibrarySkillSharesService,
        ShareRateLimitService
    ],
    exports: [SkillMaterializerService]
})
export class SkillsModule {}
