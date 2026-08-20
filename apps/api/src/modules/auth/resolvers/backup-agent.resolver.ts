import { Inject, Injectable } from '@nestjs/common'
import { agentBackups, type Database } from '@manyfold/db'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import type { ResourceAgentResolver } from './resource-agent.resolver'

@Injectable()
export class BackupAgentResolver implements ResourceAgentResolver {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async resolveAgentId(
        backupId: string,
        userId: string
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ agentId: agentBackups.sourceAgentId })
            .from(agentBackups)
            .where(
                and(
                    eq(agentBackups.id, backupId),
                    eq(agentBackups.userId, userId)
                )
            )
            .limit(1)
        // source_agent_id is set null on agent delete; bound token can no
        // longer claim provenance of an orphaned backup.
        return row?.agentId ?? null
    }
}
