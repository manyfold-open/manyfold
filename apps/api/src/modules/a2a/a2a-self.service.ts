import type {
    A2aExposure,
    A2aGrantSummary,
    A2aSelfCallerAddResponse,
    A2aSelfExposure,
    A2aSelfPeer,
    A2aSelfPeerToken,
    AddA2aSelfCallerBody
} from '@manyfold/shared'
import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { ApiTokenService } from '@/modules/auth/api-token.service'
import { A2aTicketService } from './a2a-ticket.service'

// Backs the agent-self A2A endpoints: the caller runtime asks the platform, in
// real time, which peers it may call and for a fresh bearer per call. This
// replaces the MF_A2A_PEERS env snapshot as the single source of truth (the
// active grant in the DB).
@Injectable()
export class A2aSelfService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly tokens: ApiTokenService,
        private readonly tickets: A2aTicketService,
        @Optional() private readonly config?: ConfigService
    ) {}

    private apiUrl(): string {
        const base = this.config?.get<string>('PUBLIC_API_BASE_URL')?.trim()
        if (!base)
            throw new Error('PUBLIC_API_BASE_URL not configured')
        return publicApiUrlWithApiPrefix(base)
    }

    private exposureOf(extras: unknown): A2aExposure | undefined {
        return (extras as { a2aExposure?: A2aExposure } | null)?.a2aExposure
    }

    private agentUrls(agentId: string): {
        cardUrl: string
        rpcUrl: string
    } {
        const apiUrl = this.apiUrl()
        return {
            cardUrl: `${apiUrl}/a2a/agents/${agentId}/agent-card.json`,
            rpcUrl: `${apiUrl}/a2a/agents/${agentId}/rpc`
        }
    }

    exposureView(agentId: string, exposure: A2aExposure): A2aSelfExposure {
        return {
            ...exposure,
            agentId,
            ...this.agentUrls(agentId)
        }
    }

    listCallers(
        userId: string,
        targetAgentId: string
    ): Promise<A2aGrantSummary[]> {
        return this.tokens.listA2aGrants(userId, targetAgentId)
    }

    async addCaller(
        userId: string,
        targetAgentId: string,
        body: AddA2aSelfCallerBody
    ): Promise<A2aSelfCallerAddResponse> {
        if (body.kind === 'external') {
            const minted = await this.tokens.mintA2aGrant({
                userId,
                targetAgentId,
                name: body.name,
                expiresInDays: body.expiresInDays
            })
            return {
                kind: 'external',
                agentId: targetAgentId,
                token: minted.plaintext,
                tokenId: minted.tokenId,
                scopes: minted.scopes,
                callerAgentId: null,
                expiresAt: minted.expiresAt
                    ? minted.expiresAt.toISOString()
                    : null,
                ...this.agentUrls(targetAgentId)
            }
        }
        const [minted] = await this.tokens.mintA2aGrants({
            userId,
            targetAgentId,
            callerAgentIds: [body.callerAgentId],
            expiresInDays: body.expiresInDays,
            replaceExisting: body.replaceExisting
        })
        if (!minted) throw new Error('failed to create A2A peer grant')
        return {
            kind: 'peer',
            agentId: targetAgentId,
            callerAgentId: minted.callerAgentId,
            tokenId: minted.tokenId,
            expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null
        }
    }

    revokeCaller(
        userId: string,
        targetAgentId: string,
        tokenId: string
    ): Promise<void> {
        return this.tokens.revokeA2aGrant({
            userId,
            targetAgentId,
            tokenId
        })
    }

    async listPeers(callerAgentId: string): Promise<A2aSelfPeer[]> {
        const grants =
            await this.tokens.listActiveA2aGrantTargetsForCaller(callerAgentId)
        if (grants.length === 0) return []
        const apiUrl = this.apiUrl()
        const peers: A2aSelfPeer[] = []
        for (const grant of grants) {
            const [target] = await this.db
                .select({ name: agents.name, extras: agents.extras })
                .from(agents)
                .where(eq(agents.id, grant.targetAgentId))
                .limit(1)
            if (!target || !this.exposureOf(target.extras)?.enabled) continue
            peers.push({
                agentId: grant.targetAgentId,
                name: target.name,
                cardUrl: `${apiUrl}/a2a/agents/${grant.targetAgentId}/agent-card.json`,
                rpcUrl: `${apiUrl}/a2a/agents/${grant.targetAgentId}/rpc`
            })
        }
        return peers
    }

    async mintPeerToken(
        callerAgentId: string,
        targetAgentId: string
    ): Promise<A2aSelfPeerToken> {
        const grants =
            await this.tokens.listActiveA2aGrantTargetsForCaller(callerAgentId)
        const grant = grants.find((g) => g.targetAgentId === targetAgentId)
        if (!grant)
            throw new ForbiddenException('no active A2A grant for this peer')
        const [target] = await this.db
            .select({ extras: agents.extras })
            .from(agents)
            .where(eq(agents.id, targetAgentId))
            .limit(1)
        if (!target || !this.exposureOf(target.extras)?.enabled)
            throw new NotFoundException('peer not found')
        const { ticket, exp } = this.tickets.sign({
            callerAgentId,
            targetAgentId,
            userId: grant.userId
        })
        return {
            token: ticket,
            rpcUrl: `${this.apiUrl()}/a2a/agents/${targetAgentId}/rpc`,
            expiresAt: new Date(exp).toISOString()
        }
    }
}
