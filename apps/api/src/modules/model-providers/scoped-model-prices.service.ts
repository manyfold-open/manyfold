import {
    BUILT_IN_PROVIDERS,
    BuiltInModelPriceEntryView,
    BuiltInModelPricesProviderView,
    BuiltInModelPricesView,
    ModelPriceAmounts,
    ModelPriceCandidate,
    ModelPriceEntryView,
    ModelPriceSource,
    ModelPriceSourcesView,
    ProviderModelPricesView,
    UpsertBuiltInModelPriceBody,
    UpsertProviderModelPriceBody,
    createObjectId,
    lookupBuiltIn,
    modelPriceAmountsFrom,
    modelPriceSourceUrl
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger
} from '@nestjs/common'
import { and, eq, isNotNull } from 'drizzle-orm'
import {
    auditLogs,
    scopedModelPrices,
    userModelProviders,
    type Database,
    type ScopedModelPriceRow,
    type UserModelProviderRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'

// One (scope, model) row's desired state, after validation. PUT is
// full-replace: absent price fields clear, and the pin is all-or-nothing.
interface RowConfig {
    prices: ModelPriceAmounts
    priceRefSource: ModelPriceSource | null
    priceRefKey: string | null
}

const priceString = (value: number | null | undefined): string | null =>
    value === null || value === undefined ? null : String(value)

const priceNumber = (value: string | null): number | null => {
    if (value === null) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

const rowAmounts = (row: ScopedModelPriceRow | undefined): ModelPriceAmounts => ({
    inputCostPerToken: priceNumber(row?.inputCostPerToken ?? null),
    outputCostPerToken: priceNumber(row?.outputCostPerToken ?? null),
    cacheReadCostPerToken: priceNumber(row?.cacheReadCostPerToken ?? null),
    cacheCreationCostPerToken: priceNumber(
        row?.cacheCreationCostPerToken ?? null
    )
})

// Prices for the two scopes in front of the global managed catalog: an admin's
// per-built-in defaults and a user's own per-provider row. The managed catalog
// keeps its own service; this one owns the scoped_model_prices table.
@Injectable()
export class ScopedModelPricesService {
    private readonly log = new Logger(ScopedModelPricesService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly pricing: UsagePricingService
    ) {}

    async adminList(): Promise<BuiltInModelPricesView> {
        // Without ensureLoaded a cold engine reports every model unpriced, and
        // the page reads as an outage instead of a price list.
        const [providerRows, scopedRows] = await Promise.all([
            this.db
                .select({
                    builtInId: userModelProviders.builtInId,
                    lastTestModels: userModelProviders.lastTestModels
                })
                .from(userModelProviders)
                .where(isNotNull(userModelProviders.builtInId)),
            this.db
                .select()
                .from(scopedModelPrices)
                .where(isNotNull(scopedModelPrices.builtInId)),
            this.pricing.ensureLoaded()
        ])

        const observed = new Map<string, Map<string, number>>()
        const rowCounts = new Map<string, number>()
        for (const row of providerRows) {
            if (!row.builtInId) continue
            rowCounts.set(row.builtInId, (rowCounts.get(row.builtInId) ?? 0) + 1)
            if (!row.lastTestModels) continue
            const models =
                observed.get(row.builtInId) ?? new Map<string, number>()
            // Union across protocols first: one row listing a model under two
            // protocols is still one observation.
            const perRow = new Set<string>()
            for (const list of Object.values(row.lastTestModels))
                for (const modelId of list) perRow.add(modelId)
            for (const modelId of perRow)
                models.set(modelId, (models.get(modelId) ?? 0) + 1)
            observed.set(row.builtInId, models)
        }

        const configured = new Map<string, Map<string, ScopedModelPriceRow>>()
        for (const row of scopedRows) {
            if (!row.builtInId) continue
            const models =
                configured.get(row.builtInId) ??
                new Map<string, ScopedModelPriceRow>()
            models.set(row.modelId, row)
            configured.set(row.builtInId, models)
        }

        const providers: BuiltInModelPricesProviderView[] =
            BUILT_IN_PROVIDERS.map((entry) => {
                const models = new Set<string>([
                    ...(observed.get(entry.id)?.keys() ?? []),
                    ...(configured.get(entry.id)?.keys() ?? [])
                ])
                const entries: BuiltInModelPriceEntryView[] = [...models]
                    .sort()
                    .map((modelId) => ({
                        ...this.entryView(
                            modelId,
                            configured.get(entry.id)?.get(modelId),
                            { modelProviderBuiltInId: entry.id },
                            true
                        ),
                        observedCount:
                            observed.get(entry.id)?.get(modelId) ?? 0
                    }))
                return {
                    builtInId: entry.id,
                    label: entry.label,
                    providerRowCount: rowCounts.get(entry.id) ?? 0,
                    unpricedCount: entries.filter(
                        (e) => e.priceStatus === 'missing'
                    ).length,
                    models: entries
                }
            })

        return { providers, sources: this.pricing.sourceStatuses() }
    }

    async adminCandidates(
        builtInId: string,
        modelId: string,
        query?: string
    ): Promise<ModelPriceSourcesView> {
        this.assertBuiltInId(builtInId)
        const trimmed = this.assertModelId(modelId)
        await this.pricing.ensureLoaded()
        const row = await this.findRow({ builtInId }, trimmed)
        return this.sourcesView(
            trimmed,
            row,
            { modelProviderBuiltInId: builtInId },
            query
        )
    }

    async adminUpsert(
        body: UpsertBuiltInModelPriceBody,
        actorId: string
    ): Promise<BuiltInModelPriceEntryView> {
        this.assertBuiltInId(body.builtInId)
        const modelId = this.assertModelId(body.modelId)
        await this.pricing.ensureLoaded()
        const config = this.validateConfig(body)
        const row = await this.writeRow(
            { builtInId: body.builtInId },
            modelId,
            config
        )
        await this.pricing.refreshOverridesNow()
        await this.audit(actorId, 'admin.built_in_model_prices.upsert', row.id, {
            builtInId: body.builtInId,
            modelId,
            priceRefSource: row.priceRefSource,
            priceRefKey: row.priceRefKey
        })
        const observedCount = await this.observedCount(body.builtInId, modelId)
        return {
            ...this.entryView(
                modelId,
                row,
                { modelProviderBuiltInId: body.builtInId },
                true
            ),
            observedCount
        }
    }

    async adminDelete(
        builtInId: string,
        modelId: string,
        actorId: string
    ): Promise<void> {
        this.assertBuiltInId(builtInId)
        const trimmed = this.assertModelId(modelId)
        const deleted = await this.db
            .delete(scopedModelPrices)
            .where(
                and(
                    eq(scopedModelPrices.builtInId, builtInId),
                    eq(scopedModelPrices.modelId, trimmed)
                )
            )
            .returning({ id: scopedModelPrices.id })
        if (deleted.length === 0) return
        await this.pricing.refreshOverridesNow()
        await this.audit(
            actorId,
            'admin.built_in_model_prices.delete',
            deleted[0].id,
            { builtInId, modelId: trimmed }
        )
    }

    async providerModelPrices(
        provider: UserModelProviderRow
    ): Promise<ProviderModelPricesView> {
        await this.pricing.ensureLoaded()
        const editable = provider.source !== 'managed'
        const rows = await this.db
            .select()
            .from(scopedModelPrices)
            .where(eq(scopedModelPrices.providerId, provider.id))
        const configured = new Map(rows.map((row) => [row.modelId, row]))
        // Prices are per model id, not per protocol: union the tested list.
        const models = new Set<string>()
        for (const list of Object.values(provider.lastTestModels ?? {}))
            for (const modelId of list) models.add(modelId)
        for (const modelId of configured.keys()) models.add(modelId)
        return {
            providerId: provider.id,
            editable,
            models: [...models]
                .sort()
                .map((modelId) =>
                    this.entryView(
                        modelId,
                        configured.get(modelId),
                        this.providerScope(provider),
                        editable
                    )
                ),
            sources: this.pricing.sourceStatuses()
        }
    }

    async providerCandidates(
        provider: UserModelProviderRow,
        modelId: string,
        query?: string
    ): Promise<ModelPriceSourcesView> {
        const trimmed = this.assertModelId(modelId)
        await this.pricing.ensureLoaded()
        const row = await this.findRow({ providerId: provider.id }, trimmed)
        return this.sourcesView(
            trimmed,
            row,
            this.providerScope(provider),
            query
        )
    }

    async providerUpsert(
        provider: UserModelProviderRow,
        body: UpsertProviderModelPriceBody,
        actorId: string
    ): Promise<ModelPriceEntryView> {
        this.assertProviderEditable(provider)
        const modelId = this.assertModelId(body.modelId)
        await this.pricing.ensureLoaded()
        const config = this.validateConfig(body)
        const row = await this.writeRow(
            { providerId: provider.id },
            modelId,
            config
        )
        await this.pricing.refreshOverridesNow()
        await this.audit(actorId, 'model_provider.model_prices.upsert', row.id, {
            providerId: provider.id,
            modelId,
            priceRefSource: row.priceRefSource,
            priceRefKey: row.priceRefKey
        })
        return this.entryView(
            modelId,
            row,
            this.providerScope(provider),
            true
        )
    }

    async providerDelete(
        provider: UserModelProviderRow,
        modelId: string,
        actorId: string
    ): Promise<void> {
        this.assertProviderEditable(provider)
        const trimmed = this.assertModelId(modelId)
        const deleted = await this.db
            .delete(scopedModelPrices)
            .where(
                and(
                    eq(scopedModelPrices.providerId, provider.id),
                    eq(scopedModelPrices.modelId, trimmed)
                )
            )
            .returning({ id: scopedModelPrices.id })
        if (deleted.length === 0) return
        await this.pricing.refreshOverridesNow()
        await this.audit(
            actorId,
            'model_provider.model_prices.delete',
            deleted[0].id,
            { providerId: provider.id, modelId: trimmed }
        )
    }

    // The scope a provider row's models resolve under. A managed row must keep
    // resolving exactly as the managed catalog dictates: its built_in_id is null
    // and no provider-scope row can be written for it, so both scope keys are
    // no-ops there by construction.
    private providerScope(provider: UserModelProviderRow): {
        modelProviderId: string
        modelProviderBuiltInId: string | null
    } {
        return {
            modelProviderId: provider.id,
            modelProviderBuiltInId: provider.builtInId ?? null
        }
    }

    private assertProviderEditable(provider: UserModelProviderRow): void {
        if (provider.source === 'managed')
            throw new ForbiddenException(
                'managed provider prices are platform-administered'
            )
    }

    private assertBuiltInId(builtInId: string): void {
        if (!lookupBuiltIn(builtInId))
            throw new BadRequestException(
                `'${builtInId}' is not a built-in provider`
            )
    }

    private assertModelId(modelId: string): string {
        const trimmed = modelId?.trim()
        if (!trimmed)
            throw new BadRequestException('modelId must not be empty')
        return trimmed
    }

    // Full-replace semantics with the same pin rules as the managed catalog:
    // both ref fields or neither, and a pin must name a record the source's
    // table actually has — a pin naming nothing would leave the model unpriced
    // with no hint why.
    private validateConfig(
        body: UpsertBuiltInModelPriceBody | UpsertProviderModelPriceBody
    ): RowConfig {
        const source = body.priceRefSource ?? null
        const key = body.priceRefKey?.trim() || null
        if ((source === null) !== (key === null))
            throw new BadRequestException(
                'priceRefSource and priceRefKey must be sent together'
            )
        if (source !== null && key !== null) {
            if (!this.pricing.hasPriceRecord(source, key))
                throw new BadRequestException(
                    `'${key}' is not a known ${source} pricing record`
                )
        }
        return {
            prices: {
                inputCostPerToken: body.inputCostPerToken ?? null,
                outputCostPerToken: body.outputCostPerToken ?? null,
                cacheReadCostPerToken: body.cacheReadCostPerToken ?? null,
                cacheCreationCostPerToken:
                    body.cacheCreationCostPerToken ?? null
            },
            priceRefSource: source,
            priceRefKey: key
        }
    }

    private async findRow(
        scope: { builtInId: string } | { providerId: string },
        modelId: string
    ): Promise<ScopedModelPriceRow | undefined> {
        const where =
            'builtInId' in scope
                ? and(
                      eq(scopedModelPrices.builtInId, scope.builtInId),
                      eq(scopedModelPrices.modelId, modelId)
                  )
                : and(
                      eq(scopedModelPrices.providerId, scope.providerId),
                      eq(scopedModelPrices.modelId, modelId)
                  )
        const [row] = await this.db
            .select()
            .from(scopedModelPrices)
            .where(where)
            .limit(1)
        return row
    }

    private async writeRow(
        scope: { builtInId: string } | { providerId: string },
        modelId: string,
        config: RowConfig
    ): Promise<ScopedModelPriceRow> {
        const now = new Date()
        const values = {
            id: createObjectId('scopedModelPrice'),
            builtInId: 'builtInId' in scope ? scope.builtInId : null,
            providerId: 'providerId' in scope ? scope.providerId : null,
            modelId,
            inputCostPerToken: priceString(config.prices.inputCostPerToken),
            outputCostPerToken: priceString(config.prices.outputCostPerToken),
            cacheReadCostPerToken: priceString(
                config.prices.cacheReadCostPerToken
            ),
            cacheCreationCostPerToken: priceString(
                config.prices.cacheCreationCostPerToken
            ),
            priceRefSource: config.priceRefSource,
            priceRefKey: config.priceRefKey,
            createdAt: now,
            updatedAt: now
        }
        const target =
            'builtInId' in scope
                ? [scopedModelPrices.builtInId, scopedModelPrices.modelId]
                : [scopedModelPrices.providerId, scopedModelPrices.modelId]
        const [row] = await this.db
            .insert(scopedModelPrices)
            .values(values)
            .onConflictDoUpdate({
                target,
                targetWhere:
                    'builtInId' in scope
                        ? isNotNull(scopedModelPrices.builtInId)
                        : isNotNull(scopedModelPrices.providerId),
                set: {
                    inputCostPerToken: values.inputCostPerToken,
                    outputCostPerToken: values.outputCostPerToken,
                    cacheReadCostPerToken: values.cacheReadCostPerToken,
                    cacheCreationCostPerToken:
                        values.cacheCreationCostPerToken,
                    priceRefSource: values.priceRefSource,
                    priceRefKey: values.priceRefKey,
                    updatedAt: now
                }
            })
            .returning()
        return row
    }

    private entryView(
        modelId: string,
        row: ScopedModelPriceRow | undefined,
        scope: {
            modelProviderId?: string | null
            modelProviderBuiltInId?: string | null
        },
        editable: boolean
    ): ModelPriceEntryView {
        const resolved = this.pricing.resolvePricing(modelId, scope)
        return {
            modelId,
            prices: rowAmounts(row),
            resolvedPrice: resolved
                ? modelPriceAmountsFrom(resolved.pricing)
                : null,
            priceStatus: resolved ? resolved.source : 'missing',
            scope: resolved ? resolved.scope : null,
            priceRef:
                resolved && resolved.source !== 'override' && resolved.key
                    ? {
                          source: resolved.source,
                          key: resolved.key,
                          pinned: resolved.pinned,
                          url: modelPriceSourceUrl(
                              resolved.source,
                              resolved.key
                          )
                      }
                    : null,
            pin:
                row?.priceRefSource && row.priceRefKey
                    ? { source: row.priceRefSource, key: row.priceRefKey }
                    : null,
            editable
        }
    }

    private sourcesView(
        modelId: string,
        row: ScopedModelPriceRow | undefined,
        scope: {
            modelProviderId?: string | null
            modelProviderBuiltInId?: string | null
        },
        query?: string
    ): ModelPriceSourcesView {
        const candidates: ModelPriceCandidate[] = this.pricing
            .priceCandidates(
                modelId,
                query,
                scope.modelProviderBuiltInId ?? null
            )
            .map((candidate) => ({
                source: candidate.source,
                key: candidate.key,
                official: candidate.official,
                matchKind: candidate.matchKind,
                prices: modelPriceAmountsFrom(candidate.pricing),
                url: modelPriceSourceUrl(candidate.source, candidate.key)
            }))
        return {
            modelId,
            priceRef: this.entryView(modelId, row, scope, true).priceRef,
            candidates,
            sources: this.pricing.sourceStatuses()
        }
    }

    private async observedCount(
        builtInId: string,
        modelId: string
    ): Promise<number> {
        const rows = await this.db
            .select({ lastTestModels: userModelProviders.lastTestModels })
            .from(userModelProviders)
            .where(eq(userModelProviders.builtInId, builtInId))
        let count = 0
        for (const row of rows) {
            if (!row.lastTestModels) continue
            const listed = Object.values(row.lastTestModels).some((list) =>
                list.includes(modelId)
            )
            if (listed) count += 1
        }
        return count
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
