import {
    ExternalAgentProviderKind,
    ExternalProviderTestResult,
    UserExternalAgentProviderSummary,
    auditAction,
    createObjectId
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import {
    agents,
    auditLogs,
    chatSessions,
    userExternalAgentProviders,
    type Database,
    type UserExternalAgentProviderRow
} from '@manyfold/db'
import {
    getExternalProvider,
    type ExternalProviderKind
} from '@manyfold/external-providers'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { normalizeExternalProviderEndpoint } from '@/modules/user-external-agent-providers/endpoint-safety'

const maskApiKey = (raw: string): string => {
    const trimmed = raw.trim()
    if (trimmed.length <= 8) return '***'
    const dashIdx = trimmed.search(/[_-]/)
    const prefixEnd =
        dashIdx > 0 && dashIdx < 10 ? dashIdx + 1 : Math.min(4, trimmed.length)
    return `${trimmed.slice(0, prefixEnd)}***${trimmed.slice(-4)}`
}

const toSummary = (
    row: UserExternalAgentProviderRow,
    apiKeyMasked: string
): UserExternalAgentProviderSummary => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    apiKeyMasked,
    endpointUrl: row.endpointUrl,
    metadata: (row.metadataJson ?? {}) as Record<string, unknown>,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastTestStatus: row.lastTestStatus,
    lastTestMessage: row.lastTestMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class UserExternalAgentProvidersService {
    private readonly log = new Logger(UserExternalAgentProvidersService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    private async testExternal(
        framework: ExternalAgentProviderKind,
        config: {
            endpointUrl: string
            apiKey: string
            metadata?: Record<string, unknown>
        }
    ): Promise<ExternalProviderTestResult> {
        try {
            const impl = getExternalProvider(framework as ExternalProviderKind)
            const result = await impl.testConnection({ config })
            return {
                ok: result.ok,
                status: result.ok ? 'ok' : 'error',
                message: result.message,
                models: result.models
            }
        } catch (err) {
            this.log.warn(
                `testExternal ${framework} failed: ${(err as Error).message}`
            )
            return {
                ok: false,
                status: 'error',
                message: (err as Error).message ?? 'connection failed'
            }
        }
    }

    async list(
        userId: string,
        provider?: ExternalAgentProviderKind
    ): Promise<UserExternalAgentProviderSummary[]> {
        const where = provider
            ? and(
                  eq(userExternalAgentProviders.userId, userId),
                  eq(userExternalAgentProviders.provider, provider)
              )
            : eq(userExternalAgentProviders.userId, userId)
        const rows = await this.db
            .select()
            .from(userExternalAgentProviders)
            .where(where)
        return rows.map((row) => {
            const plain = this.crypto.decrypt({
                ciphertext: row.apiKeyCiphertext,
                keyVersion: row.keyVersion
            })
            return toSummary(row, maskApiKey(plain))
        })
    }

    async create(input: {
        userId: string
        provider: ExternalAgentProviderKind
        label: string
        endpointUrl: string
        apiKey: string
        metadata?: Record<string, unknown>
    }): Promise<UserExternalAgentProviderSummary> {
        const endpointUrl = await normalizeExternalProviderEndpoint(
            input.endpointUrl
        )
        const enc = this.crypto.encrypt(input.apiKey)
        try {
            const [row] = await this.db
                .insert(userExternalAgentProviders)
                .values({
                    id: createObjectId('userExternalAgentProvider'),
                    userId: input.userId,
                    provider: input.provider,
                    label: input.label,
                    endpointUrl,
                    apiKeyCiphertext: enc.ciphertext,
                    keyVersion: enc.keyVersion,
                    metadataJson: input.metadata ?? {}
                })
                .returning()
            await this.audit(
                input.userId,
                auditAction.EXTERNAL_AGENT_PROVIDER_CREATED,
                row.id,
                { provider: row.provider, label: row.label }
            )
            return toSummary(row, maskApiKey(input.apiKey))
        } catch (err) {
            const message = (err as Error).message
            if (
                message.includes(
                    'user_external_agent_providers_user_provider_label'
                )
            ) {
                throw new ConflictException(
                    `provider="${input.provider}" label="${input.label}" already exists`
                )
            }
            throw err
        }
    }

    async update(input: {
        userId: string
        id: string
        label?: string
        endpointUrl?: string
        apiKey?: string
        metadata?: Record<string, unknown>
    }): Promise<UserExternalAgentProviderSummary> {
        const existing = await this.getOwned(input.userId, input.id)
        const endpointUrl =
            input.endpointUrl !== undefined
                ? await normalizeExternalProviderEndpoint(input.endpointUrl)
                : undefined
        const apiKey =
            input.apiKey !== undefined && input.apiKey.length > 0
                ? input.apiKey
                : undefined
        const currentApiKey =
            apiKey !== undefined
                ? this.crypto.decrypt({
                      ciphertext: existing.apiKeyCiphertext,
                      keyVersion: existing.keyVersion
                  })
                : undefined
        const providerIdentityChanged =
            (endpointUrl !== undefined && endpointUrl !== existing.endpointUrl) ||
            (apiKey !== undefined && apiKey !== currentApiKey)
        const patch: Partial<typeof userExternalAgentProviders.$inferInsert> = {
            updatedAt: new Date()
        }
        if (input.label !== undefined) patch.label = input.label
        if (endpointUrl !== undefined) patch.endpointUrl = endpointUrl
        if (apiKey !== undefined) {
            const enc = this.crypto.encrypt(apiKey)
            patch.apiKeyCiphertext = enc.ciphertext
            patch.keyVersion = enc.keyVersion
        }
        if (input.metadata !== undefined) patch.metadataJson = input.metadata
        try {
            const [row] = await this.db
                .update(userExternalAgentProviders)
                .set(patch)
                .where(eq(userExternalAgentProviders.id, input.id))
                .returning()
            const plain = this.crypto.decrypt({
                ciphertext: row.apiKeyCiphertext,
                keyVersion: row.keyVersion
            })
            const clearedSessionRefs = providerIdentityChanged
                ? await this.clearFrameworkSessionRefsForProvider({
                      userId: input.userId,
                      providerId: row.id,
                      provider: row.provider
                  })
                : 0
            await this.audit(
                input.userId,
                auditAction.EXTERNAL_AGENT_PROVIDER_UPDATED,
                row.id,
                { provider: row.provider, label: row.label, clearedSessionRefs }
            )
            return toSummary(row, maskApiKey(plain))
        } catch (err) {
            const message = (err as Error).message
            if (
                message.includes(
                    'user_external_agent_providers_user_provider_label'
                )
            ) {
                throw new ConflictException(
                    `provider="${existing.provider}" label="${input.label}" already exists`
                )
            }
            throw err
        }
    }

    async delete(userId: string, id: string): Promise<void> {
        const row = await this.getOwned(userId, id)
        await this.db
            .delete(userExternalAgentProviders)
            .where(eq(userExternalAgentProviders.id, id))
        await this.audit(
            userId,
            auditAction.EXTERNAL_AGENT_PROVIDER_DELETED,
            id,
            { provider: row.provider, label: row.label }
        )
    }

    async reveal(userId: string, id: string): Promise<{ apiKey: string }> {
        const row = await this.getOwned(userId, id)
        const apiKey = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        return { apiKey }
    }

    async resolveForUser(input: { userId: string; id: string }): Promise<{
        provider: ExternalAgentProviderKind
        endpointUrl: string
        apiKey: string
        metadata: Record<string, unknown>
    }> {
        const row = await this.getOwned(input.userId, input.id)
        const apiKey = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        const endpointUrl = await normalizeExternalProviderEndpoint(
            row.endpointUrl
        )
        return {
            provider: row.provider,
            endpointUrl,
            apiKey,
            metadata: (row.metadataJson ?? {}) as Record<string, unknown>
        }
    }

    async testInline(input: {
        provider: ExternalAgentProviderKind
        endpointUrl: string
        apiKey: string
    }): Promise<ExternalProviderTestResult> {
        const endpointUrl = await normalizeExternalProviderEndpoint(
            input.endpointUrl
        )
        return this.testExternal(input.provider, {
            endpointUrl,
            apiKey: input.apiKey
        })
    }

    async testSaved(
        userId: string,
        id: string
    ): Promise<ExternalProviderTestResult> {
        const row = await this.getOwned(userId, id)
        const apiKey = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        const endpointUrl = await normalizeExternalProviderEndpoint(
            row.endpointUrl
        )
        const result = await this.testExternal(row.provider, {
            endpointUrl,
            apiKey
        })
        await this.db
            .update(userExternalAgentProviders)
            .set({
                lastTestedAt: new Date(),
                lastTestStatus: result.status,
                lastTestMessage: result.message
            })
            .where(eq(userExternalAgentProviders.id, row.id))
        return result
    }

    async getOwned(
        userId: string,
        id: string
    ): Promise<UserExternalAgentProviderRow> {
        const [row] = await this.db
            .select()
            .from(userExternalAgentProviders)
            .where(
                and(
                    eq(userExternalAgentProviders.id, id),
                    eq(userExternalAgentProviders.userId, userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException(`external agent provider ${id}`)
        return row
    }

    private async clearFrameworkSessionRefsForProvider(input: {
        userId: string
        providerId: string
        provider: ExternalAgentProviderKind
    }): Promise<number> {
        const rows = await this.db
            .update(chatSessions)
            .set({ frameworkSessionRef: null, updatedAt: new Date() })
            .where(
                and(
                    eq(chatSessions.userId, input.userId),
                    isNotNull(chatSessions.frameworkSessionRef),
                    sql`exists (
                        select 1 from ${agents}
                        where ${agents.id} = ${chatSessions.agentId}
                            and ${agents.userId} = ${input.userId}
                            and ${agents.runtime} = ${'external'}
                            and ${agents.framework} = ${input.provider}
                            and ${agents.extras}->'externalBinding'->>'providerId' = ${input.providerId}
                    )`
                )
            )
            .returning({ id: chatSessions.id })
        if (rows.length > 0) {
            this.log.log(
                `cleared ${rows.length} framework session refs for external provider ${input.providerId}`
            )
        }
        return rows.length
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `audit write failed action=${action} err=${(err as Error).message}`
            )
        }
    }
}
