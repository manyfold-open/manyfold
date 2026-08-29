import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap
} from '@nestjs/common'
import { chatPermissionAnswers, type Database } from '@manyfold/db'
import { eq } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import { ChatPermissionBus } from './chat-permission-bus'

export interface PermissionHolder {
    respond: (requestId: string, optionId: string) => 'delivered' | 'unknown'
    pendingIds: () => string[]
}

// Routes a user's permission answer to the in-process HermesAcpTurn that is
// blocked on it. Registration is keyed by messageId — the same key
// runningAdapters uses — because the answer endpoint only knows the message.
// Cross-instance answers arrive via the bus, and the converge tick sweeps the
// durable chat_permission_answers rows for asks whose NOTIFY was lost — the
// same durable-plus-bus contract cancel uses.
@Injectable()
export class HermesPermissionCoordinator implements OnApplicationBootstrap {
    private readonly logger = new Logger(HermesPermissionCoordinator.name)
    private readonly holders = new Map<string, PermissionHolder>()
    private convergeTimer: NodeJS.Timeout | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        @Optional() private readonly bus?: ChatPermissionBus
    ) {}

    onApplicationBootstrap(): void {
        this.bus?.onAnswer((messageId, requestId, optionId) => {
            this.respondLocal(messageId, requestId, optionId)
        })
    }

    register(messageId: string, holder: PermissionHolder): () => void {
        this.holders.set(messageId, holder)
        this.ensureConvergeTimer()
        return () => {
            if (this.holders.get(messageId) === holder)
                this.holders.delete(messageId)
        }
    }

    respondLocal(
        messageId: string,
        requestId: string,
        optionId: string
    ): 'delivered' | 'unknown' | 'no_holder' {
        const holder = this.holders.get(messageId)
        if (!holder) return 'no_holder'
        return holder.respond(requestId, optionId)
    }

    // Lost-NOTIFY fallback: while any interactive turn holds pending asks,
    // periodically sweep the durable answers for them. Cheap when idle — the
    // timer only queries when at least one holder reports a pending id.
    private ensureConvergeTimer(): void {
        if (this.convergeTimer) return
        this.convergeTimer = setInterval(() => {
            void this.convergeDurableAnswers()
        }, 10_000)
        if (typeof this.convergeTimer.unref === 'function')
            this.convergeTimer.unref()
    }

    private async convergeDurableAnswers(): Promise<void> {
        const pendingByMessage: Array<{ messageId: string; ids: string[] }> = []
        for (const [messageId, holder] of this.holders) {
            const ids = holder.pendingIds()
            if (ids.length > 0) pendingByMessage.push({ messageId, ids })
        }
        if (pendingByMessage.length === 0) return
        try {
            for (const { messageId, ids } of pendingByMessage) {
                const rows = await this.db
                    .select({
                        requestId: chatPermissionAnswers.requestId,
                        optionId: chatPermissionAnswers.optionId
                    })
                    .from(chatPermissionAnswers)
                    .where(eq(chatPermissionAnswers.messageId, messageId))
                for (const row of rows) {
                    if (!ids.includes(row.requestId)) continue
                    this.respondLocal(messageId, row.requestId, row.optionId)
                }
            }
        } catch (err) {
            this.logger.warn(
                `permission answer converge failed: ${(err as Error).message}`
            )
        }
    }
}
