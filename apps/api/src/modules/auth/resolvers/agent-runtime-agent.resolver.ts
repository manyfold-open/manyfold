import { Inject, Injectable } from '@nestjs/common'
import { agents, agentRuntimes, type Database } from '@manyfold/db'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import type { ResourceAgentResolver } from './resource-agent.resolver'

@Injectable()
export class AgentRuntimeAgentResolver implements ResourceAgentResolver {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async resolveAgentId(
        runtimeId: string,
        userId: string
    ): Promise<string | null> {
        const [runtime] = await this.db
            .select({ id: agentRuntimes.id })
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.id, runtimeId),
                    eq(agentRuntimes.userId, userId)
                )
            )
            .limit(1)
        if (!runtime) return null

        // Bound tokens can only operate on a runtime hosting exactly one agent
        // (the agent they're bound to). Multi-agent runtimes → null → guard
        // rejects with "no subject agent".
        const rows = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(
                and(
                    eq(agents.runtimeId, runtimeId),
                    eq(agents.userId, userId)
                )
            )
            .limit(2)
        if (rows.length === 1) return rows[0].id
        return null
    }
}
