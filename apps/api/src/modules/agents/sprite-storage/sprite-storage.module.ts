import { Module } from '@nestjs/common'
import { HostsModule } from '@/modules/hosts/hosts.module'
import { SpriteExecHealthModule } from '@/modules/agents/sprite-exec-health/sprite-exec-health.module'
import { SpriteStorageService } from './sprite-storage.service'

@Module({
    imports: [HostsModule, SpriteExecHealthModule],
    providers: [SpriteStorageService],
    exports: [SpriteStorageService]
})
export class SpriteStorageModule {}
