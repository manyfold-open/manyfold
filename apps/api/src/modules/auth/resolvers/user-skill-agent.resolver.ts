import { Inject, Injectable } from '@nestjs/common'
import { userSkills, type Database } from '@manyfold/db'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE } from '@/db/tokens'
import type { ResourceAgentResolver } from './resource-agent.resolver'

@Injectable()
export class UserSkillAgentResolver implements ResourceAgentResolver {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async resolveAgentId(
        userSkillId: string,
        userId: string
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ agentId: userSkills.agentId })
            .from(userSkills)
            .where(
                and(
                    eq(userSkills.id, userSkillId),
                    eq(userSkills.userId, userId)
                )
            )
            .limit(1)
        // user_skills.agent_id is nullable (runtime-level skill).
        // Returning null here makes AuthzService treat it as "no subject
        // agent", which the assertBoundTokenSubject step rejects for bound
        // tokens — matching the v1.5 decision that bound tokens cannot
        // manage runtime-level skills.
        return row?.agentId ?? null
    }
}
