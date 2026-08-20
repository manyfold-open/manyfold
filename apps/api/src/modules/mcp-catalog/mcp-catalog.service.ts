import {
    AdminMcpCatalogEntry,
    AdminMcpCatalogPage,
    CatalogCategoryRef,
    CatalogSort,
    CreateMcpCatalogEntryBody,
    McpCatalogEntry,
    McpCatalogPage,
    UpdateMcpCatalogEntryBody,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import {
    catalogCategories,
    mcpCatalogEntries,
    type Database,
    type McpCatalogEntryRow
} from '@manyfold/db'
import {
    clampPageLimit,
    likeNeedle,
    normalizeCatalogTags,
    parseOffsetCursor
} from '@/common/catalog-query'
import { DRIZZLE } from '@/db/tokens'
import { CatalogCategoriesService } from '@/modules/catalog-categories/catalog-categories.service'

const PUBLIC_DEFAULT_LIMIT = 24
const PUBLIC_MAX_LIMIT = 100
const ADMIN_DEFAULT_LIMIT = 50
const ADMIN_MAX_LIMIT = 200

export interface PublicMcpCatalogQuery {
    q?: string
    categoryId?: string
    tag?: string
    sort?: CatalogSort
    cursor?: string
    limit?: number
}

export interface AdminMcpCatalogQuery {
    q?: string
    cursor?: string
    limit?: number
}

type JoinedRow = {
    entry: McpCatalogEntryRow
    categoryName: string | null
}

const categoryRef = (row: JoinedRow): CatalogCategoryRef | null =>
    row.entry.categoryId && row.categoryName !== null
        ? { id: row.entry.categoryId, name: row.categoryName }
        : null

const rowToPublic = (row: JoinedRow): McpCatalogEntry => ({
    id: row.entry.slug,
    name: row.entry.name,
    description: row.entry.description,
    longDescription: row.entry.longDescription,
    iconUrl: row.entry.iconUrl,
    homepageUrl: row.entry.homepageUrl,
    transport: row.entry.transport,
    ...(row.entry.url != null ? { url: row.entry.url } : {}),
    ...(row.entry.headers != null ? { headers: row.entry.headers } : {}),
    ...(row.entry.command != null ? { command: row.entry.command } : {}),
    ...(row.entry.args != null ? { args: row.entry.args } : {}),
    ...(row.entry.env != null ? { env: row.entry.env } : {}),
    tags: row.entry.tags,
    category: categoryRef(row),
    featured: row.entry.featured
})

const rowToAdmin = (row: McpCatalogEntryRow): AdminMcpCatalogEntry => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    longDescription: row.longDescription,
    iconUrl: row.iconUrl,
    homepageUrl: row.homepageUrl,
    transport: row.transport,
    url: row.url,
    headers: row.headers,
    command: row.command,
    args: row.args,
    env: row.env,
    tags: row.tags,
    categoryId: row.categoryId,
    featured: row.featured,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const validateTransportFields = (entry: {
    transport: string
    url: string | null
    command: string | null
}): void => {
    if (entry.transport === 'http') {
        if (!entry.url || !/^https?:\/\//.test(entry.url))
            throw new BadRequestException(
                'http transport requires a url starting with http(s)://'
            )
    } else if (!entry.command) {
        throw new BadRequestException('stdio transport requires a command')
    }
}

const translateSlugConflict = (err: unknown, slug: string): unknown => {
    if (
        err instanceof Error &&
        err.message.includes('mcp_catalog_entries_slug_unique')
    )
        return new ConflictException(`slug "${slug}" already exists`)
    return err
}

@Injectable()
export class McpCatalogService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly categories: CatalogCategoriesService
    ) {}

    async listPublic(query: PublicMcpCatalogQuery): Promise<McpCatalogPage> {
        const limit = clampPageLimit(
            query.limit,
            PUBLIC_DEFAULT_LIMIT,
            PUBLIC_MAX_LIMIT
        )
        const offset = parseOffsetCursor(query.cursor)
        const conds: SQL[] = [eq(mcpCatalogEntries.isActive, true)]
        this.applyFilters(conds, query)
        const order =
            query.sort === 'latest'
                ? [
                      desc(mcpCatalogEntries.createdAt),
                      asc(mcpCatalogEntries.name)
                  ]
                : [
                      desc(mcpCatalogEntries.featured),
                      asc(mcpCatalogEntries.sortOrder),
                      asc(mcpCatalogEntries.name)
                  ]
        const rows = await this.joinedSelect()
            .where(and(...conds))
            .orderBy(...order)
            .limit(limit + 1)
            .offset(offset)
        const hasMore = rows.length > limit
        const sliced = hasMore ? rows.slice(0, limit) : rows
        return {
            items: sliced.map(rowToPublic),
            nextCursor: hasMore ? String(offset + limit) : null
        }
    }

    async getBySlug(slug: string): Promise<McpCatalogEntry> {
        const rows = await this.joinedSelect()
            .where(
                and(
                    eq(mcpCatalogEntries.slug, slug),
                    eq(mcpCatalogEntries.isActive, true)
                )
            )
            .limit(1)
        if (rows.length === 0)
            throw new NotFoundException('mcp catalog entry not found')
        return rowToPublic(rows[0])
    }

    async adminList(query: AdminMcpCatalogQuery): Promise<AdminMcpCatalogPage> {
        const limit = clampPageLimit(
            query.limit,
            ADMIN_DEFAULT_LIMIT,
            ADMIN_MAX_LIMIT
        )
        const offset = parseOffsetCursor(query.cursor)
        const conds: SQL[] = []
        if (query.q)
            conds.push(
                or(
                    ilike(mcpCatalogEntries.name, likeNeedle(query.q)),
                    ilike(mcpCatalogEntries.slug, likeNeedle(query.q)),
                    ilike(mcpCatalogEntries.description, likeNeedle(query.q))
                ) as SQL
            )
        const rows = await this.db
            .select()
            .from(mcpCatalogEntries)
            .where(conds.length > 0 ? and(...conds) : undefined)
            .orderBy(
                asc(mcpCatalogEntries.sortOrder),
                asc(mcpCatalogEntries.name)
            )
            .limit(limit + 1)
            .offset(offset)
        const hasMore = rows.length > limit
        const sliced = hasMore ? rows.slice(0, limit) : rows
        return {
            items: sliced.map(rowToAdmin),
            nextCursor: hasMore ? String(offset + limit) : null
        }
    }

    async adminGet(id: string): Promise<AdminMcpCatalogEntry> {
        const [row] = await this.db
            .select()
            .from(mcpCatalogEntries)
            .where(eq(mcpCatalogEntries.id, id))
            .limit(1)
        if (!row) throw new NotFoundException('mcp catalog entry not found')
        return rowToAdmin(row)
    }

    async adminCreate(
        body: CreateMcpCatalogEntryBody
    ): Promise<AdminMcpCatalogEntry> {
        validateTransportFields({
            transport: body.transport,
            url: body.url ?? null,
            command: body.command ?? null
        })
        if (body.categoryId)
            await this.categories.requireCategory(body.categoryId, 'mcp')
        try {
            const [row] = await this.db
                .insert(mcpCatalogEntries)
                .values({
                    id: createObjectId('mcpCatalogEntry'),
                    slug: body.slug,
                    name: body.name.trim(),
                    description: body.description,
                    longDescription: body.longDescription ?? null,
                    iconUrl: body.iconUrl ?? null,
                    homepageUrl: body.homepageUrl,
                    transport: body.transport,
                    url: body.url ?? null,
                    headers: body.headers ?? null,
                    command: body.command ?? null,
                    args: body.args ?? null,
                    env: body.env ?? null,
                    tags: normalizeCatalogTags(body.tags),
                    categoryId: body.categoryId ?? null,
                    featured: body.featured ?? false,
                    sortOrder: body.sortOrder ?? 0,
                    isActive: body.isActive ?? true
                })
                .returning()
            return rowToAdmin(row)
        } catch (err) {
            throw translateSlugConflict(err, body.slug)
        }
    }

    async adminUpdate(
        id: string,
        body: UpdateMcpCatalogEntryBody
    ): Promise<AdminMcpCatalogEntry> {
        const [existing] = await this.db
            .select()
            .from(mcpCatalogEntries)
            .where(eq(mcpCatalogEntries.id, id))
            .limit(1)
        if (!existing)
            throw new NotFoundException('mcp catalog entry not found')
        const merged = {
            transport: body.transport ?? existing.transport,
            url: body.url === undefined ? existing.url : body.url,
            command:
                body.command === undefined ? existing.command : body.command
        }
        validateTransportFields(merged)
        if (body.categoryId)
            await this.categories.requireCategory(body.categoryId, 'mcp')
        const set: Partial<McpCatalogEntryRow> = { updatedAt: new Date() }
        if (body.slug !== undefined) set.slug = body.slug
        if (body.name !== undefined) set.name = body.name.trim()
        if (body.description !== undefined) set.description = body.description
        if (body.homepageUrl !== undefined) set.homepageUrl = body.homepageUrl
        if (body.transport !== undefined) set.transport = body.transport
        if (body.url !== undefined) set.url = body.url
        if (body.headers !== undefined) set.headers = body.headers
        if (body.command !== undefined) set.command = body.command
        if (body.args !== undefined) set.args = body.args
        if (body.env !== undefined) set.env = body.env
        if (body.longDescription !== undefined)
            set.longDescription = body.longDescription
        if (body.iconUrl !== undefined) set.iconUrl = body.iconUrl
        if (body.tags !== undefined) set.tags = normalizeCatalogTags(body.tags)
        if (body.categoryId !== undefined) set.categoryId = body.categoryId
        if (body.featured !== undefined) set.featured = body.featured
        if (body.sortOrder !== undefined) set.sortOrder = body.sortOrder
        if (body.isActive !== undefined) set.isActive = body.isActive
        try {
            const [row] = await this.db
                .update(mcpCatalogEntries)
                .set(set)
                .where(eq(mcpCatalogEntries.id, id))
                .returning()
            return rowToAdmin(row)
        } catch (err) {
            throw translateSlugConflict(err, body.slug ?? existing.slug)
        }
    }

    async adminDelete(id: string): Promise<void> {
        const rows = await this.db
            .delete(mcpCatalogEntries)
            .where(eq(mcpCatalogEntries.id, id))
            .returning({ id: mcpCatalogEntries.id })
        if (rows.length === 0)
            throw new NotFoundException('mcp catalog entry not found')
    }

    private joinedSelect() {
        return this.db
            .select({
                entry: mcpCatalogEntries,
                categoryName: catalogCategories.name
            })
            .from(mcpCatalogEntries)
            .leftJoin(
                catalogCategories,
                eq(mcpCatalogEntries.categoryId, catalogCategories.id)
            )
    }

    private applyFilters(conds: SQL[], query: PublicMcpCatalogQuery): void {
        if (query.q)
            conds.push(
                or(
                    ilike(mcpCatalogEntries.name, likeNeedle(query.q)),
                    ilike(mcpCatalogEntries.slug, likeNeedle(query.q)),
                    ilike(mcpCatalogEntries.description, likeNeedle(query.q))
                ) as SQL
            )
        if (query.categoryId)
            conds.push(eq(mcpCatalogEntries.categoryId, query.categoryId))
        if (query.tag)
            conds.push(
                sql`${mcpCatalogEntries.tags} @> ${JSON.stringify([query.tag])}::jsonb`
            )
    }
}
