import { Module } from '@nestjs/common'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import { SpriteStatusBus } from '@/modules/agents/sprite-status/sprite-status-bus'
import { ResourceChangesService } from './resource-changes.service'

// Share one account-scoped transport without importing agent orchestration
// into the resource services that orchestration itself depends on.
@Module({
    providers: [
        SpriteStatusBus,
        SpriteStatusBroadcaster,
        ResourceChangesService
    ],
    exports: [SpriteStatusBroadcaster, ResourceChangesService]
})
export class ResourceEventsModule {}
