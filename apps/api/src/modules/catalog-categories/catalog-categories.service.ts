import {
    CatalogCategorySummary,
    CatalogDomain,
    CreateCatalogCategoryBody,
    UpdateCatalogCategoryBody,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { asc, eq } from 'drizzle-orm'
import { catalogCategories, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

type CategoryRow = typeof catalogCategories.$inferSelect

const rowToSummary = (row: CategoryRow): CatalogCategorySummary => ({
    id: row.id,
    domain: row.domain,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class CatalogCategoriesService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async list(domain?: CatalogDomain): Promise<CatalogCategorySummary[]> {
        const rows = await this.db
            .select()
            .from(catalogCategories)
            .where(domain ? eq(catalogCategories.domain, domain) : undefined)
            .orderBy(
                asc(catalogCategories.domain),
                asc(catalogCategories.sortOrder),
                asc(catalogCategories.name)
            )
        return rows.map(rowToSummary)
    }

    async create(
        body: CreateCatalogCategoryBody
    ): Promise<CatalogCategorySummary> {
        const name = body.name.trim()
        if (!name) throw new BadRequestException('name is required')
        try {
            const [row] = await this.db
                .insert(catalogCategories)
                .values({
                    id: createObjectId('catalogCategory'),
                    domain: body.domain,
                    name,
                    sortOrder: body.sortOrder ?? 0
                })
                .returning()
            return rowToSummary(row)
        } catch (err) {
            throw translateUniqueViolation(err, name)
        }
    }

    async update(
        id: string,
        body: UpdateCatalogCategoryBody
    ): Promise<CatalogCategorySummary> {
        const name = body.name?.trim()
        if (body.name !== undefined && !name)
            throw new BadRequestException('name is required')
        try {
            const [row] = await this.db
                .update(catalogCategories)
                .set({
                    ...(name !== undefined ? { name } : {}),
                    ...(body.sortOrder !== undefined
                        ? { sortOrder: body.sortOrder }
                        : {}),
                    updatedAt: new Date()
                })
                .where(eq(catalogCategories.id, id))
                .returning()
            if (!row) throw new NotFoundException('category not found')
            return rowToSummary(row)
        } catch (err) {
            throw translateUniqueViolation(err, name ?? id)
        }
    }

    async delete(id: string): Promise<void> {
        const rows = await this.db
            .delete(catalogCategories)
            .where(eq(catalogCategories.id, id))
            .returning({ id: catalogCategories.id })
        if (rows.length === 0) throw new NotFoundException('category not found')
    }

    async requireCategory(
        id: string,
        domain: CatalogDomain
    ): Promise<CategoryRow> {
        const [row] = await this.db
            .select()
            .from(catalogCategories)
            .where(eq(catalogCategories.id, id))
            .limit(1)
        if (!row || row.domain !== domain)
            throw new BadRequestException(
                `unknown ${domain} category: ${id}`
            )
        return row
    }
}

const translateUniqueViolation = (err: unknown, name: string): unknown => {
    if (
        err instanceof Error &&
        err.message.includes('catalog_categories_domain_name_unique')
    )
        return new ConflictException(`category "${name}" already exists`)
    return err
}
