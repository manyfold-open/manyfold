import { createObjectId } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import {
    frameworkEnumCatalog,
    frameworkModelCatalog,
    type Database,
    type FrameworkEnumCatalogRow,
    type FrameworkModelCatalogRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    configurableFrameworks,
    enumRowToView,
    frameworkEnumKeys,
    frameworkModelKinds,
    isConfigurableFramework,
    isFrameworkEnumKey,
    modelRowToView,
    type ConfigurableFramework,
    type FrameworkCatalogView,
    type FrameworkEnumKey,
    type FrameworkEnumView,
    type FrameworkModelCapabilitiesView,
    type FrameworkModelKind,
    type FrameworkModelView
} from '@/modules/framework-catalog/framework-catalog.types'

const CACHE_TTL_MS = 60_000

interface CachedFramework {
    fetchedAt: number
    models: FrameworkModelCatalogRow[]
    enums: FrameworkEnumCatalogRow[]
}

export interface CreateModelInput {
    framework: string
    modelKey: string
    kind: string
    displayName: string
    capabilities?: FrameworkModelCapabilitiesView
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

export interface UpdateModelInput {
    modelKey?: string
    kind?: string
    displayName?: string
    capabilities?: FrameworkModelCapabilitiesView
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

export interface CreateEnumInput {
    framework: string
    enumKey: string
    value: string
    displayName: string
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

export interface UpdateEnumInput {
    value?: string
    displayName?: string
    sortOrder?: number
    isActive?: boolean
    isDefault?: boolean
}

@Injectable()
export class FrameworkCatalogService {
    private readonly cache = new Map<ConfigurableFramework, CachedFramework>()

    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async listModels(
        framework: ConfigurableFramework,
        opts: { activeOnly?: boolean } = {}
    ): Promise<FrameworkModelView[]> {
        const cached = await this.getCached(framework)
        const rows = opts.activeOnly
            ? cached.models.filter((row) => row.isActive)
            : cached.models
        return rows.map(modelRowToView)
    }

    async listEnums(
        framework: ConfigurableFramework,
        enumKey: FrameworkEnumKey,
        opts: { activeOnly?: boolean } = {}
    ): Promise<FrameworkEnumView[]> {
        const cached = await this.getCached(framework)
        const rows = cached.enums
            .filter((row) => row.enumKey === enumKey)
            .filter((row) => (opts.activeOnly ? row.isActive : true))
        return rows.map(enumRowToView)
    }

    async getCatalog(
        framework: ConfigurableFramework,
        opts: { activeOnly?: boolean } = {}
    ): Promise<FrameworkCatalogView> {
        const cached = await this.getCached(framework)
        const models = (
            opts.activeOnly
                ? cached.models.filter((row) => row.isActive)
                : cached.models
        ).map(modelRowToView)
        const enums: FrameworkCatalogView['enums'] = {}
        for (const key of frameworkEnumKeys) {
            const rows = cached.enums
                .filter((row) => row.enumKey === key)
                .filter((row) => (opts.activeOnly ? row.isActive : true))
            if (rows.length > 0) enums[key] = rows.map(enumRowToView)
        }
        return { framework, models, enums }
    }

    async getDefaultModel(
        framework: ConfigurableFramework,
        kind: FrameworkModelKind = 'model'
    ): Promise<FrameworkModelView | null> {
        const models = await this.listModels(framework, { activeOnly: true })
        return models.find((m) => m.kind === kind && m.isDefault) ?? null
    }

    async getDefaultEnumValue(
        framework: ConfigurableFramework,
        enumKey: FrameworkEnumKey
    ): Promise<FrameworkEnumView | null> {
        const enums = await this.listEnums(framework, enumKey, {
            activeOnly: true
        })
        return enums.find((e) => e.isDefault) ?? null
    }

    async isModelKeyActive(
        framework: ConfigurableFramework,
        modelKey: string
    ): Promise<boolean> {
        const models = await this.listModels(framework, { activeOnly: true })
        return models.some((m) => m.modelKey === modelKey)
    }

    async isEnumValueActive(
        framework: ConfigurableFramework,
        enumKey: FrameworkEnumKey,
        value: string
    ): Promise<boolean> {
        const enums = await this.listEnums(framework, enumKey, {
            activeOnly: true
        })
        return enums.some((e) => e.value === value)
    }

    async modelHasCapability(
        framework: ConfigurableFramework,
        modelKey: string,
        capability: keyof FrameworkModelCapabilitiesView
    ): Promise<boolean> {
        const models = await this.listModels(framework, { activeOnly: true })
        const found = models.find((m) => m.modelKey === modelKey)
        return found?.capabilities?.[capability] === true
    }

    async createModel(input: CreateModelInput): Promise<FrameworkModelView> {
        const framework = this.requireFramework(input.framework)
        const kind = this.requireModelKind(input.kind)
        const modelKey = this.requireNonEmpty(input.modelKey, 'modelKey')
        const displayName = this.requireNonEmpty(
            input.displayName,
            'displayName'
        )
        const id = createObjectId('frameworkModelCatalogEntry')
        const isDefault = input.isDefault === true
        await this.db.transaction(async (tx) => {
            if (isDefault) {
                await tx
                    .update(frameworkModelCatalog)
                    .set({ isDefault: false, updatedAt: new Date() })
                    .where(
                        and(
                            eq(frameworkModelCatalog.framework, framework),
                            eq(frameworkModelCatalog.kind, kind),
                            eq(frameworkModelCatalog.isDefault, true)
                        )
                    )
            }
            await tx.insert(frameworkModelCatalog).values({
                id,
                framework,
                modelKey,
                kind,
                displayName,
                capabilities: input.capabilities ?? {},
                sortOrder: input.sortOrder ?? 0,
                isActive: input.isActive ?? true,
                isDefault
            })
        })
        this.invalidate(framework)
        const created = await this.findModel(id)
        if (!created) throw new NotFoundException('catalog model not found')
        return created
    }

    async updateModel(
        id: string,
        input: UpdateModelInput
    ): Promise<FrameworkModelView> {
        const existing = await this.findModelRow(id)
        if (!existing) throw new NotFoundException('catalog model not found')
        const framework = existing.framework as ConfigurableFramework
        const nextKind = input.kind
            ? this.requireModelKind(input.kind)
            : (existing.kind as FrameworkModelKind)
        const nextModelKey = input.modelKey
            ? this.requireNonEmpty(input.modelKey, 'modelKey')
            : existing.modelKey
        const nextDisplayName = input.displayName
            ? this.requireNonEmpty(input.displayName, 'displayName')
            : existing.displayName
        const nextIsDefault =
            input.isDefault === undefined ? existing.isDefault : input.isDefault
        await this.db.transaction(async (tx) => {
            if (nextIsDefault === true && existing.isDefault !== true) {
                await tx
                    .update(frameworkModelCatalog)
                    .set({ isDefault: false, updatedAt: new Date() })
                    .where(
                        and(
                            eq(frameworkModelCatalog.framework, framework),
                            eq(frameworkModelCatalog.kind, nextKind),
                            eq(frameworkModelCatalog.isDefault, true)
                        )
                    )
            }
            await tx
                .update(frameworkModelCatalog)
                .set({
                    modelKey: nextModelKey,
                    kind: nextKind,
                    displayName: nextDisplayName,
                    capabilities:
                        input.capabilities ??
                        (existing.capabilities as FrameworkModelCapabilitiesView),
                    sortOrder: input.sortOrder ?? existing.sortOrder,
                    isActive: input.isActive ?? existing.isActive,
                    isDefault: nextIsDefault,
                    updatedAt: new Date()
                })
                .where(eq(frameworkModelCatalog.id, id))
        })
        this.invalidate(framework)
        const updated = await this.findModel(id)
        if (!updated) throw new NotFoundException('catalog model not found')
        return updated
    }

    async deactivateModel(id: string): Promise<void> {
        const existing = await this.findModelRow(id)
        if (!existing) throw new NotFoundException('catalog model not found')
        await this.db
            .update(frameworkModelCatalog)
            .set({ isActive: false, isDefault: false, updatedAt: new Date() })
            .where(eq(frameworkModelCatalog.id, id))
        this.invalidate(existing.framework as ConfigurableFramework)
    }

    async createEnum(input: CreateEnumInput): Promise<FrameworkEnumView> {
        const framework = this.requireFramework(input.framework)
        const enumKey = this.requireEnumKey(input.enumKey)
        const value = this.requireNonEmpty(input.value, 'value')
        const displayName = this.requireNonEmpty(
            input.displayName,
            'displayName'
        )
        const id = createObjectId('frameworkEnumCatalogEntry')
        const isDefault = input.isDefault === true
        await this.db.transaction(async (tx) => {
            if (isDefault) {
                await tx
                    .update(frameworkEnumCatalog)
                    .set({ isDefault: false, updatedAt: new Date() })
                    .where(
                        and(
                            eq(frameworkEnumCatalog.framework, framework),
                            eq(frameworkEnumCatalog.enumKey, enumKey),
                            eq(frameworkEnumCatalog.isDefault, true)
                        )
                    )
            }
            await tx.insert(frameworkEnumCatalog).values({
                id,
                framework,
                enumKey,
                value,
                displayName,
                sortOrder: input.sortOrder ?? 0,
                isActive: input.isActive ?? true,
                isDefault
            })
        })
        this.invalidate(framework)
        const created = await this.findEnum(id)
        if (!created) throw new NotFoundException('catalog enum not found')
        return created
    }

    async updateEnum(
        id: string,
        input: UpdateEnumInput
    ): Promise<FrameworkEnumView> {
        const existing = await this.findEnumRow(id)
        if (!existing) throw new NotFoundException('catalog enum not found')
        const framework = existing.framework as ConfigurableFramework
        const enumKey = existing.enumKey as FrameworkEnumKey
        const nextValue = input.value
            ? this.requireNonEmpty(input.value, 'value')
            : existing.value
        const nextDisplayName = input.displayName
            ? this.requireNonEmpty(input.displayName, 'displayName')
            : existing.displayName
        const nextIsDefault =
            input.isDefault === undefined ? existing.isDefault : input.isDefault
        await this.db.transaction(async (tx) => {
            if (nextIsDefault === true && existing.isDefault !== true) {
                await tx
                    .update(frameworkEnumCatalog)
                    .set({ isDefault: false, updatedAt: new Date() })
                    .where(
                        and(
                            eq(frameworkEnumCatalog.framework, framework),
                            eq(frameworkEnumCatalog.enumKey, enumKey),
                            eq(frameworkEnumCatalog.isDefault, true)
                        )
                    )
            }
            await tx
                .update(frameworkEnumCatalog)
                .set({
                    value: nextValue,
                    displayName: nextDisplayName,
                    sortOrder: input.sortOrder ?? existing.sortOrder,
                    isActive: input.isActive ?? existing.isActive,
                    isDefault: nextIsDefault,
                    updatedAt: new Date()
                })
                .where(eq(frameworkEnumCatalog.id, id))
        })
        this.invalidate(framework)
        const updated = await this.findEnum(id)
        if (!updated) throw new NotFoundException('catalog enum not found')
        return updated
    }

    async deactivateEnum(id: string): Promise<void> {
        const existing = await this.findEnumRow(id)
        if (!existing) throw new NotFoundException('catalog enum not found')
        await this.db
            .update(frameworkEnumCatalog)
            .set({ isActive: false, isDefault: false, updatedAt: new Date() })
            .where(eq(frameworkEnumCatalog.id, id))
        this.invalidate(existing.framework as ConfigurableFramework)
    }

    private async getCached(
        framework: ConfigurableFramework
    ): Promise<CachedFramework> {
        const now = Date.now()
        const cached = this.cache.get(framework)
        if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached
        const [models, enums] = await Promise.all([
            this.db
                .select()
                .from(frameworkModelCatalog)
                .where(eq(frameworkModelCatalog.framework, framework))
                .orderBy(
                    asc(frameworkModelCatalog.sortOrder),
                    asc(frameworkModelCatalog.modelKey)
                ),
            this.db
                .select()
                .from(frameworkEnumCatalog)
                .where(eq(frameworkEnumCatalog.framework, framework))
                .orderBy(
                    asc(frameworkEnumCatalog.enumKey),
                    asc(frameworkEnumCatalog.sortOrder),
                    asc(frameworkEnumCatalog.value)
                )
        ])
        const fresh: CachedFramework = { fetchedAt: now, models, enums }
        this.cache.set(framework, fresh)
        return fresh
    }

    private invalidate(framework: ConfigurableFramework): void {
        this.cache.delete(framework)
    }

    private async findModelRow(
        id: string
    ): Promise<FrameworkModelCatalogRow | null> {
        const [row] = await this.db
            .select()
            .from(frameworkModelCatalog)
            .where(eq(frameworkModelCatalog.id, id))
            .limit(1)
        return row ?? null
    }

    private async findEnumRow(
        id: string
    ): Promise<FrameworkEnumCatalogRow | null> {
        const [row] = await this.db
            .select()
            .from(frameworkEnumCatalog)
            .where(eq(frameworkEnumCatalog.id, id))
            .limit(1)
        return row ?? null
    }

    private async findModel(id: string): Promise<FrameworkModelView | null> {
        const row = await this.findModelRow(id)
        return row ? modelRowToView(row) : null
    }

    private async findEnum(id: string): Promise<FrameworkEnumView | null> {
        const row = await this.findEnumRow(id)
        return row ? enumRowToView(row) : null
    }

    private requireFramework(value: unknown): ConfigurableFramework {
        if (!isConfigurableFramework(value))
            throw new BadRequestException(
                `framework must be one of: ${configurableFrameworks.join(', ')}`
            )
        return value
    }

    private requireEnumKey(value: unknown): FrameworkEnumKey {
        if (!isFrameworkEnumKey(value))
            throw new BadRequestException(
                `enumKey must be one of: ${frameworkEnumKeys.join(', ')}`
            )
        return value
    }

    private requireModelKind(value: unknown): FrameworkModelKind {
        if (
            typeof value !== 'string' ||
            !frameworkModelKinds.includes(value as FrameworkModelKind)
        )
            throw new BadRequestException(
                `kind must be one of: ${frameworkModelKinds.join(', ')}`
            )
        return value as FrameworkModelKind
    }

    private requireNonEmpty(value: unknown, field: string): string {
        if (typeof value !== 'string' || value.trim().length === 0)
            throw new BadRequestException(`${field} must be a non-empty string`)
        return value.trim()
    }
}
