import {
    AdminSkillCatalogItem,
    AdminSkillsCatalogPage,
    AgentSkillsGroup,
    CatalogSort,
    CreateSkillRepoBody,
    DiscoverableSkillSummary,
    DiscoverableSkillsPage,
    InstallSkillBatchResult,
    InstalledSkillSummary,
    SkillFramework,
    SkillReadmeDocument,
    SkillReadmeMeta,
    SkillReadmeResponse,
    SkillReadmeSource,
    SkillRepoSummary,
    SkillTargetAgentSummary,
    UpdateSkillCurationBody,
    UpdateSkillRepoBody,
    createObjectId,
    isObjectId
} from '@manyfold/shared'
import { createHash } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import {
    and,
    asc,
    desc,
    eq,
    ilike,
    inArray,
    isNull,
    notInArray,
    or,
    sql,
    type SQL
} from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    catalogCategories,
    librarySkills,
    skillRepos,
    skills,
    userSkills,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type LibrarySkillRow,
    type SkillRepoRow,
    type SkillRow,
    type UserSkillRow
} from '@manyfold/db'
import {
    clampPageLimit,
    likeNeedle,
    normalizeCatalogTags,
    parseOffsetCursor
} from '@/common/catalog-query'
import { DRIZZLE } from '@/db/tokens'
import {
    DiscoveryRepo,
    parseSkillMarkdown,
    readmeContent,
    repoToSummary,
    ScannedSkillSummary,
    SkillDiscoveryService
} from './skill-discovery.service'
import { SkillMaterializerService } from './skill-materializer.service'
import type {
    RuntimeSkillInventoryItem,
    SkillOutcome
} from './skill-materializer.service'
import {
    assertSkillFramework,
    assertSafeGitHubOwner,
    assertSafeGitHubRepo,
    assertSafeGitRef,
    assertSafeInstallDir,
    deterministicSuffix,
    installDirBase,
    installDirWithSuffix,
    parseSkillId,
    SKILL_FRAMEWORKS
} from './skill-utils'

interface SkillTarget {
    agent: Agent
    runtime: AgentRuntimeRow
    framework: SkillFramework
}

interface InstalledOptions {
    includeRuntime?: boolean
}

interface RuntimeInventoryCacheEntry {
    items: RuntimeSkillInventoryItem[]
    expiresAt: number
}

type InstalledSkillState = {
    userSkillId: string
    enabled: boolean
    installDir: string
}

type SkillJoinedRow = {
    skill: SkillRow
    categoryName: string | null
}

interface ReadmeCacheEntry {
    revision: string | null
    documents: SkillReadmeDocument[]
    meta: SkillReadmeMeta
    expiresAt: number
}

const DISCOVER_DEFAULT_LIMIT = 24
const DISCOVER_MAX_LIMIT = 100
const ADMIN_CATALOG_DEFAULT_LIMIT = 50
const ADMIN_CATALOG_MAX_LIMIT = 200

@Injectable()
export class SkillsService {
    private readonly log = new Logger(SkillsService.name)
    private readonly runtimeInventoryCache = new Map<
        string,
        RuntimeInventoryCacheEntry
    >()
    private readonly runtimeInventoryInFlight = new Map<
        string,
        Promise<RuntimeSkillInventoryItem[]>
    >()
    private readonly runtimeInventoryCacheTtlMs = 15_000
    private readonly runtimeInventoryTimeoutMs = 3_000
    private readonly discoveryRefreshInFlight = new Map<
        string,
        Promise<ScannedSkillSummary[]>
    >()
    private readonly discoveryCacheTtlMs = 6 * 60 * 60 * 1000
    private readonly readmeCache = new Map<string, ReadmeCacheEntry>()
    private readonly readmeCacheMax = 500
    // Cap how long install/update block on materialization before returning the
    // durable state. Small/library skills finish well under this and return
    // `installed`; a large repo returns `installing` and the workspace copy
    // keeps reconciling in the background (the row's terminal status is written
    // by the materializer regardless of who is awaiting).
    private readonly installMaterializeCapMs = 15_000

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly discovery: SkillDiscoveryService,
        private readonly materializer: SkillMaterializerService
    ) {}

    // Kick materialization and wait at most installMaterializeCapMs for it,
    // returning its per-skill outcomes if it finished in time (else null — the
    // workspace copy is still reconciling). The materializer persists each row's
    // terminal status itself and never rejects (materializeAgentRow swallows),
    // so the background arm is safe to leave running when the cap wins.
    private async materializeWithCap(
        agentId: string
    ): Promise<SkillOutcome[] | null> {
        let outcomes: SkillOutcome[] | null = null
        const done = this.materializer
            .materializeAgent(agentId)
            .then((result) => {
                outcomes = result
            })
            .catch((err) =>
                this.log.warn(
                    `materialize agent=${agentId} failed: ${(err as Error).message}`
                )
            )
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                done,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, this.installMaterializeCapMs)
                })
            ])
        } finally {
            if (timer) clearTimeout(timer)
        }
        return outcomes
    }

    // Reflect this reconcile's result onto the returned row without a second
    // query: use the matching per-skill outcome when we have it, otherwise keep
    // the row's persisted status (the cap elapsed, or the row was just disabled
    // and dropped out of the desired set). Never leaves the status field unset.
    private applyOutcome(
        row: UserSkillRow,
        outcomes: SkillOutcome[] | null
    ): UserSkillRow {
        const mine = outcomes?.find((o) => o.userSkillId === row.id)
        if (mine)
            return {
                ...row,
                materializeStatus: mine.status,
                materializeError:
                    mine.status === 'failed'
                        ? (mine.error ?? 'materialization failed')
                        : null
            }
        return {
            ...row,
            materializeStatus: row.materializeStatus ?? 'installing',
            materializeError: row.materializeError ?? null
        }
    }

    async installed(
        userId: string,
        agentId?: string,
        options: InstalledOptions = {}
    ): Promise<AgentSkillsGroup[]> {
        const targets = agentId
            ? [await this.resolveTarget(userId, agentId)]
            : await this.listTargets(userId)
        if (targets.length === 0) return []

        const groups = new Map(
            targets.map((target) => [
                target.agent.id,
                {
                    agent: targetSummary(target),
                    skills: [] as InstalledSkillSummary[],
                    inventoryError: undefined as string | undefined
                }
            ])
        )
        const targetByAgentId = new Map(
            targets.map((target) => [target.agent.id, target])
        )
        const agentIds = targets.map((target) => target.agent.id)
        const scope = and(
            eq(userSkills.userId, userId),
            inArray(userSkills.agentId, agentIds)
        )
        const [rows, libraryRows] = await Promise.all([
            this.db
                .select({ userSkill: userSkills, skill: skills })
                .from(userSkills)
                .innerJoin(skills, eq(userSkills.skillId, skills.id))
                .where(scope),
            this.db
                .select({ userSkill: userSkills, library: librarySkills })
                .from(userSkills)
                .innerJoin(
                    librarySkills,
                    eq(userSkills.librarySkillId, librarySkills.id)
                )
                .where(scope)
        ])
        const merged = [
            ...rows.map(({ userSkill, skill }) => ({
                userSkill,
                summary: (target: SkillTarget) =>
                    installedSummary(userSkill, skill, target)
            })),
            ...libraryRows.map(({ userSkill, library }) => ({
                userSkill,
                summary: (target: SkillTarget) =>
                    librarySummary(userSkill, library, target)
            }))
        ].sort(
            (a, b) =>
                b.userSkill.updatedAt.getTime() -
                a.userSkill.updatedAt.getTime()
        )

        for (const { userSkill, summary } of merged) {
            if (!userSkill.agentId) continue
            const target = targetByAgentId.get(userSkill.agentId)
            if (!target) continue
            const group = groups.get(target.agent.id)
            if (!group) continue
            group.skills.push(summary(target))
        }

        if (options.includeRuntime)
            await this.mergeRuntimeInventory(targets, groups)

        return targets.map((target) => groups.get(target.agent.id)!)
    }

    async repos(userId: string): Promise<SkillRepoSummary[]> {
        const [builtin, custom] = await Promise.all([
            this.discovery.builtinRepos(),
            this.customRepos(userId, true)
        ])
        return [
            ...builtin.filter((repo) => repo.enabled).map(repoToSummary),
            ...custom.map(repoToSummary)
        ]
    }

    async discover(input: {
        userId: string
        agentId?: string
        q?: string
        repoId?: string
    }): Promise<DiscoverableSkillSummary[]> {
        const target = input.agentId
            ? await this.resolveTarget(input.userId, input.agentId)
            : null
        const repos = this.selectDiscoveryRepos(
            await this.discoveryRepos(input.userId),
            input.repoId
        )
        if (repos.length === 0) return []
        const installed = target
            ? await this.installedMap(target.agent.id)
            : new Map<string, InstalledSkillState>()
        void this.refreshStaleDiscoverRepos(repos).catch((err: unknown) => {
            this.log.warn(
                `background skill discovery refresh failed: ${(err as Error).message}`
            )
        })
        const rows = await this.discoverRows({ repos, q: input.q })
        const counts = await this.installCounts(
            rows.map((row) => row.skill.id)
        )
        return this.mapDiscoverRows(rows, repos, installed, counts)
    }

    async discoverPage(input: {
        userId: string
        agentId?: string
        q?: string
        repoId?: string
        categoryId?: string
        tag?: string
        sort?: CatalogSort
        cursor?: string
        limit?: number
    }): Promise<DiscoverableSkillsPage> {
        const target = input.agentId
            ? await this.resolveTarget(input.userId, input.agentId)
            : null
        const repos = this.selectDiscoveryRepos(
            await this.discoveryRepos(input.userId),
            input.repoId
        )
        if (repos.length === 0) return { items: [], nextCursor: null }
        const installed = target
            ? await this.installedMap(target.agent.id)
            : new Map<string, InstalledSkillState>()
        void this.refreshStaleDiscoverRepos(repos).catch((err: unknown) => {
            this.log.warn(
                `background skill discovery refresh failed: ${(err as Error).message}`
            )
        })
        const limit = clampPageLimit(
            input.limit,
            DISCOVER_DEFAULT_LIMIT,
            DISCOVER_MAX_LIMIT
        )
        const offset = parseOffsetCursor(input.cursor)
        const rows = await this.discoverRows({
            repos,
            q: input.q,
            categoryId: input.categoryId,
            tag: input.tag,
            sort: input.sort ?? 'featured',
            page: { limit, offset }
        })
        const hasMore = rows.length > limit
        const sliced = hasMore ? rows.slice(0, limit) : rows
        const counts = await this.installCounts(
            sliced.map((row) => row.skill.id)
        )
        return {
            items: this.mapDiscoverRows(sliced, repos, installed, counts),
            nextCursor: hasMore ? String(offset + limit) : null
        }
    }

    async refreshDiscover(input: {
        userId: string
        agentId?: string
        q?: string
        repoId?: string
    }): Promise<DiscoverableSkillSummary[]> {
        const target = input.agentId
            ? await this.resolveTarget(input.userId, input.agentId)
            : null
        const repos = this.selectDiscoveryRepos(
            await this.discoveryRepos(input.userId),
            input.repoId
        )
        try {
            await this.refreshDiscoverRepos(repos)
        } catch (err) {
            return throwBadRequestForUnsafeInput(err)
        }
        if (repos.length === 0) return []
        const installed = target
            ? await this.installedMap(target.agent.id)
            : new Map<string, InstalledSkillState>()
        const rows = await this.discoverRows({ repos, q: input.q })
        const counts = await this.installCounts(
            rows.map((row) => row.skill.id)
        )
        return this.mapDiscoverRows(rows, repos, installed, counts)
    }

    async detail(input: {
        userId: string
        skillId: string
        agentId?: string
    }): Promise<DiscoverableSkillSummary> {
        const target = input.agentId
            ? await this.resolveTarget(input.userId, input.agentId)
            : null
        const repos = await this.discoveryRepos(input.userId)
        const [row, installed, counts] = await Promise.all([
            this.visibleSkillRow(input.skillId, repos),
            target
                ? this.installedMap(target.agent.id)
                : Promise.resolve(new Map<string, InstalledSkillState>()),
            this.installCounts([input.skillId])
        ])
        const [summary] = this.mapDiscoverRows([row], repos, installed, counts)
        if (!summary) throw new NotFoundException(`skill ${input.skillId}`)
        return summary
    }

    private async installCounts(
        skillIds: string[]
    ): Promise<Map<string, number>> {
        if (skillIds.length === 0) return new Map()
        const rows = await this.db
            .select({
                skillId: userSkills.skillId,
                total: sql<number>`count(*)::int`
            })
            .from(userSkills)
            .where(inArray(userSkills.skillId, skillIds))
            .groupBy(userSkills.skillId)
        return new Map(
            rows
                .filter((row) => row.skillId !== null)
                .map((row) => [row.skillId as string, row.total])
        )
    }

    async readme(userId: string, skillId: string): Promise<SkillReadmeResponse> {
        const repos = await this.discoveryRepos(userId)
        const { skill: row } = await this.visibleSkillRow(skillId, repos)
        const now = Date.now()
        const cached = this.readmeCache.get(skillId)
        if (
            cached &&
            cached.revision === row.latestRevision &&
            cached.expiresAt > now
        )
            return this.readmeResponse(skillId, cached)
        const prefix = row.sourcePath === '.' ? '' : `${row.sourcePath}/`
        // SKILL.md is the canonical, always-present skill definition and is
        // specific to this skill; README.md is optional and, in a monorepo, a
        // repo-root README describes the whole collection, not this skill. Fetch
        // both so the reader can switch between them, keeping SKILL.md first.
        const candidates: { source: SkillReadmeSource; path: string }[] = [
            { source: 'skill', path: `${prefix}SKILL.md` },
            { source: 'readme', path: `${prefix}README.md` }
        ]
        const documents: SkillReadmeDocument[] = []
        // body/meta are parsed once per fetched revision — cache hits reuse them
        // instead of re-running YAML + regex over the full document.
        let meta: SkillReadmeMeta | null = null
        for (const { source, path } of candidates) {
            const content = await this.discovery.fetchRepoFile(
                {
                    owner: row.repoOwner,
                    name: row.repoName,
                    branch: row.repoBranch
                },
                path
            )
            if (content === null) continue
            const parsed = readmeContent(content)
            documents.push({ source, path, content, body: parsed.body })
            // Structured frontmatter lives in SKILL.md; prefer it, but fall back
            // to the first present document so a README-only skill still has meta.
            if (source === 'skill' || meta === null) meta = parsed.meta
        }
        if (documents.length === 0 || meta === null)
            throw new NotFoundException(`no readme for skill ${skillId}`)
        if (
            !this.readmeCache.has(skillId) &&
            this.readmeCache.size >= this.readmeCacheMax
        ) {
            const oldest = this.readmeCache.keys().next().value
            if (oldest !== undefined) this.readmeCache.delete(oldest)
        }
        const entry: ReadmeCacheEntry = {
            revision: row.latestRevision,
            documents,
            meta,
            expiresAt: now + this.discoveryCacheTtlMs
        }
        this.readmeCache.set(skillId, entry)
        return this.readmeResponse(skillId, entry)
    }

    private readmeResponse(
        skillId: string,
        entry: ReadmeCacheEntry
    ): SkillReadmeResponse {
        const primary = entry.documents[0]
        return {
            skillId,
            revision: entry.revision,
            path: primary.path,
            content: primary.content,
            body: primary.body,
            meta: entry.meta,
            documents: entry.documents
        }
    }

    async adminListCatalog(input: {
        q?: string
        cursor?: string
        limit?: number
    }): Promise<AdminSkillsCatalogPage> {
        const limit = clampPageLimit(
            input.limit,
            ADMIN_CATALOG_DEFAULT_LIMIT,
            ADMIN_CATALOG_MAX_LIMIT
        )
        const offset = parseOffsetCursor(input.cursor)
        const rows = await this.db
            .select({ skill: skills, categoryName: catalogCategories.name })
            .from(skills)
            .leftJoin(
                catalogCategories,
                eq(skills.categoryId, catalogCategories.id)
            )
            .where(input.q ? skillSearchCond(input.q) : undefined)
            .orderBy(asc(skills.name), asc(skills.id))
            .limit(limit + 1)
            .offset(offset)
        const hasMore = rows.length > limit
        const sliced = hasMore ? rows.slice(0, limit) : rows
        return {
            items: sliced.map(adminCatalogItem),
            nextCursor: hasMore ? String(offset + limit) : null
        }
    }

    async adminUpdateCuration(
        skillId: string,
        body: UpdateSkillCurationBody
    ): Promise<AdminSkillCatalogItem> {
        if (body.categoryId) {
            const [category] = await this.db
                .select()
                .from(catalogCategories)
                .where(eq(catalogCategories.id, body.categoryId))
                .limit(1)
            if (!category || category.domain !== 'skill')
                throw new BadRequestException(
                    `unknown skill category: ${body.categoryId}`
                )
        }
        const set: Partial<SkillRow> = {}
        if (body.categoryId !== undefined) set.categoryId = body.categoryId
        if (body.tags !== undefined) set.tags = normalizeCatalogTags(body.tags)
        if (body.featured !== undefined) set.featured = body.featured
        if (body.hidden !== undefined) set.hidden = body.hidden
        if (Object.keys(set).length > 0) {
            // updatedAt deliberately untouched: it records the last discovery
            // sync and drives the repo staleness check, not curation edits.
            const updated = await this.db
                .update(skills)
                .set(set)
                .where(eq(skills.id, skillId))
                .returning({ id: skills.id })
            if (updated.length === 0)
                throw new NotFoundException(`skill ${skillId}`)
        }
        const [row] = await this.db
            .select({ skill: skills, categoryName: catalogCategories.name })
            .from(skills)
            .leftJoin(
                catalogCategories,
                eq(skills.categoryId, catalogCategories.id)
            )
            .where(eq(skills.id, skillId))
            .limit(1)
        if (!row) throw new NotFoundException(`skill ${skillId}`)
        return adminCatalogItem(row)
    }

    async install(input: {
        userId: string
        skillId: string
        agentId: string
    }): Promise<InstalledSkillSummary> {
        const target = await this.resolveTarget(input.userId, input.agentId)
        if (isObjectId(input.skillId, 'librarySkill'))
            return this.installLibrarySkill(input, target)
        const framework = target.framework
        const repos = await this.discoveryRepos(input.userId)
        let discovered: ScannedSkillSummary | null = null
        try {
            discovered = await this.discovery.discoverOne(repos, input.skillId)
        } catch (err) {
            throwBadRequestForUnsafeInput(err)
        }
        if (!discovered)
            throw new NotFoundException(`discoverable skill ${input.skillId}`)

        // Same upsert as discovery refresh — discoverOne just live-verified the
        // skill, so this also clears a stale missingSince flag and keeps the
        // description-coalesce guard in one place.
        const [skill] = await this.upsertDiscoveredSkills([discovered])

        const existing = await this.findUserSkillBySkill(
            input.userId,
            target.agent.id,
            input.skillId
        )
        if (existing) {
            const [row] = await this.db
                .update(userSkills)
                .set({
                    enabled: true,
                    materializeStatus: 'installing',
                    materializeError: null,
                    installedRevision: discovered.latestRevision,
                    installedVersion: discovered.version,
                    updatedAt: new Date()
                })
                .where(eq(userSkills.id, existing.id))
                .returning()
            const outcomes = await this.materializeWithCap(target.agent.id)
            return installedSummary(
                this.applyOutcome(row, outcomes),
                skill,
                target
            )
        }

        const installDir = await this.nextInstallDir(input.userId, {
            agentId: target.agent.id,
            base: discovered.installDir,
            seed: input.skillId
        })
        const [row] = await this.db
            .insert(userSkills)
            .values({
                id: createObjectId('userSkill'),
                userId: input.userId,
                skillId: input.skillId,
                agentId: target.agent.id,
                runtimeId: target.runtime.id,
                framework,
                enabled: true,
                installDir,
                installedRevision: discovered.latestRevision,
                installedVersion: discovered.version
            })
            .returning()
        const outcomes = await this.materializeWithCap(target.agent.id)
        return installedSummary(
            this.applyOutcome(row, outcomes),
            skill,
            target
        )
    }

    // Sequential on purpose: installs share per-agent and per-host advisory
    // locks in the materializer, and a per-agent failure must not abort the
    // rest of the batch.
    async installBatch(input: {
        userId: string
        skillId: string
        agentIds: string[]
    }): Promise<InstallSkillBatchResult> {
        const results: InstallSkillBatchResult['results'] = []
        const seen = new Set<string>()
        for (const agentId of input.agentIds) {
            if (seen.has(agentId)) continue
            seen.add(agentId)
            try {
                const skill = await this.install({
                    userId: input.userId,
                    skillId: input.skillId,
                    agentId
                })
                results.push(
                    skill.materializeStatus === 'failed'
                        ? {
                              agentId,
                              status: 'failed',
                              error:
                                  skill.materializeError ??
                                  'materialization failed',
                              skill
                          }
                        : { agentId, status: 'installed', skill }
                )
            } catch (err) {
                results.push({
                    agentId,
                    status: 'failed',
                    error: (err as Error).message
                })
            }
        }
        return { results }
    }

    private async installLibrarySkill(
        input: { userId: string; skillId: string; agentId: string },
        target: SkillTarget
    ): Promise<InstalledSkillSummary> {
        const library = await this.getLibrarySkill(input.userId, input.skillId)
        const version = parseSkillMarkdown(library.content).version
        const existing = await this.findUserSkillByLibrarySkill(
            input.userId,
            target.agent.id,
            library.id
        )
        if (existing) {
            const [row] = await this.db
                .update(userSkills)
                .set({
                    enabled: true,
                    materializeStatus: 'installing',
                    materializeError: null,
                    installedRevision: library.contentHash,
                    installedVersion: version,
                    updatedAt: new Date()
                })
                .where(eq(userSkills.id, existing.id))
                .returning()
            const outcomes = await this.materializeWithCap(target.agent.id)
            return librarySummary(
                this.applyOutcome(row, outcomes),
                library,
                target
            )
        }
        const installDir = await this.nextInstallDir(input.userId, {
            agentId: target.agent.id,
            base: library.name,
            seed: library.id
        })
        const [row] = await this.db
            .insert(userSkills)
            .values({
                id: createObjectId('userSkill'),
                userId: input.userId,
                librarySkillId: library.id,
                agentId: target.agent.id,
                runtimeId: target.runtime.id,
                framework: target.framework,
                enabled: true,
                installDir,
                installedRevision: library.contentHash,
                installedVersion: version
            })
            .returning()
        const outcomes = await this.materializeWithCap(target.agent.id)
        return librarySummary(
            this.applyOutcome(row, outcomes),
            library,
            target
        )
    }

    private async getLibrarySkill(
        userId: string,
        id: string
    ): Promise<LibrarySkillRow> {
        const [row] = await this.db
            .select()
            .from(librarySkills)
            .where(
                and(eq(librarySkills.id, id), eq(librarySkills.userId, userId))
            )
            .limit(1)
        if (!row) throw new NotFoundException(`library skill ${id}`)
        return row
    }

    private async findUserSkillByLibrarySkill(
        userId: string,
        agentId: string,
        librarySkillId: string
    ): Promise<UserSkillRow | null> {
        const [row] = await this.db
            .select()
            .from(userSkills)
            .where(
                and(
                    eq(userSkills.userId, userId),
                    eq(userSkills.agentId, agentId),
                    eq(userSkills.librarySkillId, librarySkillId)
                )
            )
            .limit(1)
        return row ?? null
    }

    async update(input: {
        userId: string
        userSkillId: string
        enabled: boolean
    }): Promise<InstalledSkillSummary> {
        const existing = await this.getOwnedUserSkill(
            input.userId,
            input.userSkillId
        )
        if (!existing.agentId)
            throw new NotFoundException(`skill ${input.userSkillId}`)
        const target = await this.resolveTarget(input.userId, existing.agentId)
        const [row] = await this.db
            .update(userSkills)
            .set({
                enabled: input.enabled,
                updatedAt: new Date(),
                // Re-enabling triggers a (re)materialize, so reset to installing
                // for the pending reconcile. Disabling leaves the last status
                // untouched: the UI keys off `enabled` and the row drops out of
                // the desired set, so the materializer never revisits it.
                ...(input.enabled
                    ? {
                          materializeStatus: 'installing' as const,
                          materializeError: null
                      }
                    : {})
            })
            .where(eq(userSkills.id, input.userSkillId))
            .returning()
        const outcomes = await this.materializeWithCap(existing.agentId)
        const fresh = this.applyOutcome(row, outcomes)
        if (fresh.skillId === null) {
            const library = await this.getLibrarySkill(
                input.userId,
                fresh.librarySkillId as string
            )
            return librarySummary(fresh, library, target)
        }
        const [skill] = await this.db
            .select()
            .from(skills)
            .where(eq(skills.id, fresh.skillId))
            .limit(1)
        return installedSummary(fresh, skill, target)
    }

    async delete(userId: string, userSkillId: string): Promise<void> {
        const existing = await this.getOwnedUserSkill(userId, userSkillId)
        if (!existing.agentId)
            throw new NotFoundException(`skill ${userSkillId}`)
        await this.db.delete(userSkills).where(eq(userSkills.id, userSkillId))
        await this.materializer.materializeAgent(existing.agentId)
    }

    async createRepo(
        userId: string,
        body: CreateSkillRepoBody
    ): Promise<SkillRepoSummary> {
        try {
            const owner = assertSafeGitHubOwner(body.owner)
            const name = assertSafeGitHubRepo(body.name)
            const branch = assertSafeGitRef(body.branch ?? 'main')
            const [row] = await this.db
                .insert(skillRepos)
                .values({
                    id: createObjectId('skillRepo'),
                    userId,
                    owner,
                    name,
                    branch,
                    enabled: true
                })
                .returning()
            return repoToSummary(customRepoToDiscovery(row))
        } catch (err) {
            if ((err as Error).message.startsWith('invalid '))
                throw new BadRequestException((err as Error).message)
            if ((err as Error).message.includes('skill_repos_user_repo_unique'))
                throw new ConflictException(
                    `${body.owner}/${body.name} is already added`
                )
            throw err
        }
    }

    async updateRepo(
        userId: string,
        id: string,
        body: UpdateSkillRepoBody
    ): Promise<SkillRepoSummary> {
        const existing = await this.getOwnedRepo(userId, id)
        const patch: Partial<typeof skillRepos.$inferInsert> = {
            updatedAt: new Date()
        }
        try {
            if (body.branch !== undefined)
                patch.branch = assertSafeGitRef(body.branch)
        } catch (err) {
            throw new BadRequestException((err as Error).message)
        }
        if (body.enabled !== undefined) patch.enabled = body.enabled
        const [row] = await this.db
            .update(skillRepos)
            .set(patch)
            .where(eq(skillRepos.id, existing.id))
            .returning()
        return repoToSummary(customRepoToDiscovery(row))
    }

    async deleteRepo(userId: string, id: string): Promise<void> {
        await this.getOwnedRepo(userId, id)
        await this.db.delete(skillRepos).where(eq(skillRepos.id, id))
    }

    private async mergeRuntimeInventory(
        targets: SkillTarget[],
        groups: Map<
            string,
            {
                agent: SkillTargetAgentSummary
                skills: InstalledSkillSummary[]
                inventoryError: string | undefined
            }
        >
    ): Promise<void> {
        await Promise.all(
            targets.map(async (target) => {
                if (target.framework !== 'hermes') return
                const group = groups.get(target.agent.id)
                if (!group) return
                try {
                    const runtimeSkills =
                        await this.cachedHermesRuntimeSkills(target)
                    const managedDirs = new Set(
                        group.skills.map((skill) => skill.installDir)
                    )
                    for (const item of runtimeSkills) {
                        if (managedDirs.has(item.installDir)) continue
                        group.skills.push(runtimeSummary(item, target))
                        managedDirs.add(item.installDir)
                    }
                } catch (err) {
                    group.inventoryError = (err as Error).message
                    this.log.warn(
                        `hermes skills inventory failed agent=${target.agent.id} runtime=${target.runtime.id}: ${group.inventoryError}`
                    )
                }
            })
        )
    }

    private async cachedHermesRuntimeSkills(
        target: SkillTarget
    ): Promise<RuntimeSkillInventoryItem[]> {
        const key = `${target.runtime.id}:${target.agent.internalId}`
        const cached = this.runtimeInventoryCache.get(key)
        const now = Date.now()
        if (cached && cached.expiresAt > now) return cached.items

        const pending = this.runtimeInventoryInFlight.get(key)
        if (pending) return pending

        const promise = this.materializer
            .listHermesRuntimeSkills({
                agent: target.agent,
                runtime: target.runtime,
                timeoutMs: this.runtimeInventoryTimeoutMs
            })
            .then((items) => {
                this.runtimeInventoryCache.set(key, {
                    items,
                    expiresAt: Date.now() + this.runtimeInventoryCacheTtlMs
                })
                return items
            })
            .finally(() => {
                this.runtimeInventoryInFlight.delete(key)
            })
        this.runtimeInventoryInFlight.set(key, promise)
        return promise
    }

    private async discoveryRepos(userId: string): Promise<DiscoveryRepo[]> {
        const [builtin, custom] = await Promise.all([
            this.discovery.builtinRepos(),
            this.customRepos(userId, false)
        ])
        return [...builtin.filter((repo) => repo.enabled), ...custom]
    }

    private async customRepos(
        userId: string,
        includeDisabled: boolean
    ): Promise<DiscoveryRepo[]> {
        const rows = await this.db
            .select()
            .from(skillRepos)
            .where(eq(skillRepos.userId, userId))
            .orderBy(desc(skillRepos.updatedAt))
        return rows
            .filter((row) => includeDisabled || row.enabled)
            .map(customRepoToDiscovery)
    }

    private selectDiscoveryRepos(
        repos: DiscoveryRepo[],
        repoId?: string
    ): DiscoveryRepo[] {
        const selected = repos.filter(
            (repo) => repo.enabled && (!repoId || repo.id === repoId)
        )
        if (repoId && selected.length === 0)
            throw new BadRequestException(`unknown repoId: ${repoId}`)
        return selected
    }

    private async discoverRows(input: {
        repos: DiscoveryRepo[]
        q?: string
        categoryId?: string
        tag?: string
        sort?: CatalogSort
        page?: { limit: number; offset: number }
    }): Promise<SkillJoinedRow[]> {
        const conds: SQL[] = [
            or(...input.repos.map(repoCond)) as SQL,
            eq(skills.hidden, false),
            isNull(skills.missingSince)
        ]
        if (input.q) conds.push(skillSearchCond(input.q))
        if (input.categoryId)
            conds.push(eq(skills.categoryId, input.categoryId))
        if (input.tag)
            conds.push(
                sql`${skills.tags} @> ${JSON.stringify([input.tag])}::jsonb`
            )
        const order =
            input.sort === 'latest'
                ? [desc(skills.createdAt), asc(skills.name)]
                : input.sort === 'featured'
                  ? [desc(skills.featured), asc(skills.name)]
                  : [asc(skills.name)]
        const query = this.db
            .select({ skill: skills, categoryName: catalogCategories.name })
            .from(skills)
            .leftJoin(
                catalogCategories,
                eq(skills.categoryId, catalogCategories.id)
            )
            .where(and(...conds))
            .orderBy(...order)
        return input.page
            ? await query.limit(input.page.limit + 1).offset(input.page.offset)
            : await query
    }

    private mapDiscoverRows(
        rows: SkillJoinedRow[],
        repos: DiscoveryRepo[],
        installed: Map<string, InstalledSkillState>,
        counts: Map<string, number> = new Map()
    ): DiscoverableSkillSummary[] {
        const repoByKey = new Map(
            repos.map((repo) => [discoveryRepoKey(repo), repo])
        )
        const out: DiscoverableSkillSummary[] = []
        for (const { skill: row, categoryName } of rows) {
            try {
                parseSkillId(row.id)
            } catch {
                continue
            }
            const repo = repoByKey.get(skillRowRepoKey(row))
            if (!repo) continue
            const installedSkill = installed.get(row.id)
            out.push({
                skillId: row.id,
                name: row.name,
                description: row.description,
                repoOwner: row.repoOwner,
                repoName: row.repoName,
                repoBranch: row.repoBranch,
                sourcePath: row.sourcePath,
                latestRevision: row.latestRevision,
                version: null,
                readmeUrl: row.readmeUrl,
                installDir:
                    installedSkill?.installDir ?? installDirBase(row.name),
                installed: !!installedSkill,
                enabled: installedSkill?.enabled ?? false,
                userSkillId: installedSkill?.userSkillId ?? null,
                repoId: repo.id,
                repoReadonly: repo.readonly,
                category:
                    row.categoryId && categoryName !== null
                        ? { id: row.categoryId, name: categoryName }
                        : null,
                tags: row.tags,
                featured: row.featured,
                updatedAt: row.updatedAt.toISOString(),
                installCount: counts.get(row.id) ?? 0
            })
        }
        return out
    }

    private async visibleSkillRow(
        skillId: string,
        repos: DiscoveryRepo[]
    ): Promise<SkillJoinedRow> {
        const [row] = await this.db
            .select({ skill: skills, categoryName: catalogCategories.name })
            .from(skills)
            .leftJoin(
                catalogCategories,
                eq(skills.categoryId, catalogCategories.id)
            )
            .where(
                and(
                    eq(skills.id, skillId),
                    eq(skills.hidden, false),
                    isNull(skills.missingSince)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException(`skill ${skillId}`)
        const repoKeys = new Set(repos.map(discoveryRepoKey))
        if (!repoKeys.has(skillRowRepoKey(row.skill)))
            throw new NotFoundException(`skill ${skillId}`)
        return row
    }

    private async refreshStaleDiscoverRepos(
        repos: DiscoveryRepo[]
    ): Promise<void> {
        if (repos.length === 0) return
        const freshness = await this.repoFreshness(repos)
        const now = Date.now()
        const staleRepos = repos.filter((repo) => {
            const newest = freshness.get(discoveryRepoKey(repo))
            return (
                newest === undefined ||
                now - newest > this.discoveryCacheTtlMs
            )
        })
        if (staleRepos.length === 0) return
        await this.refreshDiscoverRepos(staleRepos)
    }

    private async repoFreshness(
        repos: DiscoveryRepo[]
    ): Promise<Map<string, number>> {
        const rows = await this.db
            .select({
                repoOwner: skills.repoOwner,
                repoName: skills.repoName,
                repoBranch: skills.repoBranch,
                newest: sql<Date | string>`max(${skills.scannedAt})`
            })
            .from(skills)
            .where(or(...repos.map(repoCond)))
            .groupBy(skills.repoOwner, skills.repoName, skills.repoBranch)
        return new Map(
            rows.map((row) => [
                `${row.repoOwner}/${row.repoName}@${row.repoBranch}`,
                new Date(row.newest).getTime()
            ])
        )
    }

    private async refreshDiscoverRepos(
        repos: DiscoveryRepo[]
    ): Promise<ScannedSkillSummary[]> {
        const nested = await Promise.all(
            repos.map((repo) => this.refreshDiscoverRepo(repo))
        )
        return nested.flat()
    }

    private refreshDiscoverRepo(
        repo: DiscoveryRepo
    ): Promise<ScannedSkillSummary[]> {
        const key = discoveryRepoKey(repo)
        const pending = this.discoveryRefreshInFlight.get(key)
        if (pending) return pending

        const promise = this.discovery
            .scanRepos({ repos: [repo] })
            .then(async ({ rows, truncatedRepoIds }) => {
                await this.upsertDiscoveredSkills(rows)
                if (truncatedRepoIds.length === 0) {
                    await this.markMissingSkills(
                        repo,
                        rows.map((row) => row.skillId)
                    )
                } else {
                    this.log.warn(
                        `skipping missing-skill marking for truncated scan of ${key}`
                    )
                }
                return rows
            })
            .finally(() => {
                this.discoveryRefreshInFlight.delete(key)
            })
        this.discoveryRefreshInFlight.set(key, promise)
        return promise
    }

    private async upsertDiscoveredSkills(
        rows: ScannedSkillSummary[]
    ): Promise<SkillRow[]> {
        const nowIso = new Date().toISOString()
        const upserted: SkillRow[] = []
        for (const row of rows) {
            const [saved] = await this.db
                .insert(skills)
                .values({
                    id: row.skillId,
                    name: row.name,
                    description: row.description,
                    repoOwner: row.repoOwner,
                    repoName: row.repoName,
                    repoBranch: row.repoBranch,
                    sourcePath: row.sourcePath,
                    latestRevision: row.latestRevision,
                    readmeUrl: row.readmeUrl,
                    missingSince: null
                })
                .onConflictDoUpdate({
                    target: skills.id,
                    set: {
                        // Curation columns (categoryId/tags/featured/hidden)
                        // are admin-owned and must never be listed in this
                        // set — re-discovery would otherwise wipe them.
                        //
                        // description falls back to the stored value when the
                        // fresh scan couldn't read it: a rate-limited or failed
                        // SKILL.md fetch yields description=null, and a plain
                        // assignment would clobber a previously-good description
                        // with null on every degraded re-scan.
                        name: row.name,
                        description: sql`coalesce(${row.description}, ${skills.description})`,
                        repoOwner: row.repoOwner,
                        repoName: row.repoName,
                        repoBranch: row.repoBranch,
                        sourcePath: row.sourcePath,
                        latestRevision: row.latestRevision,
                        readmeUrl: row.readmeUrl,
                        missingSince: null,
                        // Always record that a successful scan touched this
                        // row, so the 6h TTL is refreshed even when content
                        // hasn't changed.
                        scannedAt: sql`${nowIso}::timestamptz`,
                        // Bump updatedAt only when the upstream revision moved,
                        // so the user-facing "Updated {date}" reflects a real
                        // content change instead of the last catalog re-scan.
                        // Uses ISO string + cast to avoid ERR_INVALID_ARG_TYPE
                        // from postgres-js trying to Buffer.byteLength(Date).
                        updatedAt: sql`case when ${skills.latestRevision} is distinct from ${row.latestRevision} then ${nowIso}::timestamptz else ${skills.updatedAt} end`
                    }
                })
                .returning()
            if (saved) upserted.push(saved)
        }
        return upserted
    }

    // After a successful scan, flag repo rows the scan didn't return as
    // missing. The skill list comes from the git tree, so it is authoritative
    // even when individual SKILL.md fetches fail — but only for complete
    // scans: the caller skips this for truncated trees, and an empty list is
    // rejected here so a malformed tree response can't blank out a whole repo.
    private async markMissingSkills(
        repo: DiscoveryRepo,
        presentSkillIds: string[]
    ): Promise<void> {
        if (presentSkillIds.length === 0) return
        await this.db
            .update(skills)
            .set({ missingSince: new Date() })
            .where(
                and(
                    repoCond(repo),
                    isNull(skills.missingSince),
                    notInArray(skills.id, presentSkillIds)
                )
            )
    }

    private async listTargets(userId: string): Promise<SkillTarget[]> {
        const rows = await this.db
            .select({ agent: agents, runtime: agentRuntimes })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agents.runtimeId, agentRuntimes.id))
            .where(
                and(
                    eq(agents.userId, userId),
                    inArray(agents.framework, [...SKILL_FRAMEWORKS])
                )
            )
            .orderBy(desc(agents.updatedAt))
        return rows.map(({ agent, runtime }) =>
            this.normalizeTarget(agent, runtime)
        )
    }

    private async resolveTarget(
        userId: string,
        agentId: string
    ): Promise<SkillTarget> {
        const [row] = await this.db
            .select({ agent: agents, runtime: agentRuntimes })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agents.runtimeId, agentRuntimes.id))
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        if (!row) throw new NotFoundException(`agent ${agentId}`)
        return this.normalizeTarget(row.agent, row.runtime)
    }

    private normalizeTarget(
        agent: Agent,
        runtime: AgentRuntimeRow
    ): SkillTarget {
        const framework = this.assertFramework(
            agent.framework as SkillFramework
        )
        if (runtime.userId !== agent.userId)
            throw new NotFoundException(`runtime ${runtime.id}`)
        if (runtime.framework !== framework)
            throw new BadRequestException(
                `agent ${agent.id} framework does not match runtime ${runtime.id}`
            )
        return { agent, runtime, framework }
    }

    private async installedMap(
        agentId: string
    ): Promise<Map<string, InstalledSkillState>> {
        const rows = await this.db
            .select()
            .from(userSkills)
            .where(and(eq(userSkills.agentId, agentId)))
        return new Map(
            rows
                .filter((row) => row.skillId !== null)
                .map((row) => [
                    row.skillId as string,
                    {
                        userSkillId: row.id,
                        enabled: row.enabled,
                        installDir: row.installDir
                    }
                ])
        )
    }

    private async nextInstallDir(
        userId: string,
        input: { agentId: string; base: string; seed: string }
    ): Promise<string> {
        const base = assertSafeInstallDir(installDirBase(input.base))
        const [existing] = await this.db
            .select({ id: userSkills.id, skillId: userSkills.skillId })
            .from(userSkills)
            .where(
                and(
                    eq(userSkills.userId, userId),
                    eq(userSkills.agentId, input.agentId),
                    eq(userSkills.installDir, base)
                )
            )
            .limit(1)
        if (!existing) return base
        const suffixed = installDirWithSuffix(base, input.seed)
        const [collision] = await this.db
            .select({ id: userSkills.id })
            .from(userSkills)
            .where(
                and(
                    eq(userSkills.userId, userId),
                    eq(userSkills.agentId, input.agentId),
                    eq(userSkills.installDir, suffixed)
                )
            )
            .limit(1)
        if (!collision) return suffixed
        return installDirWithSuffix(
            base,
            `${input.seed}:${deterministicSuffix(suffixed)}`
        )
    }

    private async findUserSkillBySkill(
        userId: string,
        agentId: string,
        skillId: string
    ): Promise<UserSkillRow | null> {
        const [row] = await this.db
            .select()
            .from(userSkills)
            .where(
                and(
                    eq(userSkills.userId, userId),
                    eq(userSkills.agentId, agentId),
                    eq(userSkills.skillId, skillId)
                )
            )
            .limit(1)
        return row ?? null
    }

    private async getOwnedUserSkill(
        userId: string,
        id: string
    ): Promise<UserSkillRow> {
        const [row] = await this.db
            .select()
            .from(userSkills)
            .where(and(eq(userSkills.id, id), eq(userSkills.userId, userId)))
            .limit(1)
        if (!row) throw new NotFoundException(`skill ${id}`)
        return row
    }

    private async getOwnedRepo(
        userId: string,
        id: string
    ): Promise<SkillRepoRow> {
        if (id.startsWith('builtin:'))
            throw new BadRequestException('builtin skill repos are readonly')
        const [row] = await this.db
            .select()
            .from(skillRepos)
            .where(and(eq(skillRepos.id, id), eq(skillRepos.userId, userId)))
            .limit(1)
        if (!row) throw new NotFoundException(`skill repo ${id}`)
        return row
    }

    private assertFramework(framework: SkillFramework): SkillFramework {
        try {
            return assertSkillFramework(framework)
        } catch {
            throw new BadRequestException(
                `unsupported skills framework ${framework}`
            )
        }
    }
}

const customRepoToDiscovery = (row: SkillRepoRow): DiscoveryRepo => ({
    id: row.id,
    owner: row.owner,
    name: row.name,
    branch: row.branch,
    enabled: row.enabled,
    readonly: false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const installedSummary = (
    userSkill: UserSkillRow,
    skill: SkillRow,
    target: SkillTarget
): InstalledSkillSummary => {
    parseSkillId(skill.id)
    return {
        id: userSkill.id,
        skillId: skill.id,
        agentId: target.agent.id,
        runtimeId: target.runtime.id,
        name: skill.name,
        description: skill.description,
        source: 'nca',
        readonly: false,
        framework: userSkill.framework,
        enabled: userSkill.enabled,
        materializeStatus: userSkill.materializeStatus,
        materializeError: userSkill.materializeError,
        installDir: userSkill.installDir,
        installedRevision: userSkill.installedRevision,
        installedVersion: userSkill.installedVersion,
        latestRevision: skill.latestRevision,
        repoOwner: skill.repoOwner,
        repoName: skill.repoName,
        repoBranch: skill.repoBranch,
        sourcePath: skill.sourcePath,
        readmeUrl: skill.readmeUrl,
        createdAt: userSkill.createdAt.toISOString(),
        updatedAt: userSkill.updatedAt.toISOString()
    }
}

// Sentinel repo fields follow the runtimeSummary precedent: library skills
// have no GitHub coordinates, and latestRevision = contentHash lets the web's
// existing "update available" check work for edited library skills unchanged.
const librarySummary = (
    userSkill: UserSkillRow,
    library: LibrarySkillRow,
    target: SkillTarget
): InstalledSkillSummary => ({
    id: userSkill.id,
    skillId: library.id,
    agentId: target.agent.id,
    runtimeId: target.runtime.id,
    name: library.name,
    description: library.description,
    source: 'library',
    readonly: false,
    framework: userSkill.framework,
    enabled: userSkill.enabled,
    materializeStatus: userSkill.materializeStatus,
    materializeError: userSkill.materializeError,
    installDir: userSkill.installDir,
    installedRevision: userSkill.installedRevision,
    installedVersion: userSkill.installedVersion,
    latestRevision: library.contentHash,
    repoOwner: 'library',
    repoName: '',
    repoBranch: '',
    sourcePath: '.',
    readmeUrl: null,
    createdAt: userSkill.createdAt.toISOString(),
    updatedAt: userSkill.updatedAt.toISOString()
})

const runtimeSummary = (
    item: RuntimeSkillInventoryItem,
    target: SkillTarget
): InstalledSkillSummary => {
    const hash = createHash('sha256')
        .update(`${target.agent.id}:${item.sourcePath}:${item.installDir}`)
        .digest('hex')
        .slice(0, 16)
    return {
        id: `runtime:${hash}`,
        skillId: `runtime:hermes:${hash}`,
        agentId: target.agent.id,
        runtimeId: target.runtime.id,
        name: item.name,
        description: item.description,
        source: 'runtime',
        readonly: true,
        framework: target.framework,
        enabled: true,
        materializeStatus: 'installed',
        materializeError: null,
        installDir: item.installDir,
        installedRevision: null,
        installedVersion: null,
        latestRevision: null,
        repoOwner: 'runtime',
        repoName: 'hermes',
        repoBranch: '',
        sourcePath: item.sourcePath,
        readmeUrl: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
    }
}

const targetSummary = (target: SkillTarget): SkillTargetAgentSummary => ({
    id: target.agent.id,
    name: target.agent.name,
    framework: target.framework,
    status: target.agent.status,
    runtime: target.agent.runtime,
    runtimeId: target.runtime.id,
    runtimeName: target.runtime.name,
    runtimeKind: target.runtime.kind,
    runtimeStatus: target.runtime.status
})

const repoCond = (repo: DiscoveryRepo): SQL =>
    and(
        eq(skills.repoOwner, repo.owner),
        eq(skills.repoName, repo.name),
        eq(skills.repoBranch, repo.branch)
    ) as SQL

const skillSearchCond = (q: string): SQL =>
    or(
        ilike(skills.name, likeNeedle(q)),
        ilike(skills.description, likeNeedle(q)),
        ilike(skills.repoOwner, likeNeedle(q)),
        ilike(skills.repoName, likeNeedle(q)),
        ilike(skills.sourcePath, likeNeedle(q))
    ) as SQL

const adminCatalogItem = (row: SkillJoinedRow): AdminSkillCatalogItem => ({
    skillId: row.skill.id,
    name: row.skill.name,
    description: row.skill.description,
    repoOwner: row.skill.repoOwner,
    repoName: row.skill.repoName,
    repoBranch: row.skill.repoBranch,
    sourcePath: row.skill.sourcePath,
    latestRevision: row.skill.latestRevision,
    readmeUrl: row.skill.readmeUrl,
    categoryId: row.skill.categoryId,
    category:
        row.skill.categoryId && row.categoryName !== null
            ? { id: row.skill.categoryId, name: row.categoryName }
            : null,
    tags: row.skill.tags,
    featured: row.skill.featured,
    hidden: row.skill.hidden,
    createdAt: row.skill.createdAt.toISOString(),
    updatedAt: row.skill.updatedAt.toISOString()
})

const discoveryRepoKey = (repo: DiscoveryRepo): string =>
    `${repo.owner}/${repo.name}@${repo.branch}`

const skillRowRepoKey = (row: SkillRow): string =>
    `${row.repoOwner}/${row.repoName}@${row.repoBranch}`

const throwBadRequestForUnsafeInput = (err: unknown): never => {
    if (err instanceof BadRequestException) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('invalid ')) throw new BadRequestException(message)
    throw err
}
