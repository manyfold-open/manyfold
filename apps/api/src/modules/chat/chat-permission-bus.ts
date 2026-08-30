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

// Cross-instance delivery of a hermes permission ANSWER, mirroring
// ChatCancelBus: the answer endpoint lands on whichever API instance the load
// balancer picked, but the blocked ACP client (HermesAcpTurn) lives only in
// the instance running the interactive turn. The durable row in
// chat_permission_answers stays as the fallback for owners that were down at
// NOTIFY time — the coordinator's converge tick sweeps it.
const CHANNEL = 'chat_permission_answers'
const LISTEN_RETRY_MS = 5000

@Injectable()
export class ChatPermissionBus
    implements OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = new Logger(ChatPermissionBus.name)
    private readonly instanceId = randomUUID()
    private readonly answerHandlers: Array<
        (messageId: string, requestId: string, optionId: string) => void
    > = []
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

    onAnswer(
        handler: (
            messageId: string,
            requestId: string,
            optionId: string
        ) => void
    ): void {
        this.answerHandlers.push(handler)
    }

    notify(messageId: string, requestId: string, optionId: string): void {
        const payload = JSON.stringify({
            o: this.instanceId,
            m: messageId,
            r: requestId,
            a: optionId
        })
        void this.pg.notify(CHANNEL, payload).catch((err: Error) => {
            this.logger.warn(
                `permission answer notify failed for messageId=${messageId}: ${err.message}`
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
        let parsed: { o?: string; m?: string; r?: string; a?: string }
        try {
            parsed = JSON.parse(payload) as {
                o?: string
                m?: string
                r?: string
                a?: string
            }
        } catch {
            return
        }
        // The sender already tried its own coordinator before broadcasting.
        if (!parsed.m || !parsed.r || !parsed.a || parsed.o === this.instanceId)
            return
        for (const handler of this.answerHandlers)
            handler(parsed.m, parsed.r, parsed.a)
    }
}
