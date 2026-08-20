import type { SpriteStatusEvent } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap,
    type OnApplicationShutdown
} from '@nestjs/common'
import type { Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { BusPgService } from '@/db/bus-pg.service'

const CHANNEL = 'sprite_status_events'
const LISTEN_RETRY_MS = 5000

export interface SpriteStatusDeliveryOpts {
    adminOnly?: boolean
}

type SpriteStatusBusHandler = (
    userId: string,
    event: SpriteStatusEvent,
    opts: SpriteStatusDeliveryOpts
) => void

interface BusPayload {
    o?: string
    u?: string
    e?: SpriteStatusEvent
    a?: boolean
}

// Same cross-instance fan-out as ChatStreamBus, on a dedicated channel.
// Status events are small and need no replay, so they ride in the NOTIFY
// payload directly instead of being persisted and pumped from the DB.
@Injectable()
export class SpriteStatusBus
    implements OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = new Logger(SpriteStatusBus.name)
    private readonly instanceId = randomUUID()
    private readonly handlers: SpriteStatusBusHandler[] = []
    private unlisten: (() => Promise<void>) | null = null
    private stopped = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        @Optional() private readonly busPg?: BusPgService
    ) {}

    // Same rationale as ChatStreamBus: bus signaling rides the dedicated
    // client when available, shared client for manually-built instances.
    private get pg(): Database['$client'] {
        return (this.busPg?.client ?? this.db.$client) as Database['$client']
    }

    onApplicationBootstrap(): void {
        void this.startListening()
    }

    async onApplicationShutdown(): Promise<void> {
        this.stopped = true
        await this.unlisten?.().catch(() => undefined)
    }

    onEvent(handler: SpriteStatusBusHandler): void {
        this.handlers.push(handler)
    }

    publish(
        userId: string,
        event: SpriteStatusEvent,
        opts: SpriteStatusDeliveryOpts = {}
    ): void {
        const payload = JSON.stringify({
            o: this.instanceId,
            u: userId,
            e: event,
            ...(opts.adminOnly ? { a: true } : {})
        })
        void this.pg.notify(CHANNEL, payload).catch((err: Error) => {
            this.logger.warn(`notify failed for user=${userId}: ${err.message}`)
        })
    }

    private async startListening(): Promise<void> {
        while (!this.stopped) {
            try {
                const meta = await this.pg.listen(CHANNEL, (payload) =>
                    this.dispatch(payload)
                )
                this.unlisten = meta.unlisten
                return
            } catch (err) {
                this.logger.warn(
                    `listen failed, retrying in ${LISTEN_RETRY_MS}ms: ${(err as Error).message}`
                )
                await new Promise((resolve) =>
                    setTimeout(resolve, LISTEN_RETRY_MS)
                )
            }
        }
    }

    private dispatch(payload: string): void {
        let parsed: BusPayload
        try {
            parsed = JSON.parse(payload) as BusPayload
        } catch {
            return
        }
        if (!parsed.u || !parsed.e || parsed.o === this.instanceId) return
        for (const handler of this.handlers)
            handler(parsed.u, parsed.e, { adminOnly: parsed.a === true })
    }
}
