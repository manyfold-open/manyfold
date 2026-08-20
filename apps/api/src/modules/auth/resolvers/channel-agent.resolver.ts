import { Inject, Injectable } from '@nestjs/common'
import { channels, type Database } from '@manyfold/db'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import type { ResourceAgentResolver } from './resource-agent.resolver'

@Injectable()
export class ChannelAgentResolver implements ResourceAgentResolver {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async resolveAgentId(
        channelId: string,
        userId: string
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ agentId: channels.agentId })
            .from(channels)
            .where(
                and(eq(channels.id, channelId), eq(channels.userId, userId))
            )
            .limit(1)
        return row?.agentId ?? null
    }
}
