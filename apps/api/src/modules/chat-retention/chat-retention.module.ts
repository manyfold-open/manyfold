import { Module } from '@nestjs/common'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { ChatRetentionService } from './chat-retention.service'

@Module({
    providers: [ChatRetentionService, ServiceLeaseService],
    exports: [ChatRetentionService]
})
export class ChatRetentionModule {}
