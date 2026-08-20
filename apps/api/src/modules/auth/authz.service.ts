import {
    ApiTokenScope,
    auditAction,
    isApiTokenScope,
    isGrantableScope
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    type ExecutionContext
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { agentPermissions, agents, auditLogs, type Database } from '@manyfold/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import {
    SUBJECT_AGENT_META,
    type ResourceKind,
    type SubjectAgentClassification
} from '@/common/decorators/subject-agent.decorator'
import { DRIZZLE } from '@/db/tokens'
import { AgentRuntimeAgentResolver } from './resolvers/agent-runtime-agent.resolver'
import { AutomationAgentResolver } from './resolvers/automation-agent.resolver'
import { BackupAgentResolver } from './resolvers/backup-agent.resolver'
import { BackupRestoreAgentResolver } from './resolvers/backup-restore-agent.resolver'
import { ChannelAgentResolver } from './resolvers/channel-agent.resolver'
import type { ResourceAgentResolver } from './resolvers/resource-agent.resolver'
import { UserSkillAgentResolver } from './resolvers/user-skill-agent.resolver'

export type SubjectResolution =
    | {
          classification: SubjectAgentClassification
          subjectAgentId: string | null
      }
    | { classification: null; subjectAgentId: null }

type AuthedRequest = FastifyRequest & {
    auth?: { userId: string }
    resourceAgentCache?: Map<string, string | null>
}

@Injectable()
export class AuthzService {
    private readonly resolvers: ReadonlyMap<ResourceKind, ResourceAgentResolver>
    private readonly log = new Logger(AuthzService.name)

    constructor(
        private readonly reflector: Reflector,
        @Inject(DRIZZLE) private readonly db: Database,
        channels: ChannelAgentResolver,
        automations: AutomationAgentResolver,
        userSkills: UserSkillAgentResolver,
        backups: BackupAgentResolver,
        backupRestores: BackupRestoreAgentResolver,
        agentRuntimes: AgentRuntimeAgentResolver
    ) {
        const map = new Map<ResourceKind, ResourceAgentResolver>()
        map.set('channel', channels)
        map.set('automation', automations)
        map.set('userSkill', userSkills)
        map.set('backup', backups)
        map.set('backupRestore', backupRestores)
        map.set('agentRuntime', agentRuntimes)
        this.resolvers = map
    }

    classify(context: ExecutionContext): SubjectAgentClassification | null {
        return (
            this.reflector.getAllAndOverride<SubjectAgentClassification>(
                SUBJECT_AGENT_META,
                [context.getHandler(), context.getClass()]
            ) ?? null
        )
    }

    async resolveSubjectAgent(
        context: ExecutionContext,
        req: AuthedRequest
    ): Promise<SubjectResolution> {
        const classification = this.classify(context)
        if (!classification) return { classification: null, subjectAgentId: null }

        switch (classification.type) {
            case 'list-filtered':
            case 'deny-bound':
            case 'allowlisted':
                return { classification, subjectAgentId: null }
            case 'path':
                return {
                    classification,
                    subjectAgentId:
                        readParam(req.params, classification.param) ?? null
                }
            case 'body':
                return {
                    classification,
                    subjectAgentId:
                        readField(req.body, classification.field) ?? null
                }
            case 'query': {
                const value = readField(req.query, classification.field)
                // Convention: query agentId is OPTIONAL. When absent, treat
                // as list-filtered so bound tokens still pass the guard and
                // the service layer applies a user-scoped filter (where
                // applicable). When present, the value is the subject and
                // must match the bound agent.
                if (!value) {
                    return {
                        classification: { type: 'list-filtered' },
                        subjectAgentId: null
                    }
                }
                return { classification, subjectAgentId: value }
            }
            case 'resource': {
                const resourceId = readParam(req.params, classification.param)
                if (!resourceId)
                    return { classification, subjectAgentId: null }
                if (!req.auth?.userId)
                    return { classification, subjectAgentId: null }
                const cacheKey = `${classification.kind}:${resourceId}`
                const cache = getCache(req)
                if (cache.has(cacheKey))
                    return {
                        classification,
                        subjectAgentId: cache.get(cacheKey) ?? null
                    }
                const resolver = this.resolvers.get(classification.kind)
                if (!resolver)
                    throw new Error(
                        `no agent resolver registered for kind: ${classification.kind}`
                    )
                const agentId = await resolver.resolveAgentId(
                    resourceId,
                    req.auth.userId
                )
                cache.set(cacheKey, agentId)
                return { classification, subjectAgentId: agentId }
            }
        }
    }

    assertBoundTokenSubject(
        boundAgentId: string,
        resolution: SubjectResolution
    ): void {
        const cls = resolution.classification
        if (!cls) {
            throw new ForbiddenException(
                'bound token cannot access this endpoint: no subject-agent classification'
            )
        }
        if (cls.type === 'list-filtered') return
        if (cls.type === 'allowlisted') return
        if (cls.type === 'deny-bound') {
            throw new ForbiddenException(
                'bound token cannot access this endpoint'
            )
        }
        if (resolution.subjectAgentId === null) {
            throw new ForbiddenException(
                'bound token has no subject agent for this request'
            )
        }
        if (resolution.subjectAgentId !== boundAgentId) {
            throw new ForbiddenException(
                `token bound to ${boundAgentId}, request targets ${resolution.subjectAgentId}`
            )
        }
    }

    // Authorization for an agent-runtime principal: the scope list lives in
    // agent_permissions, looked up per request (no cache — multi-machine Fly).
    // api.full / chat.completions can never authorize a runtime; a stored row
    // carrying them is corruption, so deny everything and log loud (M-sec-1).
    async getAgentPermissionScopes(agentId: string): Promise<ApiTokenScope[]> {
        const [row] = await this.db
            .select({ scopes: agentPermissions.scopes })
            .from(agentPermissions)
            .where(eq(agentPermissions.agentId, agentId))
            .limit(1)
        if (!row) return []
        const raw = Array.isArray(row.scopes) ? row.scopes : []
        const valid = raw.filter(isApiTokenScope)
        if (valid.some((scope) => !isGrantableScope(scope))) {
            this.log.error(
                `agent_permissions for ${agentId} contains a non-grantable scope; denying all`
            )
            return []
        }
        return valid
    }

    async assertAgentOwnedByUser(
        agentId: string,
        userId: string
    ): Promise<void> {
        const [row] = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        if (!row)
            throw new ForbiddenException(
                `agent ${agentId} is not in this account`
            )
    }

    // Account scope (ADR-0010): the request reaches beyond the calling agent
    // but must stay within the same user account. List / account-level
    // classifications carry no per-agent subject and are scoped by userId at
    // the service layer; subject-carrying endpoints must target an owned agent.
    async assertAccountSubject(
        resolution: SubjectResolution,
        userId: string
    ): Promise<void> {
        const cls = resolution.classification
        // Default-deny a missing classification (mirrors assertBoundTokenSubject):
        // an undecorated endpoint must never become reachable under account scope
        // just because a scope matched. Account-level endpoints opt in explicitly
        // via deny-bound / allowlisted / list-filtered.
        if (!cls)
            throw new ForbiddenException(
                'account scope: endpoint has no subject-agent classification'
            )
        if (
            cls.type === 'list-filtered' ||
            cls.type === 'deny-bound' ||
            cls.type === 'allowlisted'
        )
            return
        if (resolution.subjectAgentId === null)
            throw new ForbiddenException(
                'account scope: request has no subject agent to authorize'
            )
        await this.assertAgentOwnedByUser(resolution.subjectAgentId, userId)
    }

    async recordCrossAgentUse(args: {
        tokenId: string
        userId: string
        fromAgent: string
        toAgent: string
        scopes: readonly string[]
        endpoint: string
    }): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: `apiToken:${args.tokenId}`,
                action: auditAction.GRANT_CROSS_AGENT_USE,
                subject: args.fromAgent,
                meta: {
                    userId: args.userId,
                    tokenId: args.tokenId,
                    fromAgent: args.fromAgent,
                    toAgent: args.toAgent,
                    scopes: args.scopes,
                    endpoint: args.endpoint
                }
            })
        } catch (error) {
            this.log.warn(
                `failed to record cross-agent use for token ${args.tokenId}: ${(error as Error).message}`
            )
        }
    }
}

const readParam = (
    params: unknown,
    name: string
): string | undefined => {
    if (params && typeof params === 'object' && name in (params as object)) {
        const value = (params as Record<string, unknown>)[name]
        return typeof value === 'string' ? value : undefined
    }
    return undefined
}

const readField = (
    obj: unknown,
    name: string
): string | undefined => {
    if (obj && typeof obj === 'object' && name in (obj as object)) {
        const value = (obj as Record<string, unknown>)[name]
        return typeof value === 'string' ? value : undefined
    }
    return undefined
}

const getCache = (req: AuthedRequest): Map<string, string | null> => {
    if (!req.resourceAgentCache) req.resourceAgentCache = new Map()
    return req.resourceAgentCache
}
