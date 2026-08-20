import type {
    QuotaWarningEvent,
    SpriteHostStatusUpdate,
    SpriteStatusEvent,
    SpriteStatusUpdate
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import {
    SpriteStatusBus,
    type SpriteStatusDeliveryOpts
} from '@/modules/agents/sprite-status/sprite-status-bus'

export type {
    QuotaWarningEvent,
    SpriteHostStatusUpdate,
    SpriteStatusEvent,
    SpriteStatusUpdate
}

export interface SpriteStatusSubscriber {
    send: (event: SpriteStatusEvent) => void
    close: () => void
    isAdmin?: boolean
}

// Subscribers are in-process, but with several API instances the SSE
// connection and the emitter usually live on different machines — every
// emit also rides the Postgres bus, and each instance forwards bus events
// (self-origin already filtered there) to its local subscribers.
@Injectable()
export class SpriteStatusBroadcaster {
    private readonly log = new Logger(SpriteStatusBroadcaster.name)
    private readonly subscribers = new Map<
        string,
        Set<SpriteStatusSubscriber>
    >()

    constructor(private readonly bus: SpriteStatusBus) {
        this.bus.onEvent((userId, event, opts) =>
            this.deliverLocal(userId, event, opts)
        )
    }

    subscribe(userId: string, sub: SpriteStatusSubscriber): () => void {
        let set = this.subscribers.get(userId)
        if (!set) {
            set = new Set()
            this.subscribers.set(userId, set)
        }
        set.add(sub)
        this.log.log(`subscribed userId=${userId} (count=${set.size})`)
        return (): void => {
            const current = this.subscribers.get(userId)
            if (!current) return
            current.delete(sub)
            const remaining = current.size
            if (remaining === 0) this.subscribers.delete(userId)
            this.log.log(`unsubscribed userId=${userId} (count=${remaining})`)
        }
    }

    emit(userId: string, update: SpriteStatusUpdate): void {
        const count = this.subscribers.get(userId)?.size ?? 0
        this.log.log(
            `emit userId=${userId} agentId=${update.agentId} sprite=${update.spriteStatus} k8s=${update.k8sPodPhase} subscribers=${count}`
        )
        const event: SpriteStatusEvent = { type: 'update', ...update }
        this.deliverLocal(userId, event, {})
        this.bus.publish(userId, event)
    }

    emitHostUpdate(userId: string, update: SpriteHostStatusUpdate): void {
        const count = this.subscribers.get(userId)?.size ?? 0
        this.log.log(
            `emit host-update userId=${userId} hostId=${update.hostId} sprite=${update.spriteStatus} subscribers=${count}`
        )
        const event: SpriteStatusEvent = { type: 'host-update', ...update }
        this.deliverLocal(userId, event, {})
        this.bus.publish(userId, event)
    }

    emitQuotaWarning(
        userId: string,
        event: QuotaWarningEvent,
        opts: SpriteStatusDeliveryOpts = {}
    ): void {
        const count = this.subscribers.get(userId)?.size ?? 0
        this.log.log(
            `emit quota-warning userId=${userId} code=${event.code} usage=${event.usage}/${event.limit} subscribers=${count} adminOnly=${!!opts.adminOnly}`
        )
        this.deliverLocal(userId, event, opts)
        this.bus.publish(userId, event, opts)
    }

    private deliverLocal(
        userId: string,
        event: SpriteStatusEvent,
        opts: SpriteStatusDeliveryOpts
    ): void {
        const subs = this.subscribers.get(userId)
        if (!subs || subs.size === 0) return
        for (const sub of subs) {
            if (opts.adminOnly && !sub.isAdmin) continue
            try {
                sub.send(event)
            } catch (err) {
                this.log.warn(
                    `subscriber send failed: ${(err as Error).message}`
                )
            }
        }
    }
}
