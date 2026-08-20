import {
    CreateLibrarySkillBody,
    ImportLibrarySkillBody,
    ImportLibrarySkillResult,
    LibrarySkillDetail,
    LibrarySkillImportConflict,
    LibrarySkillSummary,
    PushLibrarySkillResult,
    UpdateLibrarySkillBody,
    UpsertLibrarySkillFileBody,
    createObjectId
} from '@manyfold/shared'
import { createHash } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    PayloadTooLargeException
} from '@nestjs/common'
import { and, asc, count, countDistinct, eq } from 'drizzle-orm'
import { strToU8, unzipSync, zipSync } from 'fflate'
import {
    librarySkillFiles,
    librarySkills,
    userSkills,
    type Database,
    type LibrarySkillFileRow,
    type LibrarySkillOrigin,
    type LibrarySkillRow
} from '@manyfold/db'
import { sanitizePgText } from '@/common/jsonb-sanitize'
import { DRIZZLE } from '@/db/tokens'
import {
    LibrarySkillSharesService,
    shareNotFound
} from './library-skill-shares.service'
import {
    parseSkillMarkdown,
    SkillDiscoveryService
} from './skill-discovery.service'
import { SkillMaterializerService } from './skill-materializer.service'
import {
    assertSafeGitHubOwner,
    assertSafeGitHubRepo,
    assertSafeGitRef,
    assertSafeLibraryFilePath,
    assertSafeSourcePath,
    installDirBase,
    MAX_LIBRARY_SKILL_FILE_BYTES,
    MAX_LIBRARY_SKILL_FILE_COUNT,
    MAX_LIBRARY_SKILL_TOTAL_BYTES,
    parseSkillId,
    SKILL_CONTENT_FILENAME
} from './skill-utils'

interface SkillFileInput {
    path: string
    content: string
}

interface SkillBundleInput {
    name: string
    description: string | null
    content: string
    files: SkillFileInput[]
    origin: LibrarySkillOrigin
}

interface GitHubSkillSource {
    owner: string
    repo: string
    ref: string | null
    path: string
    url: string
}

const MAX_SKILL_NAME_LENGTH = 100
const MAX_RENAME_ATTEMPTS = 50
const GITHUB_FETCH_BATCH = 10

@Injectable()
export class LibrarySkillsService {
    private readonly log = new Logger(LibrarySkillsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly discovery: SkillDiscoveryService,
        private readonly materializer: SkillMaterializerService,
        private readonly shares: LibrarySkillSharesService
    ) {}

    async list(userId: string): Promise<LibrarySkillSummary[]> {
        const rows = await this.db
            .select()
            .from(librarySkills)
            .where(eq(librarySkills.userId, userId))
            .orderBy(asc(librarySkills.name))
        if (rows.length === 0) return []
        const [fileCounts, installCounts] = await Promise.all([
            this.fileCounts(userId),
            this.installCounts(userId)
        ])
        return rows.map((row) =>
            toSummary(
                row,
                fileCounts.get(row.id) ?? 0,
                installCounts.get(row.id) ?? 0
            )
        )
    }

    async get(userId: string, id: string): Promise<LibrarySkillDetail> {
        const row = await this.getOwned(userId, id)
        return this.detail(row)
    }

    async create(
        userId: string,
        body: CreateLibrarySkillBody
    ): Promise<LibrarySkillDetail> {
        const name = normalizeSkillName(body.name)
        const description = normalizeDescription(body.description)
        const rawContent = sanitizePgText(body.content ?? '').trim()
        const content = ensureSkillFrontmatter(
            rawContent || defaultSkillContent(name, description),
            name,
            description
        )
        assertContentSize(content)
        const parsed = parseSkillMarkdown(content)
        const row = await this.insertSkill(userId, {
            name,
            description: description ?? parsed.description,
            content,
            files: [],
            origin: { type: 'manual' }
        })
        return this.detail(row)
    }

    async update(
        userId: string,
        id: string,
        body: UpdateLibrarySkillBody
    ): Promise<LibrarySkillDetail> {
        const existing = await this.getOwned(userId, id)
        if (
            body.name === undefined &&
            body.description === undefined &&
            body.content === undefined
        )
            return this.detail(existing)

        let content =
            body.content !== undefined
                ? ensureSkillFrontmatter(
                      sanitizePgText(body.content),
                      existing.name,
                      existing.description
                  )
                : existing.content
        const overrides: { name?: string; description?: string } = {}
        if (body.name !== undefined)
            overrides.name = normalizeSkillName(body.name)
        if (body.description !== undefined)
            overrides.description = normalizeDescription(body.description) ?? ''
        if (overrides.name !== undefined || overrides.description !== undefined)
            content = setFrontmatterFields(content, overrides)
        assertContentSize(content)

        const parsed = parseSkillMarkdown(content)
        const name = overrides.name ?? parsed.name ?? existing.name
        const description =
            overrides.description !== undefined
                ? overrides.description || null
                : (parsed.description ?? existing.description)

        const files = await this.filesFor(existing.id)
        const contentHash = computeContentHash(name, content, files)
        try {
            const [row] = await this.db
                .update(librarySkills)
                .set({
                    name,
                    description,
                    content,
                    contentHash,
                    updatedAt: new Date()
                })
                .where(eq(librarySkills.id, existing.id))
                .returning()
            return this.detail(row)
        } catch (err) {
            throw translateNameConflict(err, name)
        }
    }

    async remove(userId: string, id: string, force: boolean): Promise<void> {
        const existing = await this.getOwned(userId, id)
        const installs = await this.db
            .select({
                id: userSkills.id,
                agentId: userSkills.agentId
            })
            .from(userSkills)
            .where(eq(userSkills.librarySkillId, existing.id))
        if (installs.length > 0 && !force)
            throw new ConflictException({
                message: `skill "${existing.name}" is installed on ${installs.length} agent(s); pass force=true to uninstall and delete`,
                code: 'skill_installed',
                details: {
                    installedAgentIds: [
                        ...new Set(
                            installs
                                .map((row) => row.agentId)
                                .filter((v): v is string => v !== null)
                        )
                    ]
                }
            })
        await this.db
            .delete(userSkills)
            .where(eq(userSkills.librarySkillId, existing.id))
        await this.db
            .delete(librarySkills)
            .where(eq(librarySkills.id, existing.id))
        const agentIds = [
            ...new Set(
                installs
                    .map((row) => row.agentId)
                    .filter((v): v is string => v !== null)
            )
        ]
        for (const agentId of agentIds) {
            try {
                await this.materializer.materializeAgent(agentId)
            } catch (err) {
                this.log.warn(
                    `post-delete materialize failed for agent ${agentId}: ${(err as Error).message}`
                )
            }
        }
    }

    async upsertFile(
        userId: string,
        id: string,
        body: UpsertLibrarySkillFileBody
    ): Promise<LibrarySkillDetail> {
        const existing = await this.getOwned(userId, id)
        const path = assertLibraryPathOrBadRequest(body.path)
        const content = sanitizePgText(body.content)
        if (byteLength(content) > MAX_LIBRARY_SKILL_FILE_BYTES)
            throw new PayloadTooLargeException(
                `file ${path} exceeds ${MAX_LIBRARY_SKILL_FILE_BYTES} bytes`
            )
        const files = await this.filesFor(existing.id)
        const isNew = !files.some((file) => file.path === path)
        if (isNew && files.length >= MAX_LIBRARY_SKILL_FILE_COUNT)
            throw new BadRequestException(
                `skill has too many files (max ${MAX_LIBRARY_SKILL_FILE_COUNT})`
            )
        const othersTotal = files
            .filter((file) => file.path !== path)
            .reduce((sum, file) => sum + byteLength(file.content), 0)
        if (
            othersTotal + byteLength(content) + byteLength(existing.content) >
            MAX_LIBRARY_SKILL_TOTAL_BYTES
        )
            throw new PayloadTooLargeException(
                `skill exceeds ${MAX_LIBRARY_SKILL_TOTAL_BYTES} bytes in total`
            )
        await this.db
            .insert(librarySkillFiles)
            .values({
                id: createObjectId('librarySkillFile'),
                librarySkillId: existing.id,
                path,
                content
            })
            .onConflictDoUpdate({
                target: [librarySkillFiles.librarySkillId, librarySkillFiles.path],
                set: { content, updatedAt: new Date() }
            })
        const row = await this.bumpContentHash(existing.id)
        return this.detail(row)
    }

    async deleteFile(
        userId: string,
        id: string,
        fileId: string
    ): Promise<LibrarySkillDetail> {
        const existing = await this.getOwned(userId, id)
        const [file] = await this.db
            .select()
            .from(librarySkillFiles)
            .where(
                and(
                    eq(librarySkillFiles.id, fileId),
                    eq(librarySkillFiles.librarySkillId, existing.id)
                )
            )
            .limit(1)
        if (!file) throw new NotFoundException(`skill file ${fileId}`)
        await this.db
            .delete(librarySkillFiles)
            .where(eq(librarySkillFiles.id, fileId))
        const row = await this.bumpContentHash(existing.id)
        return this.detail(row)
    }

    async importFromSource(
        userId: string,
        body: ImportLibrarySkillBody
    ): Promise<ImportLibrarySkillResult> {
        const sources = [body.url, body.catalogSkillId, body.shareId].filter(
            (value) => value !== undefined
        )
        if (sources.length !== 1)
            throw new BadRequestException(
                'exactly one of url, catalogSkillId or shareId is required'
            )
        const onConflict = body.onConflict ?? 'fail'
        if (body.shareId)
            return this.importFromShare(userId, body.shareId, onConflict)
        const source = body.catalogSkillId
            ? catalogSource(body.catalogSkillId)
            : parseImportUrl(body.url as string)
        const bundle = await this.fetchGitHubBundle(source, {
            type: body.catalogSkillId ? 'catalog' : 'github',
            url: source.url,
            ...(body.catalogSkillId
                ? { catalogSkillId: body.catalogSkillId }
                : {})
        })
        return this.persistImported(userId, bundle, onConflict)
    }

    private async importFromShare(
        userId: string,
        shareId: string,
        onConflict: LibrarySkillImportConflict
    ): Promise<ImportLibrarySkillResult> {
        const resolved = await this.shares.resolveActiveShare(shareId)
        if (!resolved) throw shareNotFound()
        const files = await this.filesFor(resolved.skill.id)
        const result = await this.persistImported(
            userId,
            {
                name: resolved.skill.name,
                description: resolved.skill.description,
                content: resolved.skill.content,
                files: files.map((file) => ({
                    path: file.path,
                    content: file.content
                })),
                origin: { type: 'share', shareId }
            },
            onConflict
        )
        await this.shares.recordImport(shareId)
        return result
    }

    async importFromArchive(
        userId: string,
        data: Buffer,
        filename: string,
        onConflict: LibrarySkillImportConflict
    ): Promise<ImportLibrarySkillResult> {
        const bundle = parseSkillArchive(data, filename)
        return this.persistImported(userId, bundle, onConflict)
    }

    // Re-point every (or the selected) installed agent at the current
    // contentHash and re-materialize, so an edit propagates without visiting
    // each agent's skills tab. Per-agent failures are reported, not thrown —
    // a stopped sandbox must not block the rest.
    async push(
        userId: string,
        id: string,
        agentIds?: string[]
    ): Promise<PushLibrarySkillResult> {
        const skill = await this.getOwned(userId, id)
        const version = parseSkillMarkdown(skill.content).version
        const installs = await this.db
            .select()
            .from(userSkills)
            .where(
                and(
                    eq(userSkills.userId, userId),
                    eq(userSkills.librarySkillId, skill.id)
                )
            )
        const wanted = agentIds ? new Set(agentIds) : null
        const targets = installs.filter(
            (row): row is typeof row & { agentId: string } =>
                row.agentId !== null && (!wanted || wanted.has(row.agentId))
        )
        const results: PushLibrarySkillResult['results'] = []
        for (const install of targets) {
            try {
                await this.db
                    .update(userSkills)
                    .set({
                        installedRevision: skill.contentHash,
                        installedVersion: version,
                        updatedAt: new Date()
                    })
                    .where(eq(userSkills.id, install.id))
                await this.materializer.materializeAgent(install.agentId)
                results.push({ agentId: install.agentId, status: 'pushed' })
            } catch (err) {
                results.push({
                    agentId: install.agentId,
                    status: 'failed',
                    error: (err as Error).message
                })
            }
        }
        return { results }
    }

    async exportArchive(
        userId: string,
        id: string
    ): Promise<{ filename: string; data: Buffer }> {
        const row = await this.getOwned(userId, id)
        const files = await this.filesFor(row.id)
        const dir = installDirBase(row.name)
        const entries: Record<string, Uint8Array> = {
            [`${dir}/${SKILL_CONTENT_FILENAME}`]: strToU8(row.content)
        }
        for (const file of files)
            entries[`${dir}/${file.path}`] = strToU8(file.content)
        return {
            filename: `${dir}.skill`,
            data: Buffer.from(zipSync(entries))
        }
    }

    private async fetchGitHubBundle(
        source: GitHubSkillSource,
        origin: LibrarySkillOrigin
    ): Promise<SkillBundleInput> {
        let owner: string
        let repo: string
        let path: string
        try {
            owner = assertSafeGitHubOwner(source.owner)
            repo = assertSafeGitHubRepo(source.repo)
            path = assertSafeSourcePath(source.path)
        } catch (err) {
            throw new BadRequestException((err as Error).message)
        }
        const ref = assertRefOrBadRequest(
            source.ref ?? (await this.discovery.fetchDefaultBranch(owner, repo))
        )
        const tree = await this.discovery.resolveRepoTree({
            owner,
            name: repo,
            ref
        })
        const prefix = path === '.' ? '' : `${path}/`
        const scoped = tree.entries.filter(
            (entry) =>
                entry.path.startsWith(prefix) || entry.path === path
        )
        const relative = scoped.map((entry) => ({
            path:
                entry.path === path
                    ? entry.path.split('/').pop() as string
                    : entry.path.slice(prefix.length),
            repoPath: entry.path,
            size: entry.size
        }))
        const root = shallowestSkillMdRoot(relative.map((entry) => entry.path))
        if (root === null)
            throw new BadRequestException(
                `no ${SKILL_CONTENT_FILENAME} found under ${owner}/${repo}@${ref}:${path}`
            )
        const rootPrefix = root === '' ? '' : `${root}/`
        const selected = relative
            .filter((entry) => entry.path.startsWith(rootPrefix))
            .map((entry) => ({
                ...entry,
                path: entry.path.slice(rootPrefix.length)
            }))
            .filter(
                (entry) =>
                    entry.path === SKILL_CONTENT_FILENAME ||
                    !shouldIgnoreImportPath(entry.path)
            )
        if (selected.length > MAX_LIBRARY_SKILL_FILE_COUNT)
            throw new BadRequestException(
                `skill has too many files (max ${MAX_LIBRARY_SKILL_FILE_COUNT})`
            )
        const oversize = selected.find(
            (entry) => entry.size > MAX_LIBRARY_SKILL_FILE_BYTES
        )
        if (oversize)
            throw new PayloadTooLargeException(
                `file ${oversize.path} exceeds ${MAX_LIBRARY_SKILL_FILE_BYTES} bytes`
            )

        const repoRef = { owner, name: repo, branch: tree.revision }
        const fetched: { path: string; content: string }[] = []
        let total = 0
        for (let i = 0; i < selected.length; i += GITHUB_FETCH_BATCH) {
            const batch = selected.slice(i, i + GITHUB_FETCH_BATCH)
            const results = await Promise.all(
                batch.map(async (entry) => ({
                    entry,
                    raw: await this.discovery.fetchRepoFileRaw(
                        repoRef,
                        entry.repoPath
                    )
                }))
            )
            for (const { entry, raw } of results) {
                if (raw === null || raw.length === 0) {
                    if (entry.path === SKILL_CONTENT_FILENAME)
                        throw new BadRequestException(
                            `failed to fetch ${SKILL_CONTENT_FILENAME} from GitHub`
                        )
                    continue
                }
                if (looksBinary(raw)) {
                    if (entry.path === SKILL_CONTENT_FILENAME)
                        throw new BadRequestException(
                            `${SKILL_CONTENT_FILENAME} is not a text file`
                        )
                    continue
                }
                total += raw.length
                if (total > MAX_LIBRARY_SKILL_TOTAL_BYTES)
                    throw new PayloadTooLargeException(
                        `skill exceeds ${MAX_LIBRARY_SKILL_TOTAL_BYTES} bytes in total`
                    )
                fetched.push({
                    path: entry.path,
                    content: sanitizePgText(raw.toString('utf8'))
                })
            }
        }
        const skillMd = fetched.find(
            (entry) => entry.path === SKILL_CONTENT_FILENAME
        )
        if (!skillMd)
            throw new BadRequestException(
                `no ${SKILL_CONTENT_FILENAME} found under ${owner}/${repo}@${ref}:${path}`
            )
        const parsed = parseSkillMarkdown(skillMd.content)
        const fallbackName =
            root !== ''
                ? root.split('/').pop()
                : path !== '.'
                  ? path.split('/').pop()
                  : repo
        const name = normalizeSkillName(parsed.name ?? fallbackName ?? repo)
        const files = fetched
            .filter((entry) => entry.path !== SKILL_CONTENT_FILENAME)
            .map((entry) => ({
                path: assertLibraryPathOrBadRequest(entry.path),
                content: entry.content
            }))
        return {
            name,
            description: parsed.description,
            content: ensureSkillFrontmatter(
                skillMd.content,
                name,
                parsed.description
            ),
            files,
            origin
        }
    }

    private async persistImported(
        userId: string,
        bundle: SkillBundleInput,
        onConflict: LibrarySkillImportConflict,
        attempt = 0
    ): Promise<ImportLibrarySkillResult> {
        const [existing] = await this.db
            .select()
            .from(librarySkills)
            .where(
                and(
                    eq(librarySkills.userId, userId),
                    eq(librarySkills.name, bundle.name)
                )
            )
            .limit(1)
        if (!existing) {
            try {
                const row = await this.insertSkill(userId, bundle)
                return { status: 'created', skill: await this.detail(row) }
            } catch (err) {
                if (isNameConflict(err) && attempt === 0)
                    return this.persistImported(
                        userId,
                        bundle,
                        onConflict,
                        attempt + 1
                    )
                throw translateNameConflict(err, bundle.name)
            }
        }
        if (onConflict === 'overwrite') {
            const row = await this.overwriteSkill(existing, bundle)
            return { status: 'updated', skill: await this.detail(row) }
        }
        if (onConflict === 'rename') {
            const renamed = await this.nextFreeName(userId, bundle.name)
            const row = await this.insertSkill(userId, {
                ...bundle,
                name: renamed,
                content: setFrontmatterFields(bundle.content, {
                    name: renamed
                })
            })
            return { status: 'created', skill: await this.detail(row) }
        }
        throw new ConflictException({
            message: `a skill named "${bundle.name}" already exists in your library`,
            code: 'skill_name_conflict',
            details: {
                existingSkill: { id: existing.id, name: existing.name }
            }
        })
    }

    private async insertSkill(
        userId: string,
        bundle: SkillBundleInput
    ): Promise<LibrarySkillRow> {
        assertBundleSize(bundle)
        const contentHash = computeContentHash(
            bundle.name,
            bundle.content,
            bundle.files
        )
        try {
            return await this.db.transaction(async (tx) => {
                const [row] = await tx
                    .insert(librarySkills)
                    .values({
                        id: createObjectId('librarySkill'),
                        userId,
                        name: bundle.name,
                        description: bundle.description,
                        content: bundle.content,
                        origin: bundle.origin,
                        contentHash
                    })
                    .returning()
                if (bundle.files.length > 0)
                    await tx.insert(librarySkillFiles).values(
                        bundle.files.map((file) => ({
                            id: createObjectId('librarySkillFile'),
                            librarySkillId: row.id,
                            path: file.path,
                            content: file.content
                        }))
                    )
                return row
            })
        } catch (err) {
            throw translateNameConflict(err, bundle.name)
        }
    }

    private async overwriteSkill(
        existing: LibrarySkillRow,
        bundle: SkillBundleInput
    ): Promise<LibrarySkillRow> {
        assertBundleSize(bundle)
        const contentHash = computeContentHash(
            existing.name,
            bundle.content,
            bundle.files
        )
        return this.db.transaction(async (tx) => {
            const [row] = await tx
                .update(librarySkills)
                .set({
                    description: bundle.description,
                    content: bundle.content,
                    origin: bundle.origin,
                    contentHash,
                    updatedAt: new Date()
                })
                .where(eq(librarySkills.id, existing.id))
                .returning()
            await tx
                .delete(librarySkillFiles)
                .where(eq(librarySkillFiles.librarySkillId, existing.id))
            if (bundle.files.length > 0)
                await tx.insert(librarySkillFiles).values(
                    bundle.files.map((file) => ({
                        id: createObjectId('librarySkillFile'),
                        librarySkillId: existing.id,
                        path: file.path,
                        content: file.content
                    }))
                )
            return row
        })
    }

    private async nextFreeName(userId: string, base: string): Promise<string> {
        for (let i = 2; i <= MAX_RENAME_ATTEMPTS; i++) {
            const candidate = truncateName(`${base}-${i}`)
            const [row] = await this.db
                .select({ id: librarySkills.id })
                .from(librarySkills)
                .where(
                    and(
                        eq(librarySkills.userId, userId),
                        eq(librarySkills.name, candidate)
                    )
                )
                .limit(1)
            if (!row) return candidate
        }
        throw new ConflictException(
            `could not find a free name for "${base}" after ${MAX_RENAME_ATTEMPTS} attempts`
        )
    }

    private async bumpContentHash(id: string): Promise<LibrarySkillRow> {
        const [skill] = await this.db
            .select()
            .from(librarySkills)
            .where(eq(librarySkills.id, id))
            .limit(1)
        if (!skill) throw new NotFoundException(`library skill ${id}`)
        const files = await this.filesFor(id)
        const contentHash = computeContentHash(
            skill.name,
            skill.content,
            files
        )
        const [row] = await this.db
            .update(librarySkills)
            .set({ contentHash, updatedAt: new Date() })
            .where(eq(librarySkills.id, id))
            .returning()
        return row
    }

    private async detail(row: LibrarySkillRow): Promise<LibrarySkillDetail> {
        const files = await this.filesFor(row.id)
        const installs = await this.db
            .select({ value: countDistinct(userSkills.agentId) })
            .from(userSkills)
            .where(eq(userSkills.librarySkillId, row.id))
        return {
            ...toSummary(row, files.length, installs[0]?.value ?? 0),
            content: row.content,
            files: files.map((file) => ({
                id: file.id,
                path: file.path,
                content: file.content
            }))
        }
    }

    private async filesFor(id: string): Promise<LibrarySkillFileRow[]> {
        return this.db
            .select()
            .from(librarySkillFiles)
            .where(eq(librarySkillFiles.librarySkillId, id))
            .orderBy(asc(librarySkillFiles.path))
    }

    private async fileCounts(userId: string): Promise<Map<string, number>> {
        const rows = await this.db
            .select({
                librarySkillId: librarySkillFiles.librarySkillId,
                value: count()
            })
            .from(librarySkillFiles)
            .innerJoin(
                librarySkills,
                eq(librarySkillFiles.librarySkillId, librarySkills.id)
            )
            .where(eq(librarySkills.userId, userId))
            .groupBy(librarySkillFiles.librarySkillId)
        return new Map(rows.map((row) => [row.librarySkillId, row.value]))
    }

    private async installCounts(userId: string): Promise<Map<string, number>> {
        const rows = await this.db
            .select({
                librarySkillId: userSkills.librarySkillId,
                value: countDistinct(userSkills.agentId)
            })
            .from(userSkills)
            .where(eq(userSkills.userId, userId))
            .groupBy(userSkills.librarySkillId)
        return new Map(
            rows
                .filter(
                    (row): row is { librarySkillId: string; value: number } =>
                        row.librarySkillId !== null
                )
                .map((row) => [row.librarySkillId, row.value])
        )
    }

    private async getOwned(
        userId: string,
        id: string
    ): Promise<LibrarySkillRow> {
        const [row] = await this.db
            .select()
            .from(librarySkills)
            .where(
                and(
                    eq(librarySkills.id, id),
                    eq(librarySkills.userId, userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException(`library skill ${id}`)
        return row
    }
}

const toSummary = (
    row: LibrarySkillRow,
    fileCount: number,
    installedAgentCount: number
): LibrarySkillSummary => ({
    id: row.id,
    name: row.name,
    description: row.description,
    origin: row.origin ?? null,
    contentHash: row.contentHash,
    fileCount,
    installedAgentCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

export const computeContentHash = (
    name: string,
    content: string,
    files: { path: string; content: string }[]
): string => {
    const hash = createHash('sha256')
    hash.update('v1\0')
    hash.update(name)
    hash.update('\0')
    hash.update(sha256(content))
    for (const file of [...files].sort((a, b) =>
        a.path.localeCompare(b.path)
    )) {
        hash.update('\0')
        hash.update(file.path)
        hash.update('\0')
        hash.update(sha256(file.content))
    }
    return hash.digest('hex')
}

const sha256 = (value: string): string =>
    createHash('sha256').update(value).digest('hex')

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

const normalizeSkillName = (value: string): string => {
    const name = sanitizePgText(value).trim()
    if (!name || name.length > MAX_SKILL_NAME_LENGTH)
        throw new BadRequestException(
            `skill name must be 1-${MAX_SKILL_NAME_LENGTH} characters`
        )
    return name
}

const truncateName = (value: string): string =>
    value.length <= MAX_SKILL_NAME_LENGTH
        ? value
        : value.slice(value.length - MAX_SKILL_NAME_LENGTH)

const normalizeDescription = (value: string | undefined): string | null => {
    if (value === undefined) return null
    const trimmed = sanitizePgText(value).trim()
    return trimmed || null
}

const defaultSkillContent = (
    name: string,
    description: string | null
): string => `# ${name}\n\n${description ?? ''}\n`

const assertContentSize = (content: string): void => {
    if (byteLength(content) > MAX_LIBRARY_SKILL_FILE_BYTES)
        throw new PayloadTooLargeException(
            `${SKILL_CONTENT_FILENAME} exceeds ${MAX_LIBRARY_SKILL_FILE_BYTES} bytes`
        )
}

const assertBundleSize = (bundle: SkillBundleInput): void => {
    assertContentSize(bundle.content)
    if (bundle.files.length > MAX_LIBRARY_SKILL_FILE_COUNT)
        throw new BadRequestException(
            `skill has too many files (max ${MAX_LIBRARY_SKILL_FILE_COUNT})`
        )
    const total =
        byteLength(bundle.content) +
        bundle.files.reduce((sum, file) => sum + byteLength(file.content), 0)
    if (total > MAX_LIBRARY_SKILL_TOTAL_BYTES)
        throw new PayloadTooLargeException(
            `skill exceeds ${MAX_LIBRARY_SKILL_TOTAL_BYTES} bytes in total`
        )
}

const assertLibraryPathOrBadRequest = (value: string): string => {
    try {
        return assertSafeLibraryFilePath(value)
    } catch (err) {
        throw new BadRequestException((err as Error).message)
    }
}

const assertRefOrBadRequest = (value: string): string => {
    try {
        return assertSafeGitRef(value)
    } catch (err) {
        throw new BadRequestException((err as Error).message)
    }
}

const isNameConflict = (err: unknown): boolean =>
    err instanceof Error &&
    err.message.includes('library_skills_user_name_unique')

const translateNameConflict = (err: unknown, name: string): unknown => {
    if (isNameConflict(err))
        return new ConflictException({
            message: `a skill named "${name}" already exists in your library`,
            code: 'skill_name_conflict'
        })
    return err
}

const looksBinary = (buf: Buffer): boolean => buf.includes(0)

// Frontmatter block boundaries: returns [innerStart, innerEnd] offsets of the
// YAML between the opening and closing --- fences, or null when absent.
const frontmatterBounds = (content: string): [number, number] | null => {
    if (!content.startsWith('---')) return null
    const afterOpen = content.indexOf('\n', 3)
    if (afterOpen === -1) return null
    const close = content.indexOf('\n---', afterOpen)
    if (close === -1) return null
    return [afterOpen + 1, close + 1]
}

const yamlScalar = (value: string): string => JSON.stringify(value)

// Runtimes like Codex and OpenCode silently drop skills whose SKILL.md lacks
// a frontmatter `name`, so imported/authored content gets a block synthesized
// or the missing field injected.
export const ensureSkillFrontmatter = (
    content: string,
    name: string,
    description: string | null
): string => {
    const bounds = frontmatterBounds(content)
    if (bounds) {
        const inner = content.slice(bounds[0], bounds[1])
        if (/^name\s*:/m.test(inner)) return content
        return (
            content.slice(0, bounds[0]) +
            `name: ${yamlScalar(name)}\n` +
            content.slice(bounds[0])
        )
    }
    const header = [
        '---',
        `name: ${yamlScalar(name)}`,
        ...(description ? [`description: ${yamlScalar(description)}`] : []),
        '---',
        ''
    ].join('\n')
    return `${header}\n${content.replace(/^\s+/, '')}`
}

export const setFrontmatterFields = (
    content: string,
    fields: { name?: string; description?: string }
): string => {
    let result = ensureSkillFrontmatter(
        content,
        fields.name ?? 'skill',
        fields.description ?? null
    )
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue
        const bounds = frontmatterBounds(result) as [number, number]
        const inner = result.slice(bounds[0], bounds[1])
        const line = `${key}: ${yamlScalar(value)}`
        const re = new RegExp(`^${key}\\s*:.*$`, 'm')
        const replaced = re.test(inner)
            ? inner.replace(re, line)
            : `${line}\n${inner}`
        result = result.slice(0, bounds[0]) + replaced + result.slice(bounds[1])
    }
    return result
}

// Root the bundle on the shallowest SKILL.md so both `SKILL.md` at the top
// level and a `my-skill/SKILL.md` wrapper layout import cleanly.
export const shallowestSkillMdRoot = (paths: string[]): string | null => {
    const candidates = paths
        .filter(
            (path) =>
                path === SKILL_CONTENT_FILENAME ||
                path.endsWith(`/${SKILL_CONTENT_FILENAME}`)
        )
        .map((path) =>
            path === SKILL_CONTENT_FILENAME
                ? ''
                : path.slice(0, -SKILL_CONTENT_FILENAME.length - 1)
        )
        .sort(
            (a, b) =>
                (a === '' ? 0 : a.split('/').length) -
                    (b === '' ? 0 : b.split('/').length) || a.localeCompare(b)
        )
    return candidates.length > 0 ? candidates[0] : null
}

const IGNORED_BASENAMES = /^(license|licence|notice)(\.[a-z]+)?$/i

export const shouldIgnoreImportPath = (path: string): boolean => {
    const segments = path.split('/')
    if (segments.some((segment) => segment.startsWith('.'))) return true
    if (segments.some((segment) => segment === '__MACOSX')) return true
    const basename = segments[segments.length - 1]
    if (IGNORED_BASENAMES.test(basename)) return true
    // A nested SKILL.md is another skill's primary content, not a supporting
    // file of this one — importing it would double-materialize.
    if (
        path !== SKILL_CONTENT_FILENAME &&
        basename.toLowerCase() === SKILL_CONTENT_FILENAME.toLowerCase()
    )
        return true
    return false
}

export const parseSkillArchive = (
    data: Buffer,
    filename: string
): SkillBundleInput => {
    let entries: Record<string, Uint8Array>
    try {
        entries = unzipSync(new Uint8Array(data), {
            filter: (file) =>
                !file.name.endsWith('/') &&
                file.originalSize <= MAX_LIBRARY_SKILL_FILE_BYTES
        })
    } catch {
        throw new BadRequestException('invalid .skill/.zip archive')
    }
    const rawPaths = Object.keys(entries)
    for (const path of rawPaths) {
        if (
            path.startsWith('/') ||
            path.includes('\\') ||
            path.split('/').includes('..')
        )
            throw new BadRequestException(
                `archive contains an unsafe path: ${path}`
            )
    }
    const root = shallowestSkillMdRoot(
        rawPaths.filter((path) => !shouldIgnoreArchiveContainer(path))
    )
    if (root === null)
        throw new BadRequestException(
            `archive does not contain a ${SKILL_CONTENT_FILENAME} (files over ${MAX_LIBRARY_SKILL_FILE_BYTES} bytes are ignored)`
        )
    const rootPrefix = root === '' ? '' : `${root}/`
    let total = 0
    let content: string | null = null
    const files: SkillFileInput[] = []
    for (const [rawPath, bytes] of Object.entries(entries)) {
        if (!rawPath.startsWith(rootPrefix)) continue
        const path = rawPath.slice(rootPrefix.length)
        if (!path) continue
        const buf = Buffer.from(bytes)
        if (path === SKILL_CONTENT_FILENAME) {
            if (looksBinary(buf))
                throw new BadRequestException(
                    `${SKILL_CONTENT_FILENAME} is not a text file`
                )
            total += buf.length
            content = sanitizePgText(buf.toString('utf8'))
            continue
        }
        if (shouldIgnoreImportPath(path)) continue
        if (looksBinary(buf)) continue
        total += buf.length
        if (total > MAX_LIBRARY_SKILL_TOTAL_BYTES)
            throw new PayloadTooLargeException(
                `skill exceeds ${MAX_LIBRARY_SKILL_TOTAL_BYTES} bytes in total`
            )
        files.push({
            path: assertLibraryPathOrBadRequest(path),
            content: sanitizePgText(buf.toString('utf8'))
        })
    }
    if (content === null)
        throw new BadRequestException(
            `archive does not contain a ${SKILL_CONTENT_FILENAME} (files over ${MAX_LIBRARY_SKILL_FILE_BYTES} bytes are ignored)`
        )
    if (files.length > MAX_LIBRARY_SKILL_FILE_COUNT)
        throw new BadRequestException(
            `skill has too many files (max ${MAX_LIBRARY_SKILL_FILE_COUNT})`
        )
    const parsed = parseSkillMarkdown(content)
    const fallbackName =
        (root !== '' ? root.split('/').pop() : null) ??
        filename.replace(/\.(skill|zip)$/i, '')
    const name = normalizeSkillName(parsed.name ?? fallbackName)
    return {
        name,
        description: parsed.description,
        content: ensureSkillFrontmatter(content, name, parsed.description),
        files,
        origin: { type: 'archive', filename }
    }
}

// macOS zips bury a mirrored tree under __MACOSX/ — exclude it (and dot
// containers) from rooting so the real SKILL.md wins.
const shouldIgnoreArchiveContainer = (path: string): boolean =>
    path
        .split('/')
        .some(
            (segment) => segment === '__MACOSX' || segment.startsWith('.')
        )

const GITHUB_URL_RE =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?$/
const BARE_REPO_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/

export const parseImportUrl = (url: string): GitHubSkillSource => {
    const trimmed = url.trim()
    if (trimmed.startsWith('github:')) {
        const parsed = parseGitHubGrammar(trimmed)
        if (parsed) return parsed
        throw new BadRequestException(`invalid skill id: ${trimmed}`)
    }
    const bare = BARE_REPO_RE.exec(trimmed)
    if (bare)
        return {
            owner: bare[1],
            repo: bare[2],
            ref: null,
            path: '.',
            url: `https://github.com/${bare[1]}/${bare[2]}`
        }
    const match = GITHUB_URL_RE.exec(trimmed)
    if (!match)
        throw new BadRequestException(
            'unsupported import URL; use a github.com repo, tree, or SKILL.md blob URL'
        )
    const [, owner, repo, kind, ref, rest] = match
    if (!kind) return { owner, repo, ref: null, path: '.', url: trimmed }
    const cleanRest = (rest ?? '').replace(/\/+$/, '')
    if (kind === 'tree')
        return { owner, repo, ref, path: cleanRest || '.', url: trimmed }
    if (!cleanRest.endsWith(SKILL_CONTENT_FILENAME))
        throw new BadRequestException(
            `blob import URLs must point at a ${SKILL_CONTENT_FILENAME}`
        )
    const dir = cleanRest
        .slice(0, -SKILL_CONTENT_FILENAME.length)
        .replace(/\/+$/, '')
    return { owner, repo, ref, path: dir || '.', url: trimmed }
}

const parseGitHubGrammar = (value: string): GitHubSkillSource | null => {
    try {
        const parsed = parseSkillId(value)
        return {
            owner: parsed.owner,
            repo: parsed.repo,
            ref: parsed.branch,
            path: parsed.sourcePath,
            url: `https://github.com/${parsed.owner}/${parsed.repo}/tree/${parsed.branch}/${parsed.sourcePath === '.' ? '' : parsed.sourcePath}`
        }
    } catch {
        return null
    }
}

const catalogSource = (catalogSkillId: string): GitHubSkillSource => {
    const parsed = parseGitHubGrammar(catalogSkillId)
    if (!parsed)
        throw new BadRequestException(
            `invalid catalog skill id: ${catalogSkillId}`
        )
    return parsed
}
