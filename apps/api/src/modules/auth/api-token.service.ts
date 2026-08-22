import {
    A2aGrantSummary,
    A2aOutboundGrantSummary,
    ApiTokenScope,
    ApiTokenSummary,
    GrantableScope,
    TokenCreatedVia,
    auditAction,
    createObjectId,
    isApiTokenScope,
    isGrantableScope,
    isTokenCreatedVia
} from '@manyfold/shared'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    UnauthorizedException
} from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import {
    and,
    desc,
    eq,
    gt,
    inArray,
    isNotNull,
    isNull,
    like,
    lt,
    notInArray,
    or
} from 'drizzle-orm'
import {
    a2aAgentGrants,
    agentPermissions,
    agentRuntimeTokens,
    agents,
    apiTokens,
    auditLogs,
    tokenCredentials,
    users,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import type { AuthPrincipal } from './auth-principal'
import { principalScopes } from './auth-principal'

const API_TOKEN_PREFIX = 'nca_'
// Runtime identity tokens carry a distinct prefix so the OpenAI /v1 surface can
// reject them before any DB lookup (§5.6). It extends API_TOKEN_PREFIX, so
// isApiToken() still accepts both; external tokens are generated to never start
// with it (generateApiTokenPlaintext) so the discriminator stays unambiguous.
export const RUNTIME_TOKEN_PREFIX = 'nca_rt_'
export const TOKEN_BYTES = 32
export const API_TOKEN_SCOPE_CHAT_COMPLETIONS: ApiTokenScope =
    'chat.completions'
export const API_TOKEN_SCOPE_FULL: ApiTokenScope = 'api.full'
export const API_TOKEN_SCOPE_A2A: GrantableScope = 'a2a:edit'
export const API_TOKEN_SCOPE_A2A_READ: GrantableScope = 'a2a:read'

type ApiTokenWriter = Pick<Database, 'insert'>
type ApiTokenGrantTx = Pick<Database, 'select' | 'update' | 'insert'>

export interface MintedApiToken {
    tokenId: string
    plaintext: string
    expiresAt: Date | null
    scopes: ApiTokenScope[]
    agentId: string | null
    enforceAgentBinding: boolean
    createdVia: TokenCreatedVia | null
}

@Injectable()
export class ApiTokenService {
    private readonly log = new Logger(ApiTokenService.name)

    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async mint(
        args: {
            userId: string
            name: string
            scopes?: ApiTokenScope[]
            expiresInDays?: number
            // Sub-day TTL for short-lived tokens (e.g. terminal sessions). Takes
            // precedence over expiresInDays when set.
            expiresInSeconds?: number
            // Tags ephemeral/session tokens (e.g. 'terminal') so the reaper and
            // the personal-token list can target them. Defaults to 'user-grant'.
            tokenKind?: 'user-grant' | 'a2a-grant' | 'a2a-ephemeral' | 'terminal'
        },
        db: ApiTokenWriter = this.db
    ): Promise<MintedApiToken> {
        const scopes = normalizeApiTokenScopes(args.scopes)
        const plaintext = generateApiTokenPlaintext()
        const tokenId = createObjectId('apiToken')
        const now = new Date()
        let expiresAt: Date | null = null
        if (args.expiresInSeconds && args.expiresInSeconds > 0) {
            expiresAt = new Date(now.getTime() + args.expiresInSeconds * 1_000)
        } else {
            const expiresInDays = normalizeExpiresInDays(args.expiresInDays)
            expiresAt = expiresInDays
                ? new Date(now.getTime() + expiresInDays * 86_400_000)
                : null
        }

        await db.insert(apiTokens).values({
            id: tokenId,
            userId: args.userId,
            name: args.name,
            tokenHash: hashApiToken(plaintext),
            scopes,
            expiresAt,
            createdAt: now,
            ...(args.tokenKind ? { tokenKind: args.tokenKind } : {})
        })

        return {
            tokenId,
            plaintext,
            expiresAt,
            scopes,
            agentId: null,
            enforceAgentBinding: false,
            createdVia: null
        }
    }

    async mintGrant(args: {
        userId: string
        agentId: string
        scopes: GrantableScope[]
        name?: string
        createdVia: TokenCreatedVia
        enforceAgentBinding: boolean
        replaceExisting: boolean
    }): Promise<MintedApiToken> {
        return this.db.transaction((tx) => this.mintGrantInTx(tx, args))
    }

    async mintGrantInTx(
        tx: ApiTokenGrantTx,
        args: {
            userId: string
            agentId: string
            scopes: GrantableScope[]
            name?: string
            createdVia: TokenCreatedVia
            enforceAgentBinding: boolean
            replaceExisting: boolean
        }
    ): Promise<MintedApiToken> {
        const scopes = normalizeGrantableScopes(args.scopes)
        if (!isTokenCreatedVia(args.createdVia))
            throw new BadRequestException(
                `unsupported createdVia: ${String(args.createdVia)}`
            )

        const [owned] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
                and(
                    eq(agents.id, args.agentId),
                    eq(agents.userId, args.userId)
                )
            )
            .limit(1)
        if (!owned)
            throw new NotFoundException(
                'agent not owned by user or not found'
            )

        const [existing] = await tx
            .select({ id: apiTokens.id })
            .from(apiTokens)
            .where(
                and(
                    eq(apiTokens.agentId, args.agentId),
                    eq(apiTokens.tokenKind, 'user-grant'),
                    isNull(apiTokens.revokedAt)
                )
            )
            .limit(1)

        if (existing) {
            if (!args.replaceExisting) {
                throw new ConflictException(
                    `agent ${args.agentId} already has an active grant; revoke or reauthorize first`
                )
            }
            await tx
                .update(apiTokens)
                .set({ revokedAt: new Date() })
                .where(eq(apiTokens.id, existing.id))
            await this.writeAuditInTx(tx, {
                actorId: args.userId,
                action: auditAction.GRANT_REVOKED,
                subject: existing.id,
                meta: {
                    agentId: args.agentId,
                    reason: 'replaced-by-new-grant'
                }
            })
        }

        const minted = await this.mint(
            {
                userId: args.userId,
                name: args.name ?? `agent grant ${args.agentId}`,
                scopes,
                expiresInDays: undefined
            },
            tx
        )

        await tx
            .update(apiTokens)
            .set({
                agentId: args.agentId,
                enforceAgentBinding: args.enforceAgentBinding,
                createdVia: args.createdVia
            })
            .where(eq(apiTokens.id, minted.tokenId))

        await this.writeAuditInTx(tx, {
            actorId: args.userId,
            action: auditAction.GRANT_MINTED,
            subject: minted.tokenId,
            meta: {
                agentId: args.agentId,
                scopes,
                createdVia: args.createdVia,
                enforceAgentBinding: args.enforceAgentBinding
            }
        })

        // Phase 3c dual-write: the agent's capability set also lands in
        // agent_permissions (one row per agent, UPSERT), the authoritative
        // source once the agent authenticates as agent-runtime (Phase 5b). The
        // legacy api_tokens grant above stays the compat bearer until Phase 8.
        // SET semantics mirror today's replace-grant; the incremental (append)
        // request-permission flow is a separate later path. scopes are already
        // GrantableScope[] (normalized), so api.full/chat.completions cannot
        // appear here by construction (§2.5 write path).
        await tx
            .insert(agentPermissions)
            .values({
                id: createObjectId('agentPermission'),
                agentId: args.agentId,
                userId: args.userId,
                scopes,
                grantedBy: args.userId
            })
            .onConflictDoUpdate({
                target: agentPermissions.agentId,
                set: {
                    scopes,
                    grantedBy: args.userId,
                    updatedAt: new Date()
                }
            })

        return {
            ...minted,
            agentId: args.agentId,
            enforceAgentBinding: args.enforceAgentBinding,
            createdVia: args.createdVia
        }
    }

    async mintA2aGrant(args: {
        userId: string
        targetAgentId: string
        callerAgentId?: string | null
        scopes?: GrantableScope[]
        name?: string
        expiresInDays?: number
        replaceExisting?: boolean
    }): Promise<MintedApiToken> {
        return this.db.transaction((tx) => this.mintA2aGrantInTx(tx, args))
    }

    async mintA2aGrantInTx(
        tx: ApiTokenGrantTx,
        args: {
            userId: string
            targetAgentId: string
            callerAgentId?: string | null
            scopes?: GrantableScope[]
            name?: string
            expiresInDays?: number
            replaceExisting?: boolean
            issueBearer?: boolean
        }
    ): Promise<MintedApiToken> {
        const scopes = normalizeGrantableScopes(
            args.scopes ?? [API_TOKEN_SCOPE_A2A]
        )
        const callerAgentId = args.callerAgentId ?? null

        const [owned] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
                and(
                    eq(agents.id, args.targetAgentId),
                    eq(agents.userId, args.userId)
                )
            )
            .limit(1)
        if (!owned)
            throw new NotFoundException('agent not owned by user or not found')

        if (callerAgentId) {
            const [callerOwned] = await tx
                .select({ id: agents.id })
                .from(agents)
                .where(
                    and(
                        eq(agents.id, callerAgentId),
                        eq(agents.userId, args.userId)
                    )
                )
                .limit(1)
            if (!callerOwned)
                throw new NotFoundException(
                    'caller agent not owned by user or not found'
                )

            const [existing] = await tx
                .select({ id: apiTokens.id })
                .from(apiTokens)
                .where(
                    and(
                        eq(apiTokens.agentId, args.targetAgentId),
                        eq(apiTokens.callerAgentId, callerAgentId),
                        eq(apiTokens.tokenKind, 'a2a-grant'),
                        isNull(apiTokens.revokedAt)
                    )
                )
                .limit(1)
            if (existing) {
                if (!args.replaceExisting)
                    throw new ConflictException(
                        `caller ${callerAgentId} already has an active A2A grant for agent ${args.targetAgentId}`
                    )
                await tx
                    .update(apiTokens)
                    .set({ revokedAt: new Date() })
                    .where(eq(apiTokens.id, existing.id))
                await this.writeAuditInTx(tx, {
                    actorId: args.userId,
                    action: auditAction.GRANT_REVOKED,
                    subject: existing.id,
                    meta: {
                        agentId: args.targetAgentId,
                        callerAgentId,
                        reason: 'replaced-by-new-a2a-grant'
                    }
                })
            }
        }

        const minted =
            args.issueBearer === false
                ? await this.mintBearerlessA2aGrantRecord(tx, {
                      userId: args.userId,
                      name: args.name ?? `a2a grant ${args.targetAgentId}`,
                      scopes,
                      expiresInDays: args.expiresInDays
                  })
                : await this.mint(
                      {
                          userId: args.userId,
                          name: args.name ?? `a2a grant ${args.targetAgentId}`,
                          scopes,
                          expiresInDays: args.expiresInDays
                      },
                      tx
                  )

        await tx
            .update(apiTokens)
            .set({
                agentId: args.targetAgentId,
                callerAgentId,
                enforceAgentBinding: true,
                tokenKind: 'a2a-grant',
                createdVia: 'api'
            })
            .where(eq(apiTokens.id, minted.tokenId))

        await this.writeAuditInTx(tx, {
            actorId: args.userId,
            action: auditAction.GRANT_MINTED,
            subject: minted.tokenId,
            meta: {
                agentId: args.targetAgentId,
                callerAgentId,
                scopes,
                tokenKind: 'a2a-grant'
            }
        })

        // Phase 3c dual-write: the relationship also lands in a2a_agent_grants
        // (the new typed table). Only caller-bound grants move — external
        // (caller-less) a2a tokens stay api_tokens-only (§4.2c). The legacy
        // api_tokens row above remains the compat bearer until Phase 8.
        if (callerAgentId) {
            await tx
                .update(a2aAgentGrants)
                .set({ revokedAt: new Date() })
                .where(
                    and(
                        eq(a2aAgentGrants.callerAgentId, callerAgentId),
                        eq(a2aAgentGrants.targetAgentId, args.targetAgentId),
                        isNull(a2aAgentGrants.revokedAt)
                    )
                )
            await tx.insert(a2aAgentGrants).values({
                id: createObjectId('a2aAgentGrant'),
                callerAgentId,
                targetAgentId: args.targetAgentId,
                userId: args.userId,
                scopes,
                name: args.name ?? null,
                expiresAt: minted.expiresAt ?? null
            })
        }

        return {
            ...minted,
            agentId: args.targetAgentId,
            enforceAgentBinding: true,
            createdVia: 'api'
        }
    }

    // Peer grants are authorization policy, not credentials a user should
    // ever possess. The legacy api_tokens mirror still needs a unique hash for
    // the dual-read transition, but it is derived directly from entropy rather
    // than from a formatted bearer. There is therefore no plaintext token to
    // return, log, or accidentally expose.
    private async mintBearerlessA2aGrantRecord(
        tx: ApiTokenGrantTx,
        args: {
            userId: string
            name: string
            scopes: GrantableScope[]
            expiresInDays?: number
        }
    ): Promise<MintedApiToken> {
        const now = new Date()
        const expiresInDays = normalizeExpiresInDays(args.expiresInDays)
        const expiresAt = expiresInDays
            ? new Date(now.getTime() + expiresInDays * 86_400_000)
            : null
        const tokenId = createObjectId('apiToken')
        const tokenHash = createHash('sha256')
            .update('manyfold-a2a-policy\0')
            .update(randomBytes(TOKEN_BYTES))
            .digest('hex')

        await tx.insert(apiTokens).values({
            id: tokenId,
            userId: args.userId,
            name: args.name,
            tokenHash,
            scopes: args.scopes,
            expiresAt,
            createdAt: now
        })

        return {
            tokenId,
            plaintext: '',
            expiresAt,
            scopes: args.scopes,
            agentId: null,
            enforceAgentBinding: false,
            createdVia: null
        }
    }

    // Authorize several callers for one target atomically (multi-select grant).
    // All-or-nothing: a single conflicting caller rolls the whole batch back
    // unless replaceExisting is set. Always caller-bound, so no plaintext is
    // returned — the runtime bearer is the per-turn ephemeral, not these.
    async mintA2aGrants(args: {
        userId: string
        targetAgentId: string
        callerAgentIds: string[]
        expiresInDays?: number
        replaceExisting?: boolean
    }): Promise<
        Array<{ callerAgentId: string; tokenId: string; expiresAt: Date | null }>
    > {
        const unique = [
            ...new Set(
                args.callerAgentIds.map((id) => id.trim()).filter(Boolean)
            )
        ]
        if (unique.length === 0) return []
        return this.db.transaction(async (tx) => {
            const out: Array<{
                callerAgentId: string
                tokenId: string
                expiresAt: Date | null
            }> = []
            for (const callerAgentId of unique) {
                const minted = await this.mintA2aGrantInTx(tx, {
                    userId: args.userId,
                    targetAgentId: args.targetAgentId,
                    callerAgentId,
                    expiresInDays: args.expiresInDays,
                    replaceExisting: args.replaceExisting ?? false,
                    issueBearer: false
                })
                out.push({
                    callerAgentId,
                    tokenId: minted.tokenId,
                    expiresAt: minted.expiresAt ?? null
                })
            }
            return out
        })
    }

    // External-client fan-out for the A2A Connect flow: one caller-less,
    // bearer-carrying grant per target (isActiveExternalA2aGrant admits
    // exactly one target per token). Targets deleted between approve and poll
    // are skipped rather than failing the batch — their approve-time
    // authorization has nothing left to bind to. Runs inside the caller's
    // poll transaction so the session claim and the mints commit atomically.
    async mintExternalA2aGrantsInTx(
        tx: ApiTokenGrantTx,
        args: {
            userId: string
            targetAgentIds: string[]
            name?: string
            expiresInDays?: number
        }
    ): Promise<
        Array<{
            agentId: string
            agentName: string
            tokenId: string
            plaintext: string
            expiresAt: Date | null
        }>
    > {
        const unique = [
            ...new Set(
                args.targetAgentIds.map((id) => id.trim()).filter(Boolean)
            )
        ]
        if (unique.length === 0) return []
        const owned = await tx
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
                and(inArray(agents.id, unique), eq(agents.userId, args.userId))
            )
        const ownedById = new Map(owned.map((agent) => [agent.id, agent]))
        const out: Array<{
            agentId: string
            agentName: string
            tokenId: string
            plaintext: string
            expiresAt: Date | null
        }> = []
        for (const id of unique) {
            const agent = ownedById.get(id)
            if (!agent) continue
            const minted = await this.mintA2aGrantInTx(tx, {
                userId: args.userId,
                targetAgentId: agent.id,
                name: args.name,
                expiresInDays: args.expiresInDays
            })
            out.push({
                agentId: agent.id,
                agentName: agent.name,
                tokenId: minted.tokenId,
                plaintext: minted.plaintext,
                expiresAt: minted.expiresAt ?? null
            })
        }
        return out
    }

    // Owner-facing list of active A2A grants on a target agent (the policy
    // records, not bearer tokens). Caller name is resolved for the UI.
    async listA2aGrants(
        userId: string,
        targetAgentId: string
    ): Promise<A2aGrantSummary[]> {
        const rows = await this.db
            .select({
                id: apiTokens.id,
                callerAgentId: apiTokens.callerAgentId,
                callerAgentName: agents.name,
                name: apiTokens.name,
                scopes: apiTokens.scopes,
                createdAt: apiTokens.createdAt,
                expiresAt: apiTokens.expiresAt,
                lastUsedAt: apiTokens.lastUsedAt
            })
            .from(apiTokens)
            .leftJoin(agents, eq(agents.id, apiTokens.callerAgentId))
            .where(
                and(
                    eq(apiTokens.userId, userId),
                    eq(apiTokens.agentId, targetAgentId),
                    eq(apiTokens.tokenKind, 'a2a-grant'),
                    isNull(apiTokens.revokedAt)
                )
            )
            .orderBy(desc(apiTokens.createdAt))
        return rows.map((row) => ({
            tokenId: row.id,
            callerAgentId: row.callerAgentId ?? null,
            callerAgentName: row.callerAgentName ?? null,
            name: row.name ?? null,
            scopes: normalizeStoredScopes(row.scopes),
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt?.toISOString() ?? null,
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null
        }))
    }

    // Owner-facing list of a caller agent's outbound A2A grants (the targets it
    // may delegate to). Mirror of listA2aGrants resolved from the caller side,
    // for the agent's own A2A tab. Target name is resolved for the UI.
    async listA2aGrantsForCaller(
        userId: string,
        callerAgentId: string
    ): Promise<A2aOutboundGrantSummary[]> {
        const rows = await this.db
            .select({
                id: apiTokens.id,
                targetAgentId: apiTokens.agentId,
                targetAgentName: agents.name,
                targetExtras: agents.extras,
                scopes: apiTokens.scopes,
                createdAt: apiTokens.createdAt,
                expiresAt: apiTokens.expiresAt,
                lastUsedAt: apiTokens.lastUsedAt
            })
            .from(apiTokens)
            .leftJoin(agents, eq(agents.id, apiTokens.agentId))
            .where(
                and(
                    eq(apiTokens.userId, userId),
                    eq(apiTokens.callerAgentId, callerAgentId),
                    eq(apiTokens.tokenKind, 'a2a-grant'),
                    isNull(apiTokens.revokedAt)
                )
            )
            .orderBy(desc(apiTokens.createdAt))
        return rows.map((row) => ({
            tokenId: row.id,
            targetAgentId: row.targetAgentId ?? '',
            targetAgentName: row.targetAgentName ?? null,
            targetExposed:
                (
                    row.targetExtras as {
                        a2aExposure?: { enabled?: boolean }
                    } | null
                )?.a2aExposure?.enabled === true,
            scopes: normalizeStoredScopes(row.scopes),
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt?.toISOString() ?? null,
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null
        }))
    }

    // The active A2A grant targets a caller agent may delegate to. Backs the
    // agent-self peer listing + token mint; an agent with no grants returns [].
    async listActiveA2aGrantTargetsForCaller(
        callerAgentId: string
    ): Promise<Array<{ userId: string; targetAgentId: string }>> {
        const now = new Date()
        const [legacyRows, freshRows] = await Promise.all([
            this.db
                .select({
                    userId: apiTokens.userId,
                    targetAgentId: apiTokens.agentId
                })
                .from(apiTokens)
                .where(
                    and(
                        eq(apiTokens.callerAgentId, callerAgentId),
                        eq(apiTokens.tokenKind, 'a2a-grant'),
                        isNull(apiTokens.revokedAt),
                        or(
                            isNull(apiTokens.expiresAt),
                            gt(apiTokens.expiresAt, now)
                        )
                    )
                ),
            this.db
                .select({
                    userId: a2aAgentGrants.userId,
                    targetAgentId: a2aAgentGrants.targetAgentId
                })
                .from(a2aAgentGrants)
                .where(
                    and(
                        eq(a2aAgentGrants.callerAgentId, callerAgentId),
                        isNull(a2aAgentGrants.revokedAt),
                        or(
                            isNull(a2aAgentGrants.expiresAt),
                            gt(a2aAgentGrants.expiresAt, now)
                        )
                    )
                )
        ])
        const seen = new Set<string>()
        const out: Array<{ userId: string; targetAgentId: string }> = []
        for (const row of [...legacyRows, ...freshRows]) {
            if (!row.targetAgentId) continue
            const key = `${row.userId}:${row.targetAgentId}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ userId: row.userId, targetAgentId: row.targetAgentId })
        }
        return out
    }

    // Whether a caller still holds an active (non-revoked, non-expired) A2A
    // grant for a specific target. The RPC path re-checks this every call so a
    // revoked grant cuts off existing ephemerals immediately (real-time
    // revoke), not at their TTL.
    async isActiveA2aGrant(
        callerAgentId: string,
        targetAgentId: string
    ): Promise<boolean> {
        const now = new Date()
        const [legacy, fresh] = await Promise.all([
            this.db
                .select({ id: apiTokens.id })
                .from(apiTokens)
                .where(
                    and(
                        eq(apiTokens.callerAgentId, callerAgentId),
                        eq(apiTokens.agentId, targetAgentId),
                        eq(apiTokens.tokenKind, 'a2a-grant'),
                        isNull(apiTokens.revokedAt),
                        or(
                            isNull(apiTokens.expiresAt),
                            gt(apiTokens.expiresAt, now)
                        )
                    )
                )
                .limit(1),
            this.db
                .select({ id: a2aAgentGrants.id })
                .from(a2aAgentGrants)
                .where(
                    and(
                        eq(a2aAgentGrants.callerAgentId, callerAgentId),
                        eq(a2aAgentGrants.targetAgentId, targetAgentId),
                        isNull(a2aAgentGrants.revokedAt),
                        or(
                            isNull(a2aAgentGrants.expiresAt),
                            gt(a2aAgentGrants.expiresAt, now)
                        )
                    )
                )
                .limit(1)
        ])
        return Boolean(legacy[0]) || Boolean(fresh[0])
    }

    // Whether a token is the external-client A2A credential for a specific
    // target: a caller-less `a2a-grant` row bound to that agent by `agent_id`.
    // That row IS the durable per-token target allowlist (one token, one
    // target) — minted by the A2A tab's "External client" flow, revoked from
    // the same callers list. A plain PAT scoped `a2a:edit` has agent_id null /
    // token_kind 'user-grant', so it can never match: the fail-close for
    // unbound tokens is the data shape, not a special case. `api_tokens` only —
    // external grants are deliberately NOT dual-written to a2a_agent_grants
    // (§4.2c: no caller agent to key them by).
    async isActiveExternalA2aGrant(
        tokenId: string,
        targetAgentId: string
    ): Promise<boolean> {
        const now = new Date()
        const [row] = await this.db
            .select({ id: apiTokens.id })
            .from(apiTokens)
            .where(
                and(
                    eq(apiTokens.id, tokenId),
                    eq(apiTokens.agentId, targetAgentId),
                    isNull(apiTokens.callerAgentId),
                    eq(apiTokens.tokenKind, 'a2a-grant'),
                    isNull(apiTokens.revokedAt),
                    or(
                        isNull(apiTokens.expiresAt),
                        gt(apiTokens.expiresAt, now)
                    )
                )
            )
            .limit(1)
        return Boolean(row)
    }

    async verify(plaintext: string): Promise<AuthPrincipal> {
        if (!isApiToken(plaintext))
            throw new UnauthorizedException('invalid api token prefix')

        const hash = hashApiToken(plaintext)
        const [runtimeRows, apiRows] = await Promise.all([
            this.db
                .select({
                    id: agentRuntimeTokens.id,
                    userId: agentRuntimeTokens.userId,
                    agentId: agentRuntimeTokens.agentId,
                    expiresAt: agentRuntimeTokens.expiresAt,
                    revokedAt: agentRuntimeTokens.revokedAt,
                    email: users.email,
                    deactivatedAt: users.deactivatedAt
                })
                .from(agentRuntimeTokens)
                .innerJoin(users, eq(agentRuntimeTokens.userId, users.id))
                .where(eq(agentRuntimeTokens.tokenHash, hash))
                .limit(1),
            this.db
                .select({
                    id: apiTokens.id,
                    userId: apiTokens.userId,
                    agentId: apiTokens.agentId,
                    callerAgentId: apiTokens.callerAgentId,
                    scopes: apiTokens.scopes,
                    enforceAgentBinding: apiTokens.enforceAgentBinding,
                    createdVia: apiTokens.createdVia,
                    tokenKind: apiTokens.tokenKind,
                    expiresAt: apiTokens.expiresAt,
                    revokedAt: apiTokens.revokedAt,
                    email: users.email,
                    deactivatedAt: users.deactivatedAt
                })
                .from(apiTokens)
                .innerJoin(users, eq(apiTokens.userId, users.id))
                .where(eq(apiTokens.tokenHash, hash))
                .limit(1)
        ])

        const runtimeRow = runtimeRows[0]
        const apiRow = apiRows[0]
        // Phase 3a's DB invariant makes this unreachable; assert it anyway so a
        // corrupted store fails loud instead of silently picking a table.
        if (runtimeRow && apiRow)
            throw new InternalServerErrorException(
                'token hash resolved in both credential tables'
            )

        if (runtimeRow) {
            // ADR-0023: a deletion-pending account's agents stop acting.
            if (runtimeRow.deactivatedAt)
                throw new UnauthorizedException('account deactivated')
            if (runtimeRow.revokedAt)
                throw new UnauthorizedException('api token revoked')
            if (runtimeRow.expiresAt && runtimeRow.expiresAt < new Date())
                throw new UnauthorizedException('api token expired')
            await this.db
                .update(agentRuntimeTokens)
                .set({ lastUsedAt: new Date() })
                .where(eq(agentRuntimeTokens.id, runtimeRow.id))
            // Identity only — authorization is resolved per request from
            // agent_permissions (auth.guard). The principal carries no scopes
            // or enforcement: those fields don't exist on the agent-runtime arm.
            return {
                userId: runtimeRow.userId,
                email: runtimeRow.email,
                kind: 'agent-runtime',
                agentId: runtimeRow.agentId,
                runtimeTokenId: runtimeRow.id
            }
        }

        if (!apiRow) throw new UnauthorizedException('api token not found')
        if (apiRow.deactivatedAt)
            throw new UnauthorizedException('account deactivated')
        if (apiRow.revokedAt)
            throw new UnauthorizedException('api token revoked')
        if (apiRow.expiresAt && apiRow.expiresAt < new Date())
            throw new UnauthorizedException('api token expired')

        // Data-integrity invariant (no DB CHECK enforces it): a row may not
        // claim enforce_agent_binding=true without an agent_id. Fail loud here —
        // the union below would otherwise silently classify it as a plain PAT.
        if (apiRow.enforceAgentBinding && !apiRow.agentId)
            throw new UnauthorizedException(
                'bound token has enforce_agent_binding=true but no agent_id'
            )

        const scopes = normalizeStoredScopes(apiRow.scopes)
        const createdVia = isTokenCreatedVia(apiRow.createdVia)
            ? apiRow.createdVia
            : null
        await this.db
            .update(apiTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiTokens.id, apiRow.id))

        return apiRow.agentId
            ? {
                  userId: apiRow.userId,
                  email: apiRow.email,
                  kind: 'legacy-runtime',
                  agentId: apiRow.agentId,
                  tokenId: apiRow.id,
                  scopes,
                  callerAgentId: apiRow.callerAgentId,
                  enforceAgentBinding: apiRow.enforceAgentBinding,
                  createdVia,
                  tokenKind: apiRow.tokenKind
              }
            : {
                  userId: apiRow.userId,
                  email: apiRow.email,
                  kind: 'human-api-token',
                  tokenId: apiRow.id,
                  scopes
              }
    }

    async listForUser(
        userId: string,
        opts: { agentId?: string; includeGrants?: boolean } = {}
    ): Promise<ApiTokenSummary[]> {
        // a2a-ephemeral tokens are per-turn delegation bearers and terminal
        // tokens are ephemeral session credentials — both are internal
        // machinery, never surfaced in any user-facing token list.
        const filters = [
            eq(apiTokens.userId, userId),
            notInArray(apiTokens.tokenKind, ['a2a-ephemeral', 'terminal'])
        ]
        if (opts.agentId) {
            // agentId filter is the strongest signal: caller wants this agent's
            // grants specifically. Implicitly includes grants and skips the
            // "agent_id IS NULL" default-hide.
            filters.push(eq(apiTokens.agentId, opts.agentId))
        } else if (!opts.includeGrants) {
            // Default: hide grant tokens from the personal PAT list.
            filters.push(isNull(apiTokens.agentId))
        }
        const rows = await this.db
            .select({
                id: apiTokens.id,
                name: apiTokens.name,
                scopes: apiTokens.scopes,
                agentId: apiTokens.agentId,
                enforceAgentBinding: apiTokens.enforceAgentBinding,
                createdVia: apiTokens.createdVia,
                lastUsedAt: apiTokens.lastUsedAt,
                expiresAt: apiTokens.expiresAt,
                revokedAt: apiTokens.revokedAt,
                createdAt: apiTokens.createdAt
            })
            .from(apiTokens)
            .where(filters.length === 1 ? filters[0] : and(...filters))
            .orderBy(desc(apiTokens.createdAt))

        return rows.map(apiTokenSummaryFromRow)
    }

    async revoke(args: { tokenId: string; userId: string }): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [row] = await tx
                .select({
                    id: apiTokens.id,
                    agentId: apiTokens.agentId,
                    revokedAt: apiTokens.revokedAt
                })
                .from(apiTokens)
                .where(
                    and(
                        eq(apiTokens.id, args.tokenId),
                        eq(apiTokens.userId, args.userId)
                    )
                )
                .limit(1)
            if (!row) return
            await tx
                .update(apiTokens)
                .set({ revokedAt: new Date() })
                .where(eq(apiTokens.id, row.id))
            // Audit only grant tokens — personal PAT revokes are noisy and
            // already visible in the user's settings audit trail elsewhere.
            if (row.agentId && !row.revokedAt) {
                await this.writeAuditInTx(tx, {
                    actorId: args.userId,
                    action: auditAction.GRANT_REVOKED,
                    subject: row.id,
                    meta: { agentId: row.agentId, reason: 'user-revoke' }
                })
            }
        })
    }

    async revokeA2aGrant(args: {
        tokenId: string
        userId: string
        targetAgentId: string
    }): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [row] = await tx
                .select({
                    id: apiTokens.id,
                    callerAgentId: apiTokens.callerAgentId
                })
                .from(apiTokens)
                .where(
                    and(
                        eq(apiTokens.id, args.tokenId),
                        eq(apiTokens.userId, args.userId),
                        eq(apiTokens.agentId, args.targetAgentId),
                        eq(apiTokens.tokenKind, 'a2a-grant'),
                        isNull(apiTokens.revokedAt)
                    )
                )
                .limit(1)
            if (!row) return
            const revokedAt = new Date()
            await tx
                .update(apiTokens)
                .set({ revokedAt })
                .where(eq(apiTokens.id, row.id))
            if (row.callerAgentId) {
                await tx
                    .update(a2aAgentGrants)
                    .set({ revokedAt })
                    .where(
                        and(
                            eq(a2aAgentGrants.userId, args.userId),
                            eq(
                                a2aAgentGrants.targetAgentId,
                                args.targetAgentId
                            ),
                            eq(a2aAgentGrants.callerAgentId, row.callerAgentId),
                            isNull(a2aAgentGrants.revokedAt)
                        )
                    )
            }
            await this.writeAuditInTx(tx, {
                actorId: args.userId,
                action: auditAction.GRANT_REVOKED,
                subject: row.id,
                meta: {
                    agentId: args.targetAgentId,
                    callerAgentId: row.callerAgentId,
                    reason: 'user-revoke'
                }
            })
        })
    }

    // Hard-delete a token and its shared credential. For ephemeral session
    // tokens (e.g. terminal) a soft-revoke would pile up dead rows forever;
    // deleting the token_credentials parent cascades to api_tokens (FK
    // on_delete cascade), leaving no orphan in either table. Scoped to the
    // owning user so a tokenId alone can't drop someone else's credential.
    async hardDelete(args: { tokenId: string; userId: string }): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [row] = await tx
                .select({ tokenHash: apiTokens.tokenHash })
                .from(apiTokens)
                .where(
                    and(
                        eq(apiTokens.id, args.tokenId),
                        eq(apiTokens.userId, args.userId)
                    )
                )
                .limit(1)
            if (!row) return
            await tx
                .delete(tokenCredentials)
                .where(eq(tokenCredentials.tokenHash, row.tokenHash))
        })
    }

    // Terminal tokens are hard-deleted on session close; this sweeps the tail
    // the close path can miss (process crash, lost WS) plus legacy rows minted
    // before hard-delete existed (kind 'user-grant', name 'terminal …', already
    // soft-revoked). Deletes by the shared credential hash so the cascade clears
    // api_tokens too. Terminal-kind rows only go once expired (the TTL already
    // makes them unusable); legacy rows only once revoked (already dead) — so a
    // live session is never cut off here.
    @Cron(CronExpression.EVERY_HOUR, { name: 'ephemeral-token-reaper' })
    async reapEphemeralTokens(): Promise<void> {
        const now = new Date()
        const stale = this.db
            .select({ tokenHash: apiTokens.tokenHash })
            .from(apiTokens)
            .where(
                or(
                    and(
                        eq(apiTokens.tokenKind, 'terminal'),
                        isNotNull(apiTokens.expiresAt),
                        lt(apiTokens.expiresAt, now)
                    ),
                    and(
                        like(apiTokens.name, 'terminal %'),
                        isNull(apiTokens.agentId),
                        isNotNull(apiTokens.revokedAt)
                    )
                )
            )
        const deleted = await this.db
            .delete(tokenCredentials)
            .where(inArray(tokenCredentials.tokenHash, stale))
            .returning({ tokenHash: tokenCredentials.tokenHash })
        if (deleted.length > 0)
            this.log.log(
                `reaped ${deleted.length} ephemeral terminal token(s)`
            )
    }

    private async writeAuditInTx(
        tx: Pick<Database, 'insert'>,
        entry: {
            actorId: string
            action: string
            subject: string
            meta: Record<string, unknown>
        }
    ): Promise<void> {
        try {
            await tx.insert(auditLogs).values({
                id: randomUUID(),
                actorId: entry.actorId,
                action: entry.action,
                subject: entry.subject,
                meta: entry.meta
            })
        } catch (error) {
            // Audit failures must not break grant lifecycle. Log + swallow.
            this.log.warn(
                `failed to write audit_logs for ${entry.action}/${entry.subject}: ${(error as Error).message}`
            )
        }
    }
}

export const isApiToken = (value: string): boolean =>
    value.startsWith(API_TOKEN_PREFIX)

// Runtime identity tokens (agent_runtime_tokens). isApiToken() also matches
// these (the prefix extends API_TOKEN_PREFIX); this narrows to the runtime kind
// for prefix-level routing such as the OpenAI surface early-reject (§5.6).
export const isRuntimeToken = (value: string): boolean =>
    value.startsWith(RUNTIME_TOKEN_PREFIX)

// External api/grant token plaintext, guaranteed never to collide with the
// runtime prefix so the discriminator stays unambiguous.
const generateApiTokenPlaintext = (): string => {
    let plaintext: string
    do {
        plaintext = `${API_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString(
            'base64url'
        )}`
    } while (isRuntimeToken(plaintext))
    return plaintext
}

export const hashApiToken = (plaintext: string): string =>
    createHash('sha256').update(plaintext).digest('hex')

export const apiTokenHasScope = (
    auth: AuthPrincipal,
    scope: ApiTokenScope
): boolean => {
    const scopes = principalScopes(auth)
    return scopes.includes(API_TOKEN_SCOPE_FULL) || scopes.includes(scope)
}

export const normalizeApiTokenScopes = (
    scopes: unknown = [API_TOKEN_SCOPE_CHAT_COMPLETIONS]
): ApiTokenScope[] => {
    if (!Array.isArray(scopes) || scopes.length === 0)
        throw new BadRequestException('scopes must be a non-empty array')

    const unique: ApiTokenScope[] = []
    for (const scope of scopes) {
        if (!isApiTokenScope(scope)) {
            throw new BadRequestException(
                `unsupported api token scope: ${String(scope)}`
            )
        }
        if (!unique.includes(scope)) unique.push(scope)
    }
    return unique
}

export const normalizeGrantableScopes = (
    scopes: unknown
): GrantableScope[] => {
    if (!Array.isArray(scopes) || scopes.length === 0)
        throw new BadRequestException(
            'grantable scopes must be a non-empty array'
        )

    const unique: GrantableScope[] = []
    for (const scope of scopes) {
        if (!isGrantableScope(scope)) {
            throw new BadRequestException(
                `unsupported grantable scope: ${String(scope)}`
            )
        }
        if (!unique.includes(scope)) unique.push(scope)
    }
    return unique
}

export const normalizeExpiresInDays = (
    expiresInDays?: unknown
): number | undefined => {
    if (expiresInDays === undefined || expiresInDays === null) return undefined
    if (
        typeof expiresInDays !== 'number' ||
        !Number.isInteger(expiresInDays) ||
        expiresInDays <= 0
    )
        throw new BadRequestException(
            'expiresInDays must be a positive integer'
        )
    return expiresInDays
}

// Deny-by-default: empty/garbage stored scopes resolve to [] (no access), not
// [api.full]. A legitimately-minted token always persists a non-empty valid
// scope set (mint enforces it), so [] only surfaces for corrupt/empty rows —
// those must fail closed, not silently inherit full access (M-sec-1).
export const normalizeStoredScopes = (scopes: unknown): ApiTokenScope[] => {
    if (!Array.isArray(scopes) || scopes.length === 0) return []

    const valid = scopes.filter(isApiTokenScope)
    return valid.length > 0 ? normalizeApiTokenScopes(valid) : []
}

type ApiTokenSummaryRow = {
    id: string
    name: string
    scopes: unknown
    agentId?: string | null
    enforceAgentBinding?: boolean
    createdVia?: string | null
    lastUsedAt: Date | null
    expiresAt: Date | null
    revokedAt: Date | null
    createdAt: Date
}

export const apiTokenSummaryFromRow = (
    row: ApiTokenSummaryRow
): ApiTokenSummary => ({
    id: row.id,
    name: row.name,
    scopes: normalizeStoredScopes(row.scopes),
    agentId: row.agentId ?? null,
    enforceAgentBinding: row.enforceAgentBinding ?? false,
    createdVia: isTokenCreatedVia(row.createdVia) ? row.createdVia : null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
})
