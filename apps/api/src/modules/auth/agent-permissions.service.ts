import { DEFAULT_WEB_BASE_URL } from '@/common/brand'
import {
    AgentPermissionsResponse,
    DenyPermissionResponse,
    GrantableScope,
    PermissionConsentPreview,
    PermissionConsentStatus,
    RequestPermissionResponse,
    auditAction,
    createObjectId,
    grantableScopes,
    isGrantableScope,
    scopeMetadata
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    GoneException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, sql } from 'drizzle-orm'
import {
    agentPermissions,
    agents,
    auditLogs,
    permissionConsentRequests,
    type Database,
    type PermissionConsentRequest
} from '@manyfold/db'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { DRIZZLE } from '@/db/tokens'
import { configString } from '@/common/config-alias'

interface StatefulConsentToken {
    id: string
    v: 2
}

interface ConsentPayload {
    id: string
    agentId: string
    scopes: GrantableScope[]
    exp: number
}

interface ResolvedConsent {
    payload: ConsentPayload
    record: PermissionConsentRequest
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Executor = Database | Tx

const CONSENT_TTL_MS = 60 * 60 * 1000

// §7.3 incremental permission requests. An agent already holds its injected
// runtime identity; when it lacks a scope it asks for exactly that scope and
// posts the consent URL to its owner. Approval APPENDS to agent_permissions and
// mints NO bearer — the identity authenticates and verify() re-reads scopes
// live, so the agent's next call just succeeds. The consent URL carries only a
// server-encrypted {id, v: 2} reference (AES-256-GCM via API_CRYPTO_KEY); the
// permission_consent_requests row is authoritative for agent, scopes, expiry,
// and terminal state. Omitting the legacy claims is deliberate rolling-deploy
// safety: an older API rejects a v2 token instead of granting it statelessly.
// Approve and deny claim the row with a conditional UPDATE, so replaying the
// URL reports the decision instead of re-offering it.
@Injectable()
export class AgentPermissionsService {
    private readonly log = new Logger(AgentPermissionsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly config: ConfigService
    ) {}

    async createRequest(args: {
        agentId: string
        scopes: GrantableScope[]
    }): Promise<RequestPermissionResponse> {
        const scopes = this.validateScopes(args.scopes)
        const exp = Date.now() + CONSENT_TTL_MS
        const id = createObjectId('permissionConsentRequest')
        await this.db.insert(permissionConsentRequests).values({
            id,
            agentId: args.agentId,
            requestedScopes: scopes,
            expiresAt: new Date(exp)
        })
        const token = this.sign({ id, v: 2 })
        const url = new URL('/grant-permission', this.webUrl())
        url.searchParams.set('token', token)
        return {
            consentUrl: url.toString(),
            scopes,
            expiresAt: new Date(exp).toISOString()
        }
    }

    // Decodes WITHOUT enforcing expiry so a request that was already answered
    // still reports its decision hours later — the consent card lives in chat
    // history and gets re-rendered long after the token's hour is up. Expiry
    // only blocks a request that is still pending (nothing left to report).
    async previewConsent(
        token: string,
        approverUserId: string
    ): Promise<PermissionConsentPreview> {
        const { payload, record } = await this.resolve(token)
        const agent = await this.assertOwned(payload.agentId, approverUserId)
        const status = record.status
        if (status === 'pending') this.assertUnexpired(payload)
        return {
            agentId: payload.agentId,
            agentName: agent.name,
            scopes: payload.scopes.map((scope) => {
                const meta = scopeMetadata.find((m) => m.scope === scope)
                return {
                    scope,
                    summary: meta?.summary ?? scope,
                    danger: meta?.danger ?? 'high'
                }
            }),
            expiresAt: new Date(payload.exp).toISOString(),
            status,
            approvedScopes: (record.approvedScopes ?? []).filter(
                isGrantableScope
            ),
            resolvedAt: record.resolvedAt?.toISOString() ?? null
        }
    }

    async grantConsent(args: {
        token: string
        approverUserId: string
        approvedScopes: GrantableScope[]
    }): Promise<AgentPermissionsResponse> {
        const payload = await this.verify(args.token)
        await this.assertOwned(payload.agentId, args.approverUserId)
        const requested = new Set(payload.scopes)
        const approved = this.validateScopes(args.approvedScopes).filter((s) =>
            requested.has(s)
        )
        if (approved.length === 0)
            throw new BadRequestException(
                'approvedScopes must be a non-empty subset of the requested scopes'
            )
        // One transaction so a claimed request always has its scopes appended:
        // marking the request approved while the append fails would tell the
        // owner it landed and leave the agent without the capability.
        const scopes = await this.db.transaction(async (tx) => {
            await this.claim(tx, payload.id, {
                status: 'approved',
                approvedScopes: approved,
                approverUserId: args.approverUserId
            })
            return this.append(
                tx,
                payload.agentId,
                args.approverUserId,
                approved
            )
        })
        await this.audit(
            auditAction.PERMISSION_GRANTED,
            args.approverUserId,
            payload.agentId,
            { approved, requested: payload.scopes }
        )
        const [row] = await this.db
            .select({ updatedAt: agentPermissions.updatedAt })
            .from(agentPermissions)
            .where(eq(agentPermissions.agentId, payload.agentId))
            .limit(1)
        return {
            agentId: payload.agentId,
            scopes,
            updatedAt: row?.updatedAt?.toISOString() ?? null
        }
    }

    // Records the refusal so the consent surface stops offering the request.
    // Grants nothing — the agent keeps exactly the scopes it already had.
    async denyConsent(args: {
        token: string
        approverUserId: string
    }): Promise<DenyPermissionResponse> {
        const payload = await this.verify(args.token)
        await this.assertOwned(payload.agentId, args.approverUserId)
        const resolvedAt = new Date()
        await this.claim(this.db, payload.id, {
            status: 'denied',
            approvedScopes: null,
            approverUserId: args.approverUserId,
            resolvedAt
        })
        await this.audit(
            auditAction.PERMISSION_DENIED,
            args.approverUserId,
            payload.agentId,
            { requested: payload.scopes }
        )
        return {
            agentId: payload.agentId,
            status: 'denied',
            resolvedAt: resolvedAt.toISOString()
        }
    }

    // Owner-direct read. Returns the current capability list for an agent the
    // caller owns (empty list + null updatedAt when no row exists yet).
    async listForOwner(
        agentId: string,
        userId: string
    ): Promise<AgentPermissionsResponse> {
        await this.assertOwned(agentId, userId)
        const [row] = await this.db
            .select({
                scopes: agentPermissions.scopes,
                updatedAt: agentPermissions.updatedAt
            })
            .from(agentPermissions)
            .where(eq(agentPermissions.agentId, agentId))
            .limit(1)
        const stored = Array.isArray(row?.scopes) ? row.scopes : []
        return {
            agentId,
            scopes: stored.filter(isGrantableScope),
            updatedAt: row?.updatedAt?.toISOString() ?? null
        }
    }

    // Owner-direct add. Appends the given scopes (union) to the agent's
    // capability list and mints NO bearer — the runtime identity reads the new
    // list on its next call. api.full/chat.completions are rejected here.
    async addForOwner(
        agentId: string,
        userId: string,
        rawScopes: GrantableScope[]
    ): Promise<AgentPermissionsResponse> {
        await this.assertOwned(agentId, userId)
        const scopes = this.validateScopes(rawScopes)
        const stored = await this.append(this.db, agentId, userId, scopes)
        await this.audit(auditAction.PERMISSION_GRANTED, userId, agentId, {
            added: scopes
        })
        return this.respond(agentId, stored)
    }

    // Owner-direct remove. Atomic set-difference on the stored scope list (drops
    // the given scopes in ONE statement so racing edits can't resurrect a
    // removed scope). No row → no-op returning an empty list.
    async removeForOwner(
        agentId: string,
        userId: string,
        rawScopes: GrantableScope[]
    ): Promise<AgentPermissionsResponse> {
        await this.assertOwned(agentId, userId)
        const scopes = this.validateScopes(rawScopes)
        const removed = JSON.stringify(scopes)
        await this.db
            .update(agentPermissions)
            .set({
                scopes: sql`(select coalesce(jsonb_agg(elem), '[]'::jsonb) from jsonb_array_elements(${agentPermissions.scopes}) as elem where not (${removed}::jsonb @> jsonb_build_array(elem)))`,
                grantedBy: userId,
                updatedAt: new Date()
            })
            .where(eq(agentPermissions.agentId, agentId))
        const [row] = await this.db
            .select({ scopes: agentPermissions.scopes })
            .from(agentPermissions)
            .where(eq(agentPermissions.agentId, agentId))
            .limit(1)
        const stored = Array.isArray(row?.scopes) ? row.scopes : []
        const remaining = stored.filter(isGrantableScope)
        await this.audit(auditAction.PERMISSION_REVOKED, userId, agentId, {
            removed: scopes
        })
        return this.respond(agentId, remaining)
    }

    private async respond(
        agentId: string,
        scopes: GrantableScope[]
    ): Promise<AgentPermissionsResponse> {
        const [row] = await this.db
            .select({ updatedAt: agentPermissions.updatedAt })
            .from(agentPermissions)
            .where(eq(agentPermissions.agentId, agentId))
            .limit(1)
        return {
            agentId,
            scopes,
            updatedAt: row?.updatedAt?.toISOString() ?? null
        }
    }

    private async loadRequest(
        id: string
    ): Promise<PermissionConsentRequest | null> {
        const [row] = await this.db
            .select()
            .from(permissionConsentRequests)
            .where(eq(permissionConsentRequests.id, id))
            .limit(1)
        return row ?? null
    }

    // Conditional UPDATE on status='pending' — the whole point of the row. Two
    // approvals racing (double click, two tabs) mean exactly one claims it and
    // the loser gets 410 instead of silently re-granting.
    private async claim(
        exec: Executor,
        id: string,
        args: {
            status: Exclude<PermissionConsentStatus, 'pending'>
            approvedScopes: GrantableScope[] | null
            approverUserId: string
            resolvedAt?: Date
        }
    ): Promise<void> {
        const [claimed] = await exec
            .update(permissionConsentRequests)
            .set({
                status: args.status,
                approvedScopes: args.approvedScopes,
                resolvedBy: args.approverUserId,
                resolvedAt: args.resolvedAt ?? new Date()
            })
            .where(
                and(
                    eq(permissionConsentRequests.id, id),
                    eq(permissionConsentRequests.status, 'pending')
                )
            )
            .returning({ id: permissionConsentRequests.id })
        if (!claimed)
            throw new GoneException(
                'this permission request was already handled'
            )
    }

    // Atomic append: union the stored scopes with the approved ones in ONE
    // statement so racing approvals can't lose scopes (read-then-write would).
    // api.full/chat.completions can never enter (validateScopes rejects them).
    private async append(
        exec: Executor,
        agentId: string,
        userId: string,
        scopes: GrantableScope[]
    ): Promise<GrantableScope[]> {
        const [row] = await exec
            .insert(agentPermissions)
            .values({
                id: createObjectId('agentPermission'),
                agentId,
                userId,
                scopes,
                grantedBy: userId
            })
            .onConflictDoUpdate({
                target: agentPermissions.agentId,
                set: {
                    scopes: sql`(select coalesce(jsonb_agg(distinct elem), '[]'::jsonb) from jsonb_array_elements(${agentPermissions.scopes} || excluded.scopes) as elem)`,
                    grantedBy: userId,
                    updatedAt: new Date()
                }
            })
            .returning({ scopes: agentPermissions.scopes })
        const stored = Array.isArray(row?.scopes) ? row.scopes : []
        return stored.filter(isGrantableScope)
    }

    private async assertOwned(
        agentId: string,
        userId: string
    ): Promise<{ name: string }> {
        const [owned] = await this.db
            .select({ name: agents.name })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        if (!owned)
            throw new NotFoundException('agent not owned by user or not found')
        return owned
    }

    private validateScopes(raw: GrantableScope[]): GrantableScope[] {
        const allowed = grantableScopes as readonly string[]
        const clean: GrantableScope[] = []
        for (const s of raw ?? []) {
            if (typeof s !== 'string' || !allowed.includes(s))
                throw new BadRequestException(
                    `unsupported grantable scope: ${String(s)}`
                )
            if (!clean.includes(s as GrantableScope))
                clean.push(s as GrantableScope)
        }
        if (clean.length === 0)
            throw new BadRequestException(
                'scopes must be a non-empty list of grantable scopes'
            )
        return clean
    }

    private async audit(
        action: string,
        userId: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId: `user:${userId}`,
                action,
                subject,
                meta: { userId, ...meta }
            })
        } catch (error) {
            this.log.warn(
                `failed to write audit ${action}: ${(error as Error).message}`
            )
        }
    }

    private sign(payload: StatefulConsentToken): string {
        const enc = this.crypto.encrypt(JSON.stringify(payload))
        return Buffer.from(JSON.stringify(enc)).toString('base64url')
    }

    private async verify(token: string): Promise<ConsentPayload> {
        const { payload } = await this.resolve(token)
        this.assertUnexpired(payload)
        return payload
    }

    private async resolve(token: string): Promise<ResolvedConsent> {
        const decoded = this.decode(token)
        const record = await this.loadRequest(decoded.id)
        if (!record)
            throw new BadRequestException(
                'consent request does not exist or is no longer available'
            )
        const scopes = this.validateScopes(
            record.requestedScopes as GrantableScope[]
        )
        const exp = record.expiresAt.getTime()
        if (!Number.isFinite(exp))
            throw new BadRequestException('invalid consent request expiry')
        return {
            payload: {
                id: record.id,
                agentId: record.agentId,
                scopes,
                exp
            },
            record
        }
    }

    private decode(token: string): StatefulConsentToken {
        let payload: unknown
        try {
            const enc = JSON.parse(
                Buffer.from(token, 'base64url').toString('utf8')
            )
            payload = JSON.parse(this.crypto.decrypt(enc)) as unknown
        } catch {
            throw new BadRequestException('invalid or corrupt consent token')
        }
        if (
            payload &&
            typeof payload === 'object' &&
            'v' in payload &&
            payload.v === 2 &&
            'id' in payload &&
            typeof payload.id === 'string'
        )
            return payload as StatefulConsentToken
        throw new BadRequestException('invalid consent token payload')
    }

    private assertUnexpired(payload: ConsentPayload): void {
        if (Date.now() > payload.exp)
            throw new BadRequestException('consent request has expired')
    }

    private webUrl(): string {
        const raw =
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        return raw.replace(/\/+$/, '')
    }
}
