import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { inArray, like } from 'drizzle-orm'
import {
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import {
    catalogCategories,
    createDb,
    mcpCatalogEntries,
    type Database
} from '@manyfold/db'
import { CatalogCategoriesService } from '../src/modules/catalog-categories/catalog-categories.service'
import { McpCatalogService } from '../src/modules/mcp-catalog/mcp-catalog.service'

// Real-Postgres proof of the DB-backed MCP catalog: create-side validation
// (transport pairing, slug conflicts, category domain), public list filtering
// (inactive hidden, q/tag/category, featured vs latest ordering, offset
// cursor), slug-keyed public DTOs, and the ON DELETE SET NULL category FK.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test test/mcp-catalog.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    suffix: string
    categories: CatalogCategoriesService
    catalog: McpCatalogService
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const categories = new CatalogCategoriesService(db)
    const catalog = new McpCatalogService(db, categories)
    return {
        db,
        suffix,
        categories,
        catalog,
        close: async (): Promise<void> => {
            await db
                .delete(mcpCatalogEntries)
                .where(like(mcpCatalogEntries.slug, `pgtest-${suffix}%`))
            await db
                .delete(catalogCategories)
                .where(like(catalogCategories.name, `PgTest ${suffix}%`))
        }
    }
}

const entryBody = (
    h: Harness,
    slug: string,
    overrides: Record<string, unknown> = {}
): never =>
    ({
        slug: `pgtest-${h.suffix}-${slug}`,
        name: `PgTest ${h.suffix} ${slug}`,
        description: `pg test entry ${slug}`,
        homepageUrl: 'https://example.com',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        ...overrides
    }) as never

test('mcp catalog admin create validates transport, slug and category', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        await assert.rejects(
            h.catalog.adminCreate(entryBody(h, 'nourl', { url: undefined })),
            BadRequestException
        )
        await assert.rejects(
            h.catalog.adminCreate(
                entryBody(h, 'nocmd', { transport: 'stdio', url: undefined })
            ),
            BadRequestException
        )

        const skillCategory = await h.categories.create({
            domain: 'skill',
            name: `PgTest ${h.suffix} SkillCat`
        })
        await assert.rejects(
            h.catalog.adminCreate(
                entryBody(h, 'wrongdomain', { categoryId: skillCategory.id })
            ),
            BadRequestException
        )

        const created = await h.catalog.adminCreate(entryBody(h, 'alpha'))
        assert.match(created.id, /^mcp_[a-z2-7]{26}$/)
        assert.equal(created.slug, `pgtest-${h.suffix}-alpha`)

        await assert.rejects(
            h.catalog.adminCreate(entryBody(h, 'alpha')),
            ConflictException
        )

        const stdio = await h.catalog.adminCreate(
            entryBody(h, 'stdio', {
                transport: 'stdio',
                url: undefined,
                command: 'npx',
                args: ['-y', 'some-mcp'],
                env: { API_KEY: '${API_KEY}' }
            })
        )
        assert.equal(stdio.command, 'npx')
        assert.deepEqual(stdio.args, ['-y', 'some-mcp'])
    } finally {
        await h.close()
    }
})

test('mcp catalog public list filters, sorts and paginates', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const category = await h.categories.create({
            domain: 'mcp',
            name: `PgTest ${h.suffix} McpCat`
        })
        const base = new Date('2026-01-01T00:00:00.000Z')
        const mk = async (
            slug: string,
            overrides: Record<string, unknown>
        ): Promise<void> => {
            await h.db.insert(mcpCatalogEntries).values({
                id: `mcp_pgtest${h.suffix}${slug}`.slice(0, 30),
                slug: `pgtest-${h.suffix}-${slug}`,
                name: `PgTest ${h.suffix} ${slug}`,
                description: `pg test ${slug}`,
                homepageUrl: 'https://example.com',
                transport: 'http',
                url: 'https://mcp.example.com/mcp',
                tags: [],
                ...overrides
            } as never)
        }
        await mk('aaa', {
            featured: true,
            sortOrder: 1,
            createdAt: base,
            tags: [`tag-${h.suffix}`]
        })
        await mk('bbb', {
            sortOrder: 2,
            createdAt: new Date(base.getTime() + 60_000),
            categoryId: category.id
        })
        await mk('ccc', { isActive: false, sortOrder: 0, createdAt: base })

        const q = `PgTest ${h.suffix}`
        const featured = await h.catalog.listPublic({ q })
        assert.deepEqual(
            featured.items.map((e) => e.id),
            [`pgtest-${h.suffix}-aaa`, `pgtest-${h.suffix}-bbb`]
        )
        assert.equal(featured.items[0].featured, true)
        assert.equal(featured.nextCursor, null)

        const latest = await h.catalog.listPublic({ q, sort: 'latest' })
        assert.deepEqual(
            latest.items.map((e) => e.id),
            [`pgtest-${h.suffix}-bbb`, `pgtest-${h.suffix}-aaa`]
        )

        const tagged = await h.catalog.listPublic({
            q,
            tag: `tag-${h.suffix}`
        })
        assert.deepEqual(
            tagged.items.map((e) => e.id),
            [`pgtest-${h.suffix}-aaa`]
        )

        const inCategory = await h.catalog.listPublic({
            q,
            categoryId: category.id
        })
        assert.deepEqual(
            inCategory.items.map((e) => e.id),
            [`pgtest-${h.suffix}-bbb`]
        )
        assert.deepEqual(inCategory.items[0].category, {
            id: category.id,
            name: category.name
        })

        const pageOne = await h.catalog.listPublic({ q, limit: 1 })
        assert.equal(pageOne.items.length, 1)
        assert.equal(pageOne.nextCursor, '1')
        const pageTwo = await h.catalog.listPublic({
            q,
            limit: 1,
            cursor: pageOne.nextCursor ?? undefined
        })
        assert.equal(pageTwo.items.length, 1)
        assert.notEqual(pageTwo.items[0].id, pageOne.items[0].id)

        await assert.rejects(
            h.catalog.getBySlug(`pgtest-${h.suffix}-ccc`),
            NotFoundException
        )
        const bySlug = await h.catalog.getBySlug(`pgtest-${h.suffix}-aaa`)
        assert.equal(bySlug.id, `pgtest-${h.suffix}-aaa`)
    } finally {
        await h.close()
    }
})

test('mcp catalog category delete clears references and CRUD round-trips', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const category = await h.categories.create({
            domain: 'mcp',
            name: `PgTest ${h.suffix} DeleteMe`
        })
        await assert.rejects(
            h.categories.create({
                domain: 'mcp',
                name: `PgTest ${h.suffix} DeleteMe`
            }),
            ConflictException
        )
        const renamed = await h.categories.update(category.id, {
            name: `PgTest ${h.suffix} Renamed`,
            sortOrder: 5
        })
        assert.equal(renamed.sortOrder, 5)

        const entry = await h.catalog.adminCreate(
            entryBody(h, 'withcat', { categoryId: category.id })
        )
        assert.equal(entry.categoryId, category.id)

        await h.categories.delete(category.id)
        const after = await h.catalog.adminGet(entry.id)
        assert.equal(after.categoryId, null)

        await h.catalog.adminDelete(entry.id)
        await assert.rejects(h.catalog.adminGet(entry.id), NotFoundException)
    } finally {
        await h.close()
    }
})

test('mcp catalog admin update revalidates the merged transport shape', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const entry = await h.catalog.adminCreate(entryBody(h, 'merge'))
        await assert.rejects(
            h.catalog.adminUpdate(entry.id, { transport: 'stdio' }),
            BadRequestException
        )
        const switched = await h.catalog.adminUpdate(entry.id, {
            transport: 'stdio',
            url: null,
            command: 'npx'
        })
        assert.equal(switched.transport, 'stdio')
        assert.equal(switched.url, null)

        const deactivated = await h.catalog.adminUpdate(entry.id, {
            isActive: false
        })
        assert.equal(deactivated.isActive, false)
        const list = await h.catalog.adminList({ q: `PgTest ${h.suffix}` })
        assert.ok(
            list.items.some((item) => item.id === entry.id),
            'admin list keeps inactive entries visible'
        )
        await h.db
            .delete(mcpCatalogEntries)
            .where(inArray(mcpCatalogEntries.id, [entry.id]))
    } finally {
        await h.close()
    }
})
