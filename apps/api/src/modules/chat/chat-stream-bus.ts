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

const CHANNEL = 'chat_stream_events'
const LISTEN_RETRY_MS = 5000

@Injectable()
export class ChatStreamBus
    implements OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = new Logger(ChatStreamBus.name)
    private readonly instanceId = randomUUID()
    private readonly messageHandlers: Array<(sessionId: string) => void> = []
    private readonly listenHandlers: Array<() => void> = []
    private unlisten: (() => Promise<void>) | null = null
    private stopped = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        @Optional() private readonly busPg?: BusPgService
    ) {}

    // Bus traffic rides the dedicated small client when available so NOTIFY
    // sends never queue behind app-query pool exhaustion; falls back to the
    // shared client for manually-constructed instances (tests).
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

    onMessage(handler: (sessionId: string) => void): void {
        this.messageHandlers.push(handler)
    }

    onListenEstablished(handler: () => void): void {
        this.listenHandlers.push(handler)
    }

    notify(sessionId: string): void {
        const payload = JSON.stringify({ o: this.instanceId, s: sessionId })
        void this.pg.notify(CHANNEL, payload).catch((err: Error) => {
            this.logger.warn(
                `notify failed for session=${sessionId}: ${err.message}`
            )
        })
    }

    private async startListening(): Promise<void> {
        while (!this.stopped) {
            try {
                const meta = await this.pg.listen(
                    CHANNEL,
                    (payload) => this.dispatch(payload),
                    () => {
                        for (const handler of this.listenHandlers) handler()
                    }
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
        let parsed: { o?: string; s?: string }
        try {
            parsed = JSON.parse(payload) as { o?: string; s?: string }
        } catch {
            return
        }
        if (!parsed.s || parsed.o === this.instanceId) return
        for (const handler of this.messageHandlers) handler(parsed.s)
    }
}
