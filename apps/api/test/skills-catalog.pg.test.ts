import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, like } from 'drizzle-orm'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import {
    catalogCategories,
    createDb,
    skills,
    users,
    type Database
} from '@manyfold/db'
import type { ScannedSkillSummary } from '../src/modules/skills/skill-discovery.service'
import { CatalogCategoriesService } from '../src/modules/catalog-categories/catalog-categories.service'
import { SkillsService } from '../src/modules/skills/skills.service'

// Real-Postgres proof of the SQL-backed skills catalog: legacy bare-array
// discover (hidden excluded, name ASC), the paged variant (cursor math,
// ILIKE with %/_ escaping, tag containment, category filter, featured/latest
// ordering), detail 404s (hidden / out-of-repo-set), curation-only admin
// PATCH, and curation surviving a re-discovery upsert. Env-gated:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test test/skills-catalog.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

class StubDiscovery {
    scanResult: ScannedSkillSummary[] = []
    scanCallCount = 0

    constructor(private readonly repo: {
        owner: string
        name: string
        branch: string
    }) {}

    async builtinRepos(): Promise<unknown[]> {
        return [
            {
                id: `builtin:${this.repo.owner}/${this.repo.name}@${this.repo.branch}`,
                owner: this.repo.owner,
                name: this.repo.name,
                branch: this.repo.branch,
                enabled: true,
                readonly: true,
                createdAt: null,
                updatedAt: null
            }
        ]
    }

    async scanRepos(): Promise<{
        rows: ScannedSkillSummary[]
        truncatedRepoIds: string[]
    }> {
        this.scanCallCount++
        return { rows: this.scanResult, truncatedRepoIds: [] }
    }

    async discoverOne(): Promise<ScannedSkillSummary | null> {
        return null
    }

    async fetchRepoFile(): Promise<string | null> {
        return null
    }
}

interface Harness {
    db: Database
    suffix: string
    userId: string
    repoOwner: string
    discovery: StubDiscovery
    service: SkillsService
    categories: CatalogCategoriesService
    skillId: (slug: string) => string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const repoOwner = `pgtest-${suffix}`
    const userId = `user_pgtest_${suffix}`
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    const discovery = new StubDiscovery({
        owner: repoOwner,
        name: 'repo',
        branch: 'main'
    })
    const service = new SkillsService(
        db,
        discovery as never,
        {} as never
    )
    const categories = new CatalogCategoriesService(db)
    return {
        db,
        suffix,
        userId,
        repoOwner,
        discovery,
        service,
        categories,
        skillId: (slug: string) =>
            `github:${repoOwner}/repo@main:skills/${slug}`,
        close: async (): Promise<void> => {
            await db.delete(skills).where(eq(skills.repoOwner, repoOwner))
            await db
                .delete(catalogCategories)
                .where(like(catalogCategories.name, `PgTest ${suffix}%`))
            await db.delete(users).where(eq(users.id, userId))
        }
    }
}

const insertSkill = async (
    h: Harness,
    slug: string,
    overrides: Record<string, unknown> = {}
): Promise<string> => {
    const id = h.skillId(slug)
    await h.db.insert(skills).values({
        id,
        name: `pg ${slug}`,
        description: `pg test skill ${slug}`,
        repoOwner: h.repoOwner,
        repoName: 'repo',
        repoBranch: 'main',
        sourcePath: `skills/${slug}`,
        latestRevision: 'rev-1',
        readmeUrl: null,
        updatedAt: new Date(),
        ...overrides
    } as never)
    return id
}

test('skills discover keeps the legacy bare-array contract minus hidden rows', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        await insertSkill(h, 'bravo')
        await insertSkill(h, 'alpha')
        await insertSkill(h, 'zulu-hidden', { hidden: true })

        const result = await h.service.discover({ userId: h.userId })
        assert.deepEqual(
            result.map((s) => s.name),
            ['pg alpha', 'pg bravo']
        )
        assert.equal(result[0].installed, false)
        assert.deepEqual(result[0].tags, [])
        assert.equal(result[0].category, null)
    } finally {
        await h.close()
    }
})

test('skills discoverPage filters, sorts, escapes and paginates', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const category = await h.categories.create({
            domain: 'skill',
            name: `PgTest ${h.suffix} Cat`
        })
        const base = new Date('2026-01-01T00:00:00.000Z')
        await insertSkill(h, 'aaa', {
            featured: true,
            createdAt: base,
            tags: [`tag-${h.suffix}`]
        })
        await insertSkill(h, 'bbb', {
            createdAt: new Date(base.getTime() + 60_000),
            categoryId: category.id
        })
        await insertSkill(h, 'percent', {
            name: `pg 100% ${h.suffix}`,
            createdAt: new Date(base.getTime() + 120_000)
        })

        const featured = await h.service.discoverPage({ userId: h.userId })
        assert.equal(featured.items[0].name, 'pg aaa')
        assert.equal(featured.items[0].featured, true)

        const latest = await h.service.discoverPage({
            userId: h.userId,
            sort: 'latest'
        })
        assert.equal(latest.items[0].name, `pg 100% ${h.suffix}`)

        const escaped = await h.service.discoverPage({
            userId: h.userId,
            q: '100%'
        })
        assert.deepEqual(
            escaped.items.map((s) => s.name),
            [`pg 100% ${h.suffix}`]
        )
        const noMatch = await h.service.discoverPage({
            userId: h.userId,
            q: '1004'
        })
        assert.equal(noMatch.items.length, 0)

        const tagged = await h.service.discoverPage({
            userId: h.userId,
            tag: `tag-${h.suffix}`
        })
        assert.deepEqual(
            tagged.items.map((s) => s.name),
            ['pg aaa']
        )

        const inCategory = await h.service.discoverPage({
            userId: h.userId,
            categoryId: category.id
        })
        assert.deepEqual(
            inCategory.items.map((s) => s.name),
            ['pg bbb']
        )
        assert.deepEqual(inCategory.items[0].category, {
            id: category.id,
            name: category.name
        })

        const unknownCategory = await h.service.discoverPage({
            userId: h.userId,
            categoryId: 'cat_doesnotexist'
        })
        assert.equal(unknownCategory.items.length, 0)

        const pageOne = await h.service.discoverPage({
            userId: h.userId,
            limit: 2
        })
        assert.equal(pageOne.items.length, 2)
        assert.equal(pageOne.nextCursor, '2')
        const pageTwo = await h.service.discoverPage({
            userId: h.userId,
            limit: 2,
            cursor: pageOne.nextCursor ?? undefined
        })
        assert.equal(pageTwo.items.length, 1)
        assert.equal(pageTwo.nextCursor, null)
    } finally {
        await h.close()
    }
})

test('skills detail 404s for hidden and out-of-repo-set rows', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const visibleId = await insertSkill(h, 'visible')
        const hiddenId = await insertSkill(h, 'hidden', { hidden: true })
        const foreignId = `github:someoneelse-${h.suffix}/repo@main:skills/x`
        await h.db.insert(skills).values({
            id: foreignId,
            name: 'pg foreign',
            description: null,
            repoOwner: `someoneelse-${h.suffix}`,
            repoName: 'repo',
            repoBranch: 'main',
            sourcePath: 'skills/x'
        })

        const detail = await h.service.detail({
            userId: h.userId,
            skillId: visibleId
        })
        assert.equal(detail.skillId, visibleId)

        await assert.rejects(
            h.service.detail({ userId: h.userId, skillId: hiddenId }),
            NotFoundException
        )
        await assert.rejects(
            h.service.detail({ userId: h.userId, skillId: foreignId }),
            NotFoundException
        )
        await h.db.delete(skills).where(eq(skills.id, foreignId))
    } finally {
        await h.close()
    }
})

test('skills admin curation patches only curation fields and survives re-discovery', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const id = await insertSkill(h, 'curate')
        const skillCategory = await h.categories.create({
            domain: 'skill',
            name: `PgTest ${h.suffix} Curation`
        })
        const mcpCategory = await h.categories.create({
            domain: 'mcp',
            name: `PgTest ${h.suffix} WrongDomain`
        })

        await assert.rejects(
            h.service.adminUpdateCuration(id, {
                categoryId: mcpCategory.id
            }),
            BadRequestException
        )
        await assert.rejects(
            h.service.adminUpdateCuration('github:missing/repo@main:x', {
                featured: true
            }),
            NotFoundException
        )

        const updated = await h.service.adminUpdateCuration(id, {
            categoryId: skillCategory.id,
            tags: [` alpha `, 'beta', 'alpha', ''],
            featured: true,
            hidden: true
        })
        assert.equal(updated.categoryId, skillCategory.id)
        assert.deepEqual(updated.tags, ['alpha', 'beta'])
        assert.equal(updated.featured, true)
        assert.equal(updated.hidden, true)
        assert.equal(updated.name, 'pg curate')

        // hidden rows disappear from the public list but stay in admin
        const publicList = await h.service.discoverPage({ userId: h.userId })
        assert.ok(!publicList.items.some((s) => s.skillId === id))
        const adminList = await h.service.adminListCatalog({
            q: `pg curate`
        })
        assert.ok(adminList.items.some((s) => s.skillId === id))

        // a re-discovery upsert refreshes discovery-owned fields but keeps
        // the curation columns
        h.discovery.scanResult = [
            {
                skillId: id,
                name: 'pg curate renamed',
                description: 'refreshed description',
                repoOwner: h.repoOwner,
                repoName: 'repo',
                repoBranch: 'main',
                sourcePath: 'skills/curate',
                latestRevision: 'rev-2',
                version: null,
                readmeUrl: null,
                installDir: 'pg-curate',
                installed: false,
                enabled: false,
                userSkillId: null,
                repoId: `builtin:${h.repoOwner}/repo@main`,
                repoReadonly: true,
                category: null,
                tags: [],
                featured: false
            }
        ]
        await h.service.refreshDiscover({ userId: h.userId })

        const [row] = await h.db
            .select()
            .from(skills)
            .where(eq(skills.id, id))
            .limit(1)
        assert.equal(row.name, 'pg curate renamed')
        assert.equal(row.latestRevision, 'rev-2')
        assert.equal(row.categoryId, skillCategory.id)
        assert.deepEqual(row.tags, ['alpha', 'beta'])
        assert.equal(row.featured, true)
        assert.equal(row.hidden, true)
    } finally {
        await h.close()
    }
})

test('upsert does not crash on real PG and respects scan TTL when revision unchanged (#431)', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const id = h.skillId('ttl-probe')
        const scanRow = (rev: string): ScannedSkillSummary => ({
            skillId: id,
            name: 'pg ttl-probe',
            description: 'ttl regression',
            repoOwner: h.repoOwner,
            repoName: 'repo',
            repoBranch: 'main',
            sourcePath: 'skills/ttl-probe',
            latestRevision: rev,
            version: null,
            readmeUrl: null,
            installDir: 'pg-ttl-probe',
            installed: false,
            enabled: false,
            userSkillId: null,
            repoId: `builtin:${h.repoOwner}/repo@main`,
            repoReadonly: true,
            category: null,
            tags: [],
            featured: false
        })

        // --- 1. revision-changed upsert should succeed ---
        h.discovery.scanResult = [scanRow('rev-A')]
        h.discovery.scanCallCount = 0
        await h.service.refreshDiscover({ userId: h.userId })
        assert.equal(h.discovery.scanCallCount, 1, 'first refresh should scan')

        const [afterFirst] = await h.db
            .select()
            .from(skills)
            .where(eq(skills.id, id))
            .limit(1)
        assert.ok(afterFirst, 'row should exist after first upsert')
        assert.equal(afterFirst.latestRevision, 'rev-A')
        const firstUpdatedAt = afterFirst.updatedAt.getTime()
        const firstScannedAt = afterFirst.scannedAt?.getTime()
        assert.ok(firstScannedAt, 'scannedAt should be set')

        // --- 2. revision-unchanged re-upsert should NOT crash ---
        //     updatedAt stays the same, scannedAt advances
        // Small delay so timestamps differ
        await new Promise((r) => setTimeout(r, 50))
        h.discovery.scanResult = [scanRow('rev-A')] // same revision
        h.discovery.scanCallCount = 0
        await h.service.refreshDiscover({ userId: h.userId })
        assert.equal(h.discovery.scanCallCount, 1, 'second refresh should scan (forced)')

        const [afterSecond] = await h.db
            .select()
            .from(skills)
            .where(eq(skills.id, id))
            .limit(1)
        assert.equal(afterSecond.latestRevision, 'rev-A')
        assert.equal(
            afterSecond.updatedAt.getTime(),
            firstUpdatedAt,
            'updatedAt must NOT change when revision is unchanged'
        )
        assert.ok(
            afterSecond.scannedAt!.getTime() >= firstScannedAt!,
            'scannedAt should advance even when revision is unchanged'
        )

        // --- 3. background stale check should NOT re-scan within TTL ---
        h.discovery.scanCallCount = 0
        // discoverPage fires refreshStaleDiscoverRepos in the background;
        // await a tick so the fire-and-forget promise settles.
        await h.service.discoverPage({ userId: h.userId })
        // Give the background refresh a moment to settle
        await new Promise((r) => setTimeout(r, 200))
        assert.equal(
            h.discovery.scanCallCount,
            0,
            'within TTL the background refresh must not re-scan'
        )

        // --- 4. revision-changed path bumps updatedAt ---
        h.discovery.scanResult = [scanRow('rev-B')]
        await h.service.refreshDiscover({ userId: h.userId })
        const [afterThird] = await h.db
            .select()
            .from(skills)
            .where(eq(skills.id, id))
            .limit(1)
        assert.equal(afterThird.latestRevision, 'rev-B')
        assert.ok(
            afterThird.updatedAt.getTime() > firstUpdatedAt,
            'updatedAt must bump when revision changes'
        )
    } finally {
        await h.close()
    }
})

