import { Module } from '@nestjs/common'
import { HostDaemonAccessModule } from '@/modules/agents/adapters/host-daemon-access.module'
import { HostStorageService } from './host-storage.service'

@Module({
    imports: [HostDaemonAccessModule],
    providers: [HostStorageService],
    exports: [HostStorageService]
})
export class HostStorageModule {}
