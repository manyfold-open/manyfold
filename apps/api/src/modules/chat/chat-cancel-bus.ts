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

// Cross-instance cancel delivery. A cancel request lands on whichever API
// instance the load balancer picked, but the AbortController for the turn
// lives only in the instance that runs the adapter (ChatService's
// runningAdapters). Before this bus, a cancel that missed the owner just
// wrote cancel_requested_at — which only the daemon resume path ever reads —
// and returned 204 having done nothing (#402). The NOTIFY tells every peer
// "abort this message if you own it"; the durable flag stays as the fallback
// for owners that were down at NOTIFY time.
const CHANNEL = 'chat_cancel_requests'
const LISTEN_RETRY_MS = 5000

@Injectable()
export class ChatCancelBus
    implements OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = new Logger(ChatCancelBus.name)
    private readonly instanceId = randomUUID()
    private readonly cancelHandlers: Array<(messageId: string) => void> = []
    private unlisten: (() => Promise<void>) | null = null
    private stopped = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        @Optional() private readonly busPg?: BusPgService
    ) {}

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

    onCancelRequested(handler: (messageId: string) => void): void {
        this.cancelHandlers.push(handler)
    }

    notify(messageId: string): void {
        const payload = JSON.stringify({ o: this.instanceId, m: messageId })
        void this.pg.notify(CHANNEL, payload).catch((err: Error) => {
            this.logger.warn(
                `cancel notify failed for messageId=${messageId}: ${err.message}`
            )
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
        let parsed: { o?: string; m?: string }
        try {
            parsed = JSON.parse(payload) as { o?: string; m?: string }
        } catch {
            return
        }
        // The sender already checked its own runningAdapters before
        // broadcasting, so its own NOTIFY carries nothing new for it.
        if (!parsed.m || parsed.o === this.instanceId) return
        for (const handler of this.cancelHandlers) handler(parsed.m)
    }
}
