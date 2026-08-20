import { Inject, Injectable } from '@nestjs/common'
import { agentBackupRestores, type Database } from '@manyfold/db'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import type { ResourceAgentResolver } from './resource-agent.resolver'

@Injectable()
export class BackupRestoreAgentResolver implements ResourceAgentResolver {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async resolveAgentId(
        restoreId: string,
        userId: string
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ agentId: agentBackupRestores.targetAgentId })
            .from(agentBackupRestores)
            .where(
                and(
                    eq(agentBackupRestores.id, restoreId),
                    eq(agentBackupRestores.userId, userId)
                )
            )
            .limit(1)
        return row?.agentId ?? null
    }
}
