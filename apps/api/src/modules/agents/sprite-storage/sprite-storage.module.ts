import { Module } from '@nestjs/common'
import { SpritesAccountsModule } from '@/modules/sprites-accounts/sprites-accounts.module'
import { SpriteExecHealthModule } from '@/modules/agents/sprite-exec-health/sprite-exec-health.module'
import { SpriteStorageService } from './sprite-storage.service'

@Module({
    imports: [SpritesAccountsModule, SpriteExecHealthModule],
    providers: [SpriteStorageService],
    exports: [SpriteStorageService]
})
export class SpriteStorageModule {}
