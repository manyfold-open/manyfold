import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
    createDb,
    skillRepoScans,
    skills,
    users,
    librarySkills,
    librarySkillFiles
} from '@manyfold/db'
import { agents, agentRuntimes } from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import { SkillsService } from '../src/modules/skills/skills.service'
import {
    SkillDiscoveryService,
    type DiscoveryRepo
} from '../src/modules/skills/skill-discovery.service'
import {
    refreshSkillRepo,
    staleSkillRepos,
    canonicalSkillRepoKey,
    SkillScanBusyError
} from '../src/modules/skills/skill-catalog-scan'
import { LibrarySkillsService } from '../src/modules/skills/library-skills.service'
import {
    githubFixture,
    REVISION_A,
    REVISION_B
} from './helpers/github-discovery-fixture'

const RUN = process.env.RUN_PG_E2E === '1'

test(
    'a foreground install reports retryable busy during another instance scan and later publishes its case alias',
    { skip: !RUN, timeout: 10_000 },
    async (t) => {
        const h = await harness(t)
        const alias = { ...h.repo, owner: h.repo.owner.toUpperCase() }
        const userId = createObjectId('user')
        const runtimeId = createObjectId('agentRuntime')
        const agentId = createObjectId('agent')
        await h.db
            .insert(users)
            .values({ id: userId, email: `${userId}@example.invalid` })
        h.cleanups.push(async () =>
            h.db.delete(users).where(eq(users.id, userId))
        )
        await h.db
            .insert(agentRuntimes)
            .values({
                id: runtimeId,
                userId,
                name: 'fixture',
                framework: 'codex',
                kind: 'daemon',
                status: 'ready'
            })
        await h.db
            .insert(agents)
            .values({
                id: agentId,
                userId,
                name: 'fixture',
                framework: 'codex',
                runtime: 'daemon',
                runtimeId,
                internalId: 'fixture'
            })
        const first = new SkillsService(
            h.db,
            h.discovery,
            {} as never,
            {} as never
        )
        const discovery2 = new SkillDiscoveryService({} as never, {} as never)
        const second = new SkillsService(
            h.db2,
            discovery2,
            { materializeAgent: async () => [] } as never,
            {} as never
        )
        Object.assign(first, { discoveryRepos: async () => [h.repo] })
        Object.assign(second, { discoveryRepos: async () => [alias] })
        let entered!: () => void
        let release!: () => void
        const reached = new Promise<void>((resolve) => {
            entered = resolve
        })
        const barrier = new Promise<void>((resolve) => {
            release = resolve
        })
        t.after(() => release())
        const scan = h.discovery.scanRevision.bind(h.discovery)
        t.mock.method(
            h.discovery,
            'scanRevision',
            async (...args: Parameters<typeof scan>) => {
                entered()
                await barrier
                return scan(...args)
            }
        )
        const pending = first.refreshDiscover({ userId })
        try {
            await reached
            await assert.rejects(
                second.install({
                    userId,
                    agentId,
                    skillId: `github:${alias.owner}/${alias.name}@main:skills/one`
                }),
                (error: unknown) =>
                    error instanceof SkillScanBusyError &&
                    error.getStatus() === 503
            )
        } finally {
            release()
        }
        await pending
        const filesBefore = h.requests.filter(
            (request) => request.host === 'raw.githubusercontent.com'
        ).length
        const installed = await second.install({
            userId,
            agentId,
            skillId: `github:${alias.owner}/${alias.name}@main:skills/one`
        })
        assert.equal(installed.installedRevision, REVISION_A)
        assert.equal(
            h.requests.filter(
                (request) => request.host === 'raw.githubusercontent.com'
            ).length,
            filesBefore
        )
        assert.ok((await h.rows()).some((row) => row.repoOwner === alias.owner))
    }
)

const harness = async (t: TestContext) => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')
    const db = createDb(url)
    const db2 = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const repo: DiscoveryRepo = {
        id: `fixture-${suffix}`,
        owner: `fixture-${suffix}`,
        name: 'skills',
        branch: 'main',
        enabled: true,
        readonly: true,
        createdAt: null,
        updatedAt: null
    }
    const github = await githubFixture(t)
    const discovery = new SkillDiscoveryService(
        { get: () => 'fixture-credential' } as never,
        {} as never
    )
    const cleanups: Array<() => Promise<unknown>> = []
    t.after(async () => {
        for (const cleanup of cleanups) await cleanup()
        await db
            .delete(skills)
            .where(
                sql`lower(${skills.repoOwner}) = ${repo.owner.toLowerCase()}`
            )
        await db
            .delete(skillRepoScans)
            .where(eq(skillRepoScans.key, canonicalSkillRepoKey(repo)))
        await db.$client.end()
        await db2.$client.end()
    })
    return {
        db,
        db2,
        repo,
        discovery,
        cleanups,
        ...github,
        stateRow: async () =>
            (
                await db
                    .select()
                    .from(skillRepoScans)
                    .where(eq(skillRepoScans.key, canonicalSkillRepoKey(repo)))
            )[0],
        rows: () =>
            db
                .select()
                .from(skills)
                .where(
                    sql`lower(${skills.repoOwner}) = ${repo.owner.toLowerCase()}`
                )
    }
}

test(
    'unchanged revision uses one request and keeps curation while a changed snapshot marks missing atomically',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        h.state.paths = ['skills/one/SKILL.md', 'skills/two/SKILL.md']
        const first = await refreshSkillRepo(h.db, h.discovery, h.repo)
        await h.db
            .update(skills)
            .set({ tags: ['curated'], featured: true, hidden: true })
            .where(eq(skills.id, first[0].id))
        const before = h.requests.length
        await refreshSkillRepo(h.db2, h.discovery, h.repo)
        assert.equal(h.requests.length - before, 1)
        assert.ok(h.requests.at(-1)?.path.includes('/commits/'))
        h.state.revision = REVISION_B
        h.state.paths = ['skills/one/SKILL.md']
        await refreshSkillRepo(h.db, h.discovery, h.repo)
        const rows = await h.rows()
        const kept = rows.find((row) => row.id === first[0].id)!
        assert.deepEqual(kept.tags, ['curated'])
        assert.equal(kept.featured, true)
        assert.equal(kept.hidden, true)
        assert.equal(kept.latestRevision, REVISION_B)
        assert.ok(
            rows.find((row) => row.sourcePath === 'skills/two')?.missingSince
        )
        assert.equal((await h.stateRow()).revision, REVISION_B)
    }
)

test(
    'two API instances share one canonical scan and a case alias publishes the saved snapshot without a rescan',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        h.state.delayMs = 20
        const alias = {
            ...h.repo,
            owner: h.repo.owner.toUpperCase(),
            name: 'Skills'
        }
        const other = new SkillDiscoveryService({} as never, {} as never)
        const results = await Promise.allSettled([
            refreshSkillRepo(h.db, h.discovery, h.repo),
            refreshSkillRepo(h.db2, other, alias)
        ])
        assert.equal(
            results.filter((result) => result.status === 'fulfilled').length,
            1
        )
        assert.ok(
            results.some(
                (result) =>
                    result.status === 'rejected' &&
                    result.reason instanceof SkillScanBusyError
            )
        )
        assert.equal(
            h.requests.filter(
                (request) => request.host === 'raw.githubusercontent.com'
            ).length,
            1
        )
        const before = h.requests.length
        const stale = await staleSkillRepos(h.db, [h.repo, alias])
        assert.equal(stale.length, 1)
        await refreshSkillRepo(h.db2, other, stale[0])
        assert.equal(h.requests.length - before, 1)
        assert.equal((await h.rows()).length, 2)
        assert.deepEqual(await staleSkillRepos(h.db, [h.repo, alias]), [])
        assert.equal((await h.stateRow()).publishedAliases.length, 2)
    }
)

test(
    'a complete empty repository marks every previous skill missing and stays fresh for aliases',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        await refreshSkillRepo(h.db, h.discovery, h.repo)
        h.state.revision = REVISION_B
        h.state.paths = []
        await refreshSkillRepo(h.db, h.discovery, h.repo)
        assert.ok((await h.rows())[0].missingSince)
        assert.deepEqual((await h.stateRow()).snapshot, [])
        assert.deepEqual(await staleSkillRepos(h.db, [h.repo]), [])
        const alias = { ...h.repo, name: 'Skills' }
        const before = h.requests.length
        await refreshSkillRepo(h.db2, h.discovery, alias)
        assert.equal(h.requests.length - before, 1)
        assert.deepEqual(await staleSkillRepos(h.db, [alias]), [])
    }
)

for (const failure of ['truncated', 'malformed', 'file'] as const) {
    test(
        `${failure} responses leave the previous revision, freshness and rows intact`,
        { skip: !RUN },
        async (t) => {
            const h = await harness(t)
            await refreshSkillRepo(h.db, h.discovery, h.repo)
            const previous = await h.stateRow()
            h.state.revision = REVISION_B
            if (failure === 'file') h.state.failPath = '/SKILL.md'
            else h.state[failure] = true
            await assert.rejects(
                refreshSkillRepo(h.db, h.discovery, h.repo),
                /GitHub source unavailable/
            )
            const after = await h.stateRow()
            assert.equal(after.revision, REVISION_A)
            assert.deepEqual(after.scannedAt, previous.scannedAt)
            assert.equal((await h.rows())[0].missingSince, null)
            assert.equal(after.holderId, null)
        }
    )
}

test(
    'an expired owner cannot overwrite the newer revision or freshness',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        let enter!: () => void
        let release!: () => void
        const entered = new Promise<void>((resolve) => {
            enter = resolve
        })
        const barrier = new Promise<void>((resolve) => {
            release = resolve
        })
        t.after(() => release())
        const scan = h.discovery.scanRevision.bind(h.discovery)
        t.mock.method(
            h.discovery,
            'scanRevision',
            async (...args: Parameters<typeof scan>) => {
                const snapshot = await scan(...args)
                enter()
                await barrier
                return snapshot
            }
        )
        const old = refreshSkillRepo(h.db, h.discovery, h.repo)
        await entered
        await h.db
            .update(skillRepoScans)
            .set({ expiresAt: new Date(0) })
            .where(eq(skillRepoScans.key, canonicalSkillRepoKey(h.repo)))
        h.state.revision = REVISION_B
        const newer = new SkillDiscoveryService({} as never, {} as never)
        await refreshSkillRepo(h.db2, newer, h.repo)
        const committed = await h.stateRow()
        release()
        await assert.rejects(old, SkillScanBusyError)
        assert.deepEqual(await h.stateRow(), committed)
        assert.equal((await h.rows())[0].latestRevision, REVISION_B)
    }
)

test(
    'a database failure after the first batch rolls back every row and does not advance freshness',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        await refreshSkillRepo(h.db, h.discovery, h.repo)
        const prior = await h.stateRow()
        const functionName = `skill_scan_fail_${randomBytes(5).toString('hex')}`
        await h.db.$client.unsafe(
            `create function ${functionName}() returns trigger language plpgsql as $$ begin if NEW.repo_owner = '${h.repo.owner}' and NEW.source_path = 'skills/260' then raise exception 'fixture failure'; end if; return NEW; end $$`
        )
        await h.db.$client.unsafe(
            `create trigger ${functionName} before insert on skills for each row execute function ${functionName}()`
        )
        h.cleanups.push(async () => {
            await h.db.$client.unsafe(
                `drop trigger if exists ${functionName} on skills`
            )
            await h.db.$client.unsafe(
                `drop function if exists ${functionName}()`
            )
        })
        h.state.revision = REVISION_B
        h.state.paths = Array.from(
            { length: 300 },
            (_, index) => `skills/${index}/SKILL.md`
        )
        await assert.rejects(
            refreshSkillRepo(h.db, h.discovery, h.repo),
            /GitHub source unavailable/
        )
        assert.equal((await h.rows()).length, 1)
        const after = await h.stateRow()
        assert.equal(after.revision, prior.revision)
        assert.deepEqual(after.scannedAt, prior.scannedAt)
    }
)

test(
    'a synchronous public import failure writes neither library skill nor supporting file rows',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        const userId = `skill-fixture-${randomBytes(6).toString('hex')}`
        await h.db
            .insert(users)
            .values({ id: userId, email: `${userId}@example.invalid` })
        h.cleanups.push(async () =>
            h.db.delete(users).where(eq(users.id, userId))
        )
        h.state.paths = ['SKILL.md', 'support.txt']
        h.state.failPath = 'support.txt'
        const service = new LibrarySkillsService(
            h.db,
            h.discovery,
            {} as never,
            {} as never
        )
        await assert.rejects(
            service.importFromSource(userId, {
                url: `https://github.com/${h.repo.owner}/${h.repo.name}`
            }),
            /GitHub source unavailable/
        )
        assert.equal(
            (
                await h.db
                    .select()
                    .from(librarySkills)
                    .where(eq(librarySkills.userId, userId))
            ).length,
            0
        )
        const orphaned = await h.db
            .select()
            .from(librarySkillFiles)
            .where(
                sql`${librarySkillFiles.librarySkillId} in (select id from library_skills where user_id = ${userId})`
            )
        assert.equal(orphaned.length, 0)
    }
)

test(
    'library file insertion failure rolls back the imported skill, and success stores the immutable revision',
    { skip: !RUN },
    async (t) => {
        const h = await harness(t)
        const userId = createObjectId('user')
        await h.db
            .insert(users)
            .values({ id: userId, email: `${userId}@example.invalid` })
        h.cleanups.push(async () =>
            h.db.delete(users).where(eq(users.id, userId))
        )
        h.state.paths = ['SKILL.md', 'support.txt']
        const functionName = `skill_import_fail_${randomBytes(5).toString('hex')}`
        await h.db.$client.unsafe(
            `create function ${functionName}() returns trigger language plpgsql as $$ begin if exists(select 1 from library_skills where id = NEW.library_skill_id and user_id = '${userId}') then raise exception 'fixture file insert failure'; end if; return NEW; end $$`
        )
        await h.db.$client.unsafe(
            `create trigger ${functionName} before insert on library_skill_files for each row execute function ${functionName}()`
        )
        h.cleanups.unshift(async () => {
            await h.db.$client.unsafe(
                `drop trigger if exists ${functionName} on library_skill_files`
            )
            await h.db.$client.unsafe(
                `drop function if exists ${functionName}()`
            )
        })
        const service = new LibrarySkillsService(
            h.db,
            h.discovery,
            {} as never,
            {} as never
        )
        const input = {
            url: `https://github.com/${h.repo.owner}/${h.repo.name}`
        }
        await assert.rejects(
            service.importFromSource(userId, input),
            /Skill import could not be persisted/
        )
        assert.deepEqual(
            await h.db
                .select()
                .from(librarySkills)
                .where(eq(librarySkills.userId, userId)),
            []
        )
        await h.db.$client.unsafe(
            `drop trigger ${functionName} on library_skill_files`
        )
        const imported = await service.importFromSource(userId, input)
        assert.equal(imported.status, 'created')
        assert.equal(imported.skill.origin?.revision, REVISION_A)
        assert.equal(imported.skill.files.length, 1)
    }
)
