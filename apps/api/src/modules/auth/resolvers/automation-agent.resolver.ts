import { Inject, Injectable } from '@nestjs/common'
import { automations, type Database } from '@manyfold/db'
import { and, eq, isNull } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import type { ResourceAgentResolver } from './resource-agent.resolver'

@Injectable()
export class AutomationAgentResolver implements ResourceAgentResolver {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async resolveAgentId(
        automationId: string,
        userId: string
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ agentId: automations.agentId })
            .from(automations)
            .where(
                and(
                    eq(automations.id, automationId),
                    eq(automations.userId, userId),
                    isNull(automations.deletedAt)
                )
            )
            .limit(1)
        return row?.agentId ?? null
    }
}
