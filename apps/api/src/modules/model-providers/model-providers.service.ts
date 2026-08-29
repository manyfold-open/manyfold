import {
    AdminUserModelProviderSummary,
    InferenceProtocol,
    ProtocolModelMap,
    ProviderTestResult,
    UserModelProviderSummary,
    UserModelProviderUsage,
    UserModelProviderUsageReport,
    UserModelProviderUsageRow,
    brandFor,
    createObjectId,
    defaultProtocolForProvider,
    lookupBuiltIn
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    BadRequestException
} from '@nestjs/common'
import { and, count, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import {
    agentUsageEvents,
    agents,
    auditLogs,
    users,
    userModelProviders,
    type Database,
    type UserModelProviderRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    MANAGED_MODELS_PORT,
    noManagedModelsPort,
    type ManagedModelsPort
} from '@/common/ports/managed-models.ports'
import { ProviderTestService } from '@/modules/model-providers/provider-test.service'

const mapProtocolModelsToIds = (
    map: Record<string, { id: string }[]>
): ProtocolModelMap => {
    const out: ProtocolModelMap = {}
    for (const [protocol, list] of Object.entries(map)) {
        out[protocol] = list.map((m) => m.id)
    }
    return out
}

const flattenProtocolModels = (
    map: Record<string, { id: string; ownedBy?: string | null }[]>
): { id: string; ownedBy?: string | null }[] => {
    const seen = new Set<string>()
    const out: { id: string; ownedBy?: string | null }[] = []
    for (const list of Object.values(map)) {
        for (const m of list) {
            if (seen.has(m.id)) continue
            seen.add(m.id)
            out.push(m)
        }
    }
    return out
}

export const maskApiKey = (raw: string): string => {
    const trimmed = raw.trim()
    if (trimmed.length <= 8) return '***'
    const dashIdx = trimmed.search(/[_-]/)
    const prefixEnd =
        dashIdx > 0 && dashIdx < 10 ? dashIdx + 1 : Math.min(4, trimmed.length)
    const prefix = trimmed.slice(0, prefixEnd)
    const tail = trimmed.slice(-4)
    return `${prefix}***${tail}`
}

export const toModelProviderSummary = (
    row: UserModelProviderRow,
    apiKeyMasked: string
): UserModelProviderSummary => ({
    id: row.id,
    inferenceProtocol: row.inferenceProtocol,
    builtInId: row.builtInId,
    externalAccountId: row.externalAccountId,
    providerName: row.providerName,
    apiKeyMasked,
    baseUrl: row.baseUrl,
    modelsListUrl: row.modelsListUrl,
    source: row.source,
    managedService: row.managedService,
    managedKeyId: row.managedKeyId,
    managedBrand: row.managedBrand,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastTestStatus: row.lastTestStatus,
    lastTestMessage: row.lastTestMessage,
    lastTestModels: row.lastTestModels ?? null,
    enabledModels: row.enabledModels ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const parseBoundDate = (v?: string | null): Date | null => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
}

// Decode a NetMind loginToken (JWT) payload for its `exp` as a Date. No
// signature check — it's our own stored token and the value is only a soft gate
// to prompt reconnect before calling the billing API. null if not a decodable
// JWT with a numeric exp.
export const netmindTokenExpiry = (token: string): Date | null => {
    const parts = token.split('.')
    if (parts.length < 2) return null
    try {
        const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8')
        ) as { exp?: unknown }
        return typeof payload.exp === 'number'
            ? new Date(payload.exp * 1000)
            : null
    } catch {
        return null
    }
}

@Injectable()
export class ModelProvidersService {
    private readonly log = new Logger(ModelProvidersService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly providerTest: ProviderTestService,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means no managed catalog to serve test results.
        @Optional()
        @Inject(MANAGED_MODELS_PORT)
        private readonly managedModels: ManagedModelsPort = noManagedModelsPort
    ) {}

    async list(userId: string): Promise<UserModelProviderSummary[]> {
        const rows = await this.db
            .select()
            .from(userModelProviders)
            .where(eq(userModelProviders.userId, userId))
        // Rows for admin-disabled managed channels stay in the list — they are
        // still valid keys and agents already bound to them keep working. The
        // flag lets the pickers hide them from *new* bindings.
        const disabledChannels =
            await this.managedModels.disabledManagedChannels()
        return rows.map((row) => {
            const plain = this.crypto.decrypt({
                ciphertext: row.apiKeyCiphertext,
                keyVersion: row.keyVersion
            })
            const summary = toModelProviderSummary(row, maskApiKey(plain))
            const brand = brandFor(row)
            if (row.source !== 'managed' || !brand) return summary
            return disabledChannels.has(brand)
                ? { ...summary, channelDisabled: true }
                : summary
        })
    }

    async adminListWithUsage(opts: {
        from?: string
        to?: string
    }): Promise<AdminUserModelProviderSummary[]> {
        const from = parseBoundDate(opts.from)
        const to = parseBoundDate(opts.to)

        const providerRows = await this.db
            .select({
                provider: userModelProviders,
                userEmail: users.email
            })
            .from(userModelProviders)
            .leftJoin(users, eq(users.id, userModelProviders.userId))

        const agentCounts = await this.db
            .select({
                modelProviderId: agents.modelProviderId,
                value: count()
            })
            .from(agents)
            .groupBy(agents.modelProviderId)
        const agentCountMap = new Map<string, number>()
        for (const r of agentCounts) {
            if (r.modelProviderId)
                agentCountMap.set(r.modelProviderId, Number(r.value ?? 0))
        }

        const usageConds: SQL[] = []
        if (from) usageConds.push(gte(agentUsageEvents.createdAt, from))
        if (to) usageConds.push(lt(agentUsageEvents.createdAt, to))
        const usageRows = await this.usageByProvider(usageConds)
        const usageMap = new Map<string, UserModelProviderUsage>()
        for (const r of usageRows) {
            // Admin rows are keyed by provider id, so the unattributed group
            // has nowhere to go here. listUsage keeps it.
            if (!r.modelProviderId) continue
            usageMap.set(r.modelProviderId, r.usage)
        }

        return providerRows.map((row) => {
            const plain = this.crypto.decrypt({
                ciphertext: row.provider.apiKeyCiphertext,
                keyVersion: row.provider.keyVersion
            })
            const base = toModelProviderSummary(row.provider, maskApiKey(plain))
            const usage: UserModelProviderUsage = usageMap.get(
                row.provider.id
            ) ?? {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                costUsd: null,
                unpricedEventCount: 0,
                eventCount: 0,
                lastUsedAt: null
            }
            return {
                ...base,
                userId: row.provider.userId,
                userEmail: row.userEmail,
                boundAgentCount: agentCountMap.get(row.provider.id) ?? 0,
                usage
            }
        })
    }

    // One GROUP BY over agent_usage_events, shared by the admin table and the
    // user-facing spend dashboard so the two can never disagree about how a
    // provider's spend is computed. Served by
    // agent_usage_events_model_provider_idx / _user_created_idx.
    private async usageByProvider(
        conds: SQL[]
    ): Promise<UserModelProviderUsageRow[]> {
        const rows = await this.db
            .select({
                modelProviderId: agentUsageEvents.modelProviderId,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                cacheReadTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheReadTokens}), 0)`,
                cacheCreationTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheCreationTokens}), 0)`,
                // Deliberately not coalesced: an all-NULL group means the cost
                // is unknown, which is not the same as zero.
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`,
                unpricedEventCount: sql<string>`count(*) filter (where ${agentUsageEvents.costUsd} is null)`,
                eventCount: sql<string>`count(*)`,
                lastUsedAt: sql<Date | null>`max(${agentUsageEvents.createdAt})`
            })
            .from(agentUsageEvents)
            .where(conds.length ? and(...conds) : undefined)
            .groupBy(agentUsageEvents.modelProviderId)
        return rows.map((r) => ({
            modelProviderId: r.modelProviderId,
            usage: {
                inputTokens: Number(r.inputTokens),
                outputTokens: Number(r.outputTokens),
                cacheReadTokens: Number(r.cacheReadTokens),
                cacheCreationTokens: Number(r.cacheCreationTokens),
                costUsd: r.costUsd === null ? null : Number(r.costUsd),
                unpricedEventCount: Number(r.unpricedEventCount),
                eventCount: Number(r.eventCount),
                lastUsedAt: r.lastUsedAt
                    ? new Date(r.lastUsedAt).toISOString()
                    : null
            }
        }))
    }

    async listUsage(
        userId: string,
        opts: { from?: string; to?: string }
    ): Promise<UserModelProviderUsageReport> {
        const from = parseBoundDate(opts.from)
        const to = parseBoundDate(opts.to)
        const conds: SQL[] = [eq(agentUsageEvents.userId, userId)]
        if (from) conds.push(gte(agentUsageEvents.createdAt, from))
        if (to) conds.push(lt(agentUsageEvents.createdAt, to))
        return {
            from: from ? from.toISOString() : null,
            to: to ? to.toISOString() : null,
            // The null-provider group is kept: it is real spend the turn could
            // not attribute, and dropping it makes the page's total silently
            // disagree with the usage page.
            rows: await this.usageByProvider(conds)
        }
    }

    async create(input: {
        userId: string
        inferenceProtocol: InferenceProtocol
        providerName: string
        apiKey: string
        baseUrl: string
        modelsListUrl?: string | null
    }): Promise<UserModelProviderSummary> {
        const enc = this.crypto.encrypt(input.apiKey)
        try {
            const [row] = await this.db
                .insert(userModelProviders)
                .values({
                    id: createObjectId('userModelProvider'),
                    userId: input.userId,
                    inferenceProtocol: input.inferenceProtocol,
                    providerName: input.providerName,
                    apiKeyCiphertext: enc.ciphertext,
                    keyVersion: enc.keyVersion,
                    baseUrl: input.baseUrl,
                    modelsListUrl: input.modelsListUrl ?? null
                })
                .returning()
            return toModelProviderSummary(row, maskApiKey(input.apiKey))
        } catch (err) {
            const message = (err as Error).message
            if (message.includes('user_model_providers_custom_name_unique')) {
                throw new ConflictException(
                    `providerName="${input.providerName}" already exists`
                )
            }
            throw err
        }
    }

    async createBuiltIn(input: {
        userId: string
        builtInId: string
        apiKey: string
        providerName?: string
        externalAccountId?: string
        netmindLoginToken?: string
    }): Promise<UserModelProviderSummary> {
        const entry = lookupBuiltIn(input.builtInId)
        if (!entry)
            throw new BadRequestException(
                `unknown built-in provider id "${input.builtInId}"`
            )
        const providerName =
            input.providerName?.trim() ||
            (await this.defaultBuiltInName(input.userId, entry.id, entry.label))
        const enc = this.crypto.encrypt(input.apiKey)
        try {
            const [row] = await this.db
                .insert(userModelProviders)
                .values({
                    id: createObjectId('userModelProvider'),
                    userId: input.userId,
                    inferenceProtocol: null,
                    builtInId: entry.id,
                    externalAccountId: input.externalAccountId ?? null,
                    providerName,
                    apiKeyCiphertext: enc.ciphertext,
                    keyVersion: enc.keyVersion,
                    baseUrl: null,
                    modelsListUrl: null,
                    ...(input.netmindLoginToken
                        ? this.encryptNetmindLoginToken(input.netmindLoginToken)
                        : {})
                })
                .returning()
            return toModelProviderSummary(row, maskApiKey(input.apiKey))
        } catch (err) {
            const message = (err as Error).message
            if (
                message.includes(
                    'user_model_providers_byo_external_account_unique'
                )
            ) {
                throw new ConflictException(
                    `built-in provider "${entry.label}" already connected for this account`
                )
            }
            throw err
        }
    }

    // --- NetMind loginToken persistence (server-side, encrypted) -----------
    // Stored so balance/recharge work without a per-session sign-in popup.
    // Encrypted with the same CryptoService as the inference key; never returned
    // to the browser (absent from toModelProviderSummary) or logged.
    private encryptNetmindLoginToken(loginToken: string): {
        netmindLoginTokenCiphertext: string
        netmindLoginTokenKeyVersion: number
        netmindLoginTokenExpiresAt: Date | null
    } {
        const enc = this.crypto.encrypt(loginToken)
        return {
            netmindLoginTokenCiphertext: enc.ciphertext,
            netmindLoginTokenKeyVersion: enc.keyVersion,
            netmindLoginTokenExpiresAt: netmindTokenExpiry(loginToken)
        }
    }

    // Upsert a fresh loginToken onto an existing row (re-connect / re-login, or
    // the balance route when the browser supplies a freshly re-authed token).
    async refreshNetmindLoginToken(
        userId: string,
        id: string,
        loginToken: string
    ): Promise<void> {
        await this.getOwned(userId, id)
        await this.db
            .update(userModelProviders)
            .set({
                ...this.encryptNetmindLoginToken(loginToken),
                updatedAt: new Date()
            })
            .where(eq(userModelProviders.id, id))
    }

    // Decrypt the stored loginToken for server-side billing calls. Kept here so
    // CryptoService stays out of the billing controller.
    async revealNetmindLoginToken(
        userId: string,
        id: string
    ): Promise<{ token: string; expiresAt: Date | null } | null> {
        const row = await this.getOwned(userId, id)
        if (
            !row.netmindLoginTokenCiphertext ||
            row.netmindLoginTokenKeyVersion === null
        )
            return null
        const token = this.crypto.decrypt({
            ciphertext: row.netmindLoginTokenCiphertext,
            keyVersion: row.netmindLoginTokenKeyVersion
        })
        return { token, expiresAt: row.netmindLoginTokenExpiresAt ?? null }
    }

    // Drop a stored token that upstream rejected (rotated after a password
    // change), so the next balance load prompts a clean reconnect.
    async clearNetmindLoginToken(userId: string, id: string): Promise<void> {
        await this.getOwned(userId, id)
        await this.db
            .update(userModelProviders)
            .set({
                netmindLoginTokenCiphertext: null,
                netmindLoginTokenKeyVersion: null,
                netmindLoginTokenExpiresAt: null,
                updatedAt: new Date()
            })
            .where(eq(userModelProviders.id, id))
    }

    private async defaultBuiltInName(
        userId: string,
        builtInId: string,
        label: string
    ): Promise<string> {
        const rows = await this.db
            .select({ providerName: userModelProviders.providerName })
            .from(userModelProviders)
            .where(
                and(
                    eq(userModelProviders.userId, userId),
                    eq(userModelProviders.builtInId, builtInId),
                    eq(userModelProviders.source, 'byo')
                )
            )
        const taken = new Set(rows.map((r) => r.providerName))
        if (!taken.has(label)) return label
        for (let n = 2; ; n += 1) {
            const candidate = `${label} ${n}`
            if (!taken.has(candidate)) return candidate
        }
    }

    async findBuiltInByAccount(
        userId: string,
        builtInId: string,
        externalAccountId: string
    ): Promise<UserModelProviderSummary | null> {
        const [row] = await this.db
            .select()
            .from(userModelProviders)
            .where(
                and(
                    eq(userModelProviders.userId, userId),
                    eq(userModelProviders.builtInId, builtInId),
                    eq(userModelProviders.externalAccountId, externalAccountId),
                    eq(userModelProviders.source, 'byo')
                )
            )
            .orderBy(userModelProviders.createdAt)
            .limit(1)
        if (!row) return null
        const plain = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        return toModelProviderSummary(row, maskApiKey(plain))
    }

    async update(input: {
        userId: string
        id: string
        providerName?: string
        inferenceProtocol?: InferenceProtocol
        apiKey?: string
        baseUrl?: string | null
        modelsListUrl?: string | null
        enabledModels?: ProtocolModelMap | null
    }): Promise<UserModelProviderSummary> {
        const existing = await this.getOwned(input.userId, input.id)
        if (
            existing.source === 'managed' &&
            ((input.apiKey !== undefined && input.apiKey.length > 0) ||
                input.baseUrl !== undefined ||
                input.modelsListUrl !== undefined ||
                input.inferenceProtocol !== undefined)
        ) {
            throw new BadRequestException(
                'managed provider credentials are platform-controlled'
            )
        }
        if (
            existing.builtInId &&
            (input.baseUrl !== undefined ||
                input.modelsListUrl !== undefined ||
                input.inferenceProtocol !== undefined)
        ) {
            throw new BadRequestException(
                'built-in provider config is platform-managed'
            )
        }
        const patch: Partial<typeof userModelProviders.$inferInsert> = {
            updatedAt: new Date()
        }
        if (input.providerName !== undefined)
            patch.providerName = input.providerName
        if (input.inferenceProtocol !== undefined)
            patch.inferenceProtocol = input.inferenceProtocol
        if (input.apiKey !== undefined && input.apiKey.length > 0) {
            const enc = this.crypto.encrypt(input.apiKey)
            patch.apiKeyCiphertext = enc.ciphertext
            patch.keyVersion = enc.keyVersion
        }
        if (input.baseUrl !== undefined) {
            patch.baseUrl = input.baseUrl ?? null
        }
        if (input.modelsListUrl !== undefined) {
            patch.modelsListUrl = input.modelsListUrl ?? null
        }
        if (input.enabledModels !== undefined) {
            patch.enabledModels = input.enabledModels ?? null
        }
        try {
            const [row] = await this.db
                .update(userModelProviders)
                .set(patch)
                .where(eq(userModelProviders.id, input.id))
                .returning()
            const plain = this.crypto.decrypt({
                ciphertext: row.apiKeyCiphertext,
                keyVersion: row.keyVersion
            })
            return toModelProviderSummary(row, maskApiKey(plain))
        } catch (err) {
            const message = (err as Error).message
            if (message.includes('user_model_providers_custom_name_unique')) {
                throw new ConflictException(
                    `providerName="${input.providerName}" already exists`
                )
            }
            throw err
        }
    }

    async delete(userId: string, id: string): Promise<void> {
        await this.getOwned(userId, id)
        await this.db
            .delete(userModelProviders)
            .where(eq(userModelProviders.id, id))
    }

    async reveal(userId: string, id: string): Promise<{ apiKey: string }> {
        const row = await this.getOwned(userId, id)
        const apiKey = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        await this.audit(userId, 'model_provider.reveal', row.id, {
            builtInId: row.builtInId,
            providerName: row.providerName
        })
        return { apiKey }
    }

    async findByApiKey(input: {
        userId: string
        apiKey: string
    }): Promise<UserModelProviderSummary | null> {
        const trimmed = input.apiKey.trim()
        if (!trimmed) return null
        const rows = await this.db
            .select()
            .from(userModelProviders)
            .where(eq(userModelProviders.userId, input.userId))
        for (const row of rows) {
            const plain = this.crypto.decrypt({
                ciphertext: row.apiKeyCiphertext,
                keyVersion: row.keyVersion
            })
            if (plain.trim() === trimmed)
                return toModelProviderSummary(row, maskApiKey(plain))
        }
        return null
    }

    async testSaved(userId: string, id: string): Promise<ProviderTestResult> {
        const row = await this.getOwned(userId, id)
        const apiKey = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        if (row.builtInId) {
            const entry = lookupBuiltIn(row.builtInId)
            if (!entry)
                throw new BadRequestException(
                    `built-in provider ${row.builtInId} no longer in catalog`
                )
            const multi = await this.providerTest.runBuiltInTest({
                entry,
                apiKey
            })
            const totalCount = Object.values(multi.modelsByProtocol).reduce(
                (n, list) => n + list.length,
                0
            )
            await this.db
                .update(userModelProviders)
                .set({
                    lastTestedAt: new Date(),
                    lastTestStatus: multi.status,
                    lastTestMessage: multi.message ?? null,
                    lastTestModels: multi.ok
                        ? mapProtocolModelsToIds(multi.modelsByProtocol)
                        : null
                })
                .where(eq(userModelProviders.id, row.id))
            await this.audit(userId, 'model_provider.test', row.id, {
                builtInId: row.builtInId,
                providerName: row.providerName,
                status: multi.status,
                modelCount: totalCount
            })
            return {
                ok: multi.ok,
                status: multi.status,
                message: multi.message,
                latencyMs: multi.latencyMs,
                models: flattenProtocolModels(multi.modelsByProtocol)
            }
        }
        const managedResult = await this.testManagedFromCatalog(userId, row)
        if (managedResult) return managedResult
        if (!row.inferenceProtocol)
            throw new BadRequestException(
                `provider row ${row.id} is missing inference_protocol`
            )
        if (!row.baseUrl)
            throw new BadRequestException(
                `provider row ${row.id} is missing base_url`
            )
        const result = await this.providerTest.runTest({
            inferenceProtocol: row.inferenceProtocol,
            apiKey,
            baseUrl: row.baseUrl,
            modelsListUrl: row.modelsListUrl
        })
        await this.db
            .update(userModelProviders)
            .set({
                lastTestedAt: new Date(),
                lastTestStatus: result.status,
                lastTestMessage: result.message ?? null,
                lastTestModels: result.ok
                    ? {
                          [row.inferenceProtocol]: result.models.map(
                              (m) => m.id
                          )
                      }
                    : null
            })
            .where(eq(userModelProviders.id, row.id))
        await this.audit(userId, 'model_provider.test', row.id, {
            builtInId: row.builtInId,
            providerName: row.providerName,
            status: result.status,
            modelCount: result.models.length
        })
        return result
    }

    // Managed rows read their model list from the platform catalog instead of
    // probing the managed upstream per user: the list is group-scoped, so it is identical for
    // every user of the brand, and only the catalog knows which models an admin
    // has enabled. Returns null when there is nothing to serve (cold or
    // unconfigured environment) so the caller falls back to the upstream probe.
    private async testManagedFromCatalog(
        userId: string,
        row: UserModelProviderRow
    ): Promise<ProviderTestResult | null> {
        if (row.source !== 'managed') return null
        const brand = brandFor(row)
        if (!brand || !this.managedModels.isManagedBrand(brand)) return null
        const started = Date.now()
        const models = await this.managedModels.enabledModelsForTest(brand, {
            providerId: row.id
        })
        if (models.length === 0) return null
        const protocol =
            row.inferenceProtocol ?? defaultProtocolForProvider(brand)
        await this.db
            .update(userModelProviders)
            .set({
                lastTestedAt: new Date(),
                lastTestStatus: 'ok',
                lastTestMessage: null,
                lastTestModels: { [protocol]: models.map((m) => m.id) }
            })
            .where(eq(userModelProviders.id, row.id))
        await this.audit(userId, 'model_provider.test', row.id, {
            builtInId: row.builtInId,
            providerName: row.providerName,
            status: 'ok',
            modelCount: models.length,
            source: 'managed-catalog'
        })
        return {
            ok: true,
            status: 'ok',
            latencyMs: Date.now() - started,
            models
        }
    }

    async testInline(input: {
        inferenceProtocol: InferenceProtocol
        apiKey: string
        baseUrl: string
        modelsListUrl?: string | null
    }): Promise<ProviderTestResult> {
        return this.providerTest.runTest({
            inferenceProtocol: input.inferenceProtocol,
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            modelsListUrl: input.modelsListUrl ?? null
        })
    }

    async resolveForUser(input: { userId: string; id: string }): Promise<{
        inferenceProtocol: InferenceProtocol | null
        builtInId: string | null
        apiKey: string
        baseUrl: string | null
        source: 'byo' | 'managed'
    }> {
        const row = await this.getOwned(input.userId, input.id)
        const apiKey = this.crypto.decrypt({
            ciphertext: row.apiKeyCiphertext,
            keyVersion: row.keyVersion
        })
        return {
            inferenceProtocol: row.inferenceProtocol,
            builtInId: row.builtInId,
            apiKey,
            baseUrl: row.baseUrl,
            source: row.source
        }
    }

    async createIfMissing(input: {
        userId: string
        inferenceProtocol: InferenceProtocol
        providerName: string
        apiKey: string
        baseUrl: string
    }): Promise<{ created: boolean; conflict?: string }> {
        try {
            await this.create(input)
            return { created: true }
        } catch (err) {
            if (err instanceof ConflictException) {
                return { created: false, conflict: err.message }
            }
            throw err
        }
    }

    async getOwned(userId: string, id: string): Promise<UserModelProviderRow> {
        const [row] = await this.db
            .select()
            .from(userModelProviders)
            .where(
                and(
                    eq(userModelProviders.id, id),
                    eq(userModelProviders.userId, userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException(`model provider ${id}`)
        return row
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
