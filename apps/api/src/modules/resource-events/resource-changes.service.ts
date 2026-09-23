import type { ResourceChangedEvent } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'

@Injectable()
export class ResourceChangesService {
    constructor(private readonly broadcaster: SpriteStatusBroadcaster) {}

    emit(
        ownerUserId: string,
        change: Omit<ResourceChangedEvent, 'type' | 'at'>
    ): void {
        this.broadcaster.emitResourceChanged(ownerUserId, {
            type: 'resource-changed',
            resource: change.resource,
            resourceId: change.resourceId,
            agentId: change.agentId,
            reason: change.reason,
            at: new Date().toISOString()
        })
    }
}
