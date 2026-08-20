import {
    AgentConnectionInfo,
    CloudflareConnectionResourcesResponse,
    ComposioConnectionToolsResponse,
    ConnectionProvider,
    CreateCloudflareConnectionBody,
    CreateCloudflareConnectionResult,
    CreateComposioConnectionBody,
    GithubConnectionReposResponse,
    GithubConnectionStartResponse,
    UserConnectionSummary,
    createObjectId
} from '@manyfold/shared'
import { createHash } from 'node:crypto'
import {
    BadGatewayException,
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
    agents,
    userConnections,
    type Database,
    type NewUserConnectionRow,
    type UserConnectionRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { CloudflareService } from '@/modules/connections/cloudflare.service'
import { ComposioService } from '@/modules/connections/composio.service'
import { decryptComposioKey } from '@/modules/connections/composio-key'
import { GithubAppService } from '@/modules/connections/github-app.service'
import { McpConfigMaterializer } from '@/modules/agent-runtimes/mcp/mcp-config-materializer.service'

const STATE_TTL_MS = 10 * 60_000

interface AgentConnectionRefs {
    githubConnectionId?: string | null
    cloudflareConnectionId?: string | null
    composioConnectionId?: string | null
}

// Provider page where the user views/edits this connection's scope. For GitHub
// it uses the stable account login from metadata (not displayName, which the
// user can rename) so the org URL keeps working after a rename.
const connectionManageUrl = (row: UserConnectionRow): string | null => {
    if (row.provider === 'cloudflare')
        return 'https://dash.cloudflare.com/profile/api-tokens'
    if (row.provider === 'github' && row.externalId) {
        const org = row.metadata?.accountName
        if (row.metadata?.accountType === 'Organization' && org)
            return `https://github.com/organizations/${org}/settings/installations/${row.externalId}`
        return `https://github.com/settings/installations/${row.externalId}`
    }
    return null
}

// The account label an agent sees for a connection: the github org/login or
// the cloudflare account id. Composio has no meaningful public account handle.
const connectionAccount = (row: UserConnectionRow): string | null => {
    if (row.provider === 'github')
        return row.metadata?.accountName ?? row.externalId
    if (row.provider === 'cloudflare') return row.externalId
    return null
}

// Actionable, accurate "how to use this" text handed to the agent (via the
// agent-self endpoint and the injected AGENTS.manyfold.md).
const connectionUsageHint = (row: UserConnectionRow): string => {
    if (row.provider === 'github')
        return `git and gh are authenticated for github.com (account ${connectionAccount(row) ?? row.displayName}); clone, push and open PRs on the installed repositories.`
    if (row.provider === 'cloudflare')
        return 'wrangler and cloudflared are authenticated; CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set in the environment.'
    return 'Composio Connect is linked; its tools are exposed through the managed "composio" MCP server — list them with tools/list.'
}

const toAgentConnectionInfo = (row: UserConnectionRow): AgentConnectionInfo => ({
    provider: row.provider,
    displayName: row.displayName,
    account: connectionAccount(row),
    usage: connectionUsageHint(row)
})

export const toConnectionSummary = (
    row: UserConnectionRow
): UserConnectionSummary => ({
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    displayName: row.displayName,
    // Composio's externalId is a private key fingerprint (idempotency only) —
    // never surface it. GitHub/Cloudflare ids are meaningful, so keep those.
    externalId: row.provider === 'composio' ? null : row.externalId,
    manageUrl: connectionManageUrl(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class ConnectionsService {
    private readonly log = new Logger(ConnectionsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly cloudflare: CloudflareService,
        private readonly composio: ComposioService,
        private readonly githubApp: GithubAppService,
        // Resolved lazily to fan out MCP re-materialization on Composio
        // connect/revoke without a static ConnectionsModule→AgentRuntimesModule
        // import (which would close a module cycle).
        private readonly moduleRef: ModuleRef
    ) {}

    async list(userId: string): Promise<UserConnectionSummary[]> {
        const rows = await this.db
            .select()
            .from(userConnections)
            .where(
                and(
                    eq(userConnections.userId, userId),
                    isNull(userConnections.revokedAt)
                )
            )
            .orderBy(desc(userConnections.createdAt))
        return rows.map(toConnectionSummary)
    }

    async delete(userId: string, id: string): Promise<void> {
        const [row] = await this.db
            .select()
            .from(userConnections)
            .where(
                and(
                    eq(userConnections.id, id),
                    eq(userConnections.userId, userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('connection not found')
        await this.db.delete(userConnections).where(eq(userConnections.id, id))
        if (row.provider === 'composio')
            await this.refreshBoundAgents(userId, id)
    }

    // Decrypt the Composio consumer key behind a connection the caller owns, for
    // the owner to view/copy in the UI. 404 unless it's theirs, composio, and not
    // revoked (decryptComposioKey enforces all three).
    async revealComposioKey(
        userId: string,
        id: string
    ): Promise<{ apiKey: string }> {
        const key = await decryptComposioKey(this.db, this.crypto, userId, id)
        if (!key) throw new NotFoundException('composio connection not found')
        return { apiKey: key }
    }

    async rename(
        userId: string,
        id: string,
        name: string
    ): Promise<UserConnectionSummary> {
        const trimmed = name.trim()
        if (!trimmed) throw new BadRequestException('name is required')
        const [row] = await this.db
            .update(userConnections)
            .set({ displayName: trimmed, updatedAt: new Date() })
            .where(
                and(
                    eq(userConnections.id, id),
                    eq(userConnections.userId, userId)
                )
            )
            .returning()
        if (!row) throw new NotFoundException('connection not found')
        return toConnectionSummary(row)
    }

    async createCloudflare(
        userId: string,
        body: CreateCloudflareConnectionBody
    ): Promise<CreateCloudflareConnectionResult> {
        const verify = await this.cloudflare.verifyAndListAccounts(body.token)
        if (!verify.valid)
            throw new BadRequestException(
                'Cloudflare token is invalid or not active'
            )
        if (verify.accounts.length === 0)
            throw new BadRequestException(
                'token cannot list any account — add the "Account Settings: Read" permission'
            )
        let account = verify.accounts[0]
        if (verify.accounts.length > 1) {
            const chosen = body.accountId
                ? verify.accounts.find((a) => a.id === body.accountId)
                : undefined
            if (!chosen)
                return {
                    status: 'needs_account_selection',
                    accounts: verify.accounts
                }
            account = chosen
        }
        const enc = this.crypto.encrypt(body.token)
        const row = await this.upsert(userId, 'cloudflare', account.id, {
            kind: 'cloudflare_api_token',
            displayName: body.name?.trim() || account.name,
            secretCiphertext: enc.ciphertext,
            keyVersion: enc.keyVersion,
            metadata: { accountName: account.name }
        })
        return { status: 'created', connection: toConnectionSummary(row) }
    }

    async createComposio(
        userId: string,
        body: CreateComposioConnectionBody
    ): Promise<UserConnectionSummary> {
        const apiKey = body.apiKey.trim()
        const verify = await this.composio.verifyKey(apiKey)
        if (!verify.valid)
            throw new BadRequestException(
                'Composio Connect API key is invalid'
            )
        const enc = this.crypto.encrypt(apiKey)
        // Composio gives no stable account id — fingerprint the key so re-pasting
        // the same key updates the same row (idempotent upsert) and the partial-
        // unique index holds. One-way + high-entropy → no disclosure.
        const fingerprint = createHash('sha256').update(apiKey).digest('hex')
        const row = await this.upsert(userId, 'composio', fingerprint, {
            kind: 'composio_consumer_key',
            displayName: body.name?.trim() || 'Composio',
            secretCiphertext: enc.ciphertext,
            keyVersion: enc.keyVersion
        })
        await this.refreshBoundAgents(userId, row.id)
        return toConnectionSummary(row)
    }

    // Re-materialize every agent bound to this Composio connection so a change to
    // the managed `composio` server reaches running sprites (revoke removes it;
    // re-paste refreshes the key). Best-effort — never throws, so a fan-out miss
    // can't fail the connect/revoke request; refreshOnChange re-runs at next
    // bootstrap regardless.
    private async refreshBoundAgents(
        userId: string,
        connectionId: string
    ): Promise<void> {
        try {
            const bound = await this.db
                .select()
                .from(agents)
                .where(
                    and(
                        eq(agents.userId, userId),
                        sql`${agents.extras}->>'composioConnectionId' = ${connectionId}`
                    )
                )
            if (bound.length === 0) return
            const mcp = this.moduleRef.get(McpConfigMaterializer, {
                strict: false
            })
            for (const agent of bound) void mcp.refreshOnChange(agent)
        } catch (err) {
            this.log.warn(
                `composio fan-out failed for ${connectionId}: ${(err as Error).message}`
            )
        }
    }

    async githubRepos(
        userId: string,
        id: string
    ): Promise<GithubConnectionReposResponse> {
        const row = await this.findActive(userId, id, 'github')
        if (!row?.externalId)
            throw new NotFoundException('github connection not found')
        try {
            const { totalCount, repos } =
                await this.githubApp.listInstallationRepos(row.externalId)
            return {
                repositorySelection:
                    row.metadata?.repositorySelection ?? 'selected',
                totalCount,
                repos
            }
        } catch (err) {
            throw new BadGatewayException(
                `GitHub repository listing failed: ${(err as Error).message}`
            )
        }
    }

    async cloudflareResources(
        userId: string,
        id: string
    ): Promise<CloudflareConnectionResourcesResponse> {
        const row = await this.findActive(userId, id, 'cloudflare')
        if (!row?.secretCiphertext || !row.externalId)
            throw new NotFoundException('cloudflare connection not found')
        const token = this.crypto.decrypt({
            ciphertext: row.secretCiphertext,
            keyVersion: row.keyVersion
        })
        const resources = await this.cloudflare.listResources(
            token,
            row.externalId
        )
        return {
            tokenStatus: resources.tokenStatus,
            accountId: row.externalId,
            accountName: row.metadata?.accountName ?? null,
            workers: resources.workers,
            pages: resources.pages
        }
    }

    async composioTools(
        userId: string,
        id: string
    ): Promise<ComposioConnectionToolsResponse> {
        const key = await decryptComposioKey(this.db, this.crypto, userId, id)
        if (!key) throw new NotFoundException('composio connection not found')
        try {
            return { tools: await this.composio.listTools(key) }
        } catch (err) {
            throw new BadGatewayException(
                `Composio tools listing failed: ${(err as Error).message}`
            )
        }
    }

    startGithub(userId: string): GithubConnectionStartResponse {
        if (!this.githubApp.isConfigured())
            throw new ServiceUnavailableException('GitHub App is not configured')
        return {
            installUrl: this.githubApp.buildInstallUrl(this.signState(userId))
        }
    }

    async completeGithubCallback(args: {
        installationId: string
        state: string
    }): Promise<void> {
        const userId = this.verifyState(args.state)
        const installation = await this.githubApp.fetchInstallation(
            args.installationId
        )
        await this.upsert(userId, 'github', args.installationId, {
            kind: 'github_app_installation',
            displayName: installation.accountLogin,
            secretCiphertext: null,
            keyVersion: 1,
            metadata: {
                accountType: installation.accountType,
                accountName: installation.accountLogin,
                repositorySelection: installation.repositorySelection
            }
        })
    }

    // Resolve the env vars to inject into a CLI-backed agent's sprite exec for
    // its linked connections. Best-effort: a broken/missing connection logs and
    // is skipped rather than failing the turn.
    async resolveAgentEnv(agent: {
        userId: string
        extras: unknown
    }): Promise<Record<string, string>> {
        const refs = (agent.extras ?? {}) as AgentConnectionRefs
        const env: Record<string, string> = {}
        if (refs.githubConnectionId) {
            const row = await this.findActive(
                agent.userId,
                refs.githubConnectionId,
                'github'
            )
            if (row?.externalId) {
                try {
                    const token = await this.githubApp.mintInstallationToken(
                        row.externalId
                    )
                    env.GH_TOKEN = token
                    env.GITHUB_TOKEN = token
                    // HOME-agnostic git credentials: Codex agents run with
                    // HOME=<workspace>, so `git config --global` is invisible to
                    // their git — GIT_CONFIG_* env is inherited regardless. The
                    // helper reads $GH_TOKEN at call time so the token never
                    // lands on disk.
                    env.GIT_CONFIG_COUNT = '1'
                    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper'
                    env.GIT_CONFIG_VALUE_0 =
                        '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'
                } catch (err) {
                    this.log.warn(
                        `github token mint failed for agent: ${(err as Error).message}`
                    )
                }
            }
        }
        if (refs.cloudflareConnectionId) {
            const row = await this.findActive(
                agent.userId,
                refs.cloudflareConnectionId,
                'cloudflare'
            )
            if (row?.secretCiphertext) {
                env.CLOUDFLARE_API_TOKEN = this.crypto.decrypt({
                    ciphertext: row.secretCiphertext,
                    keyVersion: row.keyVersion
                })
                if (row.externalId) env.CLOUDFLARE_ACCOUNT_ID = row.externalId
            }
        }
        // Composio is intentionally NOT injected here: its consumer key only
        // works as the `x-consumer-api-key` header of the Composio Connect MCP
        // server, not as an env var. Per-framework MCP wiring is a follow-up; the
        // agent's composioConnectionId is stored for that.
        return env
    }

    // Resolve an agent's linked connections into agent-facing summaries + usage
    // hints (for the agent-self endpoint and the injected AGENTS.manyfold.md).
    // Read-only — no secrets decrypted or tokens minted; missing/revoked refs are
    // skipped.
    async resolveAgentConnections(agent: {
        userId: string
        extras: unknown
    }): Promise<AgentConnectionInfo[]> {
        const refs = (agent.extras ?? {}) as AgentConnectionRefs
        const pairs: [string | null | undefined, ConnectionProvider][] = [
            [refs.githubConnectionId, 'github'],
            [refs.cloudflareConnectionId, 'cloudflare'],
            [refs.composioConnectionId, 'composio']
        ]
        const out: AgentConnectionInfo[] = []
        for (const [id, provider] of pairs) {
            if (!id) continue
            const row = await this.findActive(agent.userId, id, provider)
            if (row) out.push(toAgentConnectionInfo(row))
        }
        return out
    }

    // Same, addressed by agent id (loads the agent row first). Returns [] for a
    // missing agent so callers on the write path never throw.
    async resolveAgentConnectionsById(
        agentId: string
    ): Promise<AgentConnectionInfo[]> {
        const [agent] = await this.db
            .select({ userId: agents.userId, extras: agents.extras })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return []
        return this.resolveAgentConnections(agent)
    }

    // Validate a connection belongs to the user (for agent association).
    async assertOwned(
        userId: string,
        id: string,
        provider: ConnectionProvider
    ): Promise<void> {
        const row = await this.findActive(userId, id, provider)
        if (!row)
            throw new BadRequestException(
                `${provider} connection ${id} not found`
            )
    }

    private async findActive(
        userId: string,
        id: string,
        provider: ConnectionProvider
    ): Promise<UserConnectionRow | undefined> {
        const [row] = await this.db
            .select()
            .from(userConnections)
            .where(
                and(
                    eq(userConnections.id, id),
                    eq(userConnections.userId, userId),
                    eq(userConnections.provider, provider),
                    isNull(userConnections.revokedAt)
                )
            )
            .limit(1)
        return row
    }

    private async upsert(
        userId: string,
        provider: ConnectionProvider,
        externalId: string,
        values: Omit<
            NewUserConnectionRow,
            'id' | 'userId' | 'provider' | 'externalId'
        >
    ): Promise<UserConnectionRow> {
        const [existing] = await this.db
            .select()
            .from(userConnections)
            .where(
                and(
                    eq(userConnections.userId, userId),
                    eq(userConnections.provider, provider),
                    eq(userConnections.externalId, externalId),
                    isNull(userConnections.revokedAt)
                )
            )
            .limit(1)
        if (existing) {
            const [row] = await this.db
                .update(userConnections)
                .set({ ...values, updatedAt: new Date() })
                .where(eq(userConnections.id, existing.id))
                .returning()
            return row
        }
        const [row] = await this.db
            .insert(userConnections)
            .values({
                id: createObjectId('userConnection'),
                userId,
                provider,
                externalId,
                ...values
            })
            .returning()
        return row
    }

    private signState(userId: string): string {
        const enc = this.crypto.encrypt(
            JSON.stringify({ u: userId, e: Date.now() + STATE_TTL_MS })
        )
        // base64url so the value survives the GitHub install-URL round-trip —
        // raw base64 +/= get mangled in query strings.
        const packed = Buffer.from(enc.ciphertext, 'base64').toString(
            'base64url'
        )
        return `${enc.keyVersion}.${packed}`
    }

    private verifyState(state: string): string {
        const dot = state.indexOf('.')
        if (dot <= 0) throw new BadRequestException('invalid state')
        const keyVersion = Number(state.slice(0, dot))
        const packed = state.slice(dot + 1)
        if (!Number.isInteger(keyVersion) || !packed)
            throw new BadRequestException('invalid state')
        const ciphertext = Buffer.from(packed, 'base64url').toString('base64')
        let payload: { u?: unknown; e?: unknown }
        try {
            payload = JSON.parse(
                this.crypto.decrypt({ ciphertext, keyVersion })
            ) as { u?: unknown; e?: unknown }
        } catch {
            throw new BadRequestException('invalid state')
        }
        if (typeof payload.u !== 'string' || typeof payload.e !== 'number')
            throw new BadRequestException('invalid state')
        if (payload.e < Date.now())
            throw new BadRequestException('state expired')
        return payload.u
    }
}
