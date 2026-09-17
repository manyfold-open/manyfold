import type {
    DiscoverableSkillSummary,
    SkillReadmeMeta,
    SkillRepoSummary,
    SkillSecretRequirement
} from '@manyfold/shared'
import {
    BadRequestException,
    Injectable,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { GitHubRequestError } from '@/common/github-request-error'
import { fetchSkillSource, mapSkillRequests, SKILL_SCAN_LIMITS, withSkillRequestBudget } from './github-skill-source'
import { parse as parseYaml } from 'yaml'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import {
    DEFAULT_SKILL_REPOS,
    PLATFORM_SKILL_REPO,
    encodePath,
    installDirBase,
    parseSkillId,
    skillIdFor
} from './skill-utils'

export interface DiscoveryRepo {
    id: string
    owner: string
    name: string
    branch: string
    enabled: boolean
    readonly: boolean
    createdAt: string | null
    updatedAt: string | null
}

interface GitHubTreeEntry {
    path?: string
    type?: string
    size?: number
}

interface GitHubTreeResponse {
    sha?: string
    tree?: GitHubTreeEntry[]
    truncated?: boolean
    message?: string
}

interface GitHubCommitResponse {
    sha?: string
    message?: string
}

interface GitHubContentResponse {
    content?: string
    encoding?: string
    message?: string
}

interface ParsedSkillMd {
    name: string | null
    description: string | null
    version: string | null
    author: string | null
    license: string | null
    platforms: string[]
    secrets: SkillSecretRequirement[]
    body: string
}

// Scan output carries no DB-backed fields (updatedAt, installCount) — those
// only exist once a row is persisted. Keeping the scan type narrower than the
// wire DTO makes fabricating placeholder values a compile error instead of a
// silent habit.
export type ScannedSkillSummary = Omit<
    DiscoverableSkillSummary,
    'updatedAt' | 'installCount'
>

export interface ScanReposResult {
    rows: ScannedSkillSummary[]
    truncatedRepoIds: string[]
}

export interface SkillSnapshotEntry {
    sourcePath: string
    name: string
    description: string | null
    version: string | null
}

@Injectable()
export class SkillDiscoveryService {
    constructor(
        _config: ConfigService,
        private readonly adminSettings: AdminSettingsService
    ) {}

    async builtinRepos(): Promise<DiscoveryRepo[]> {
        const settings = await this.adminSettings.getBuiltinSkillRepos()
        const base =
            settings.repos.length > 0
                ? settings.repos
                : DEFAULT_SKILL_REPOS.map((r) => ({
                      owner: r.owner,
                      name: r.name,
                      branch: r.branch,
                      enabled: true
                  }))
        // The first-party skills repo is always a builtin source — it can't be
        // removed via admin settings, since the default-installed
        // manyfold-cli-usage skill is published there.
        const hasPlatform = base.some(
            (r) =>
                r.owner === PLATFORM_SKILL_REPO.owner &&
                r.name === PLATFORM_SKILL_REPO.name
        )
        const source = hasPlatform
            ? base
            : [
                  {
                      owner: PLATFORM_SKILL_REPO.owner,
                      name: PLATFORM_SKILL_REPO.name,
                      branch: PLATFORM_SKILL_REPO.branch,
                      enabled: true
                  },
                  ...base
              ]
        return source.map((repo) => ({
            id: `builtin:${repo.owner}/${repo.name}@${repo.branch}`,
            owner: repo.owner,
            name: repo.name,
            branch: repo.branch,
            enabled: repo.enabled,
            readonly: true,
            createdAt: null,
            updatedAt: null
        }))
    }

    async scanRepos(input: {
        repos: DiscoveryRepo[]
        repoId?: string
    }): Promise<ScanReposResult> {
        const repos = input.repos.filter(
            (repo) =>
                repo.enabled && (!input.repoId || repo.id === input.repoId)
        )
        if (input.repoId && repos.length === 0)
            throw new BadRequestException(`unknown repoId: ${input.repoId}`)

        const nested = await mapSkillRequests(repos, (repo) => this.scanRepo(repo))
        const truncatedRepoIds = repos
            .filter((_, i) => nested[i].truncated)
            .map((repo) => repo.id)
        const rows = nested.flatMap((result) => result.rows)
        const deduped = new Map<string, ScannedSkillSummary>()
        for (const row of rows) deduped.set(row.skillId, row)
        return {
            rows: [...deduped.values()].sort((a, b) =>
                a.name.localeCompare(b.name)
            ),
            truncatedRepoIds
        }
    }

    async discoverOne(
        repos: DiscoveryRepo[],
        skillId: string
    ): Promise<ScannedSkillSummary | null> {
        const parsed = parseSkillId(skillId)
        const repo = repos.find(
            (r) =>
                r.enabled &&
                r.owner === parsed.owner &&
                r.name === parsed.repo &&
                r.branch === parsed.branch
        )
        if (!repo) return null
        const { rows } = await this.scanRepo(repo)
        return rows.find((row) => row.skillId === skillId) ?? null
    }

    async scanRepo(
        repo: DiscoveryRepo
    ): Promise<{ rows: ScannedSkillSummary[]; truncated: boolean }> {
        return withSkillRequestBudget(async () => {
            const revision = await this.resolveRepoRevision(repo)
            const snapshot = await this.scanRevision(repo, revision)
            return { rows: snapshotRows(repo, revision, snapshot), truncated: false }
        })
    }

    async resolveRepoRevision(repo: { owner: string; name: string; branch: string }): Promise<string> {
        const commit = await this.fetchJson<GitHubCommitResponse>(
            `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(repo.branch)}`
        )
        if (typeof commit.sha !== 'string' || !/^[0-9a-f]{40}$/.test(commit.sha))
            throw new GitHubRequestError()
        return commit.sha
    }

    async scanRevision(repo: DiscoveryRepo, revision: string): Promise<SkillSnapshotEntry[]> {
        const entries = await this.treeAtRevision(repo, revision)
        const skillFiles = entries.filter((entry) => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))
        if (skillFiles.length > SKILL_SCAN_LIMITS.files) throw new GitHubRequestError()
        const snapshot = await mapSkillRequests(skillFiles, async ({ path: skillPath, size }) => {
                if (size > SKILL_SCAN_LIMITS.fileBytes) throw new GitHubRequestError()
                const sourcePath =
                    skillPath === 'SKILL.md'
                        ? '.'
                        : skillPath.replace(/\/SKILL\.md$/, '')
                const raw = await this.fetchRepoFileRaw({ ...repo, branch: revision }, skillPath)
                if (!raw || raw.length === 0) throw new GitHubRequestError()
                const md = raw.toString('utf8')
                const parsed = parseSkillMarkdown(md)
                const fallbackName =
                    sourcePath === '.'
                        ? repo.name
                        : (sourcePath.split('/').filter(Boolean).pop() ??
                          repo.name)
                const name = parsed.name ?? fallbackName
                return {
                    name,
                    description: parsed.description,
                    sourcePath,
                    version: parsed.version
                }
        })
        if (Buffer.byteLength(JSON.stringify(snapshot)) > SKILL_SCAN_LIMITS.snapshotBytes) throw new GitHubRequestError()
        return snapshot
    }

    async fetchRepoFile(
        repo: { owner: string; name: string; branch: string },
        path: string
    ): Promise<string | null> {
        const raw = await this.fetchRepoFileRaw(repo, path)
        return raw === null ? null : raw.toString('utf8')
    }

    // Contents-API fetch returning raw bytes so callers can detect binary
    // payloads before committing to a utf8 decode. Returns an empty buffer for
    // files the API refuses to inline (>1MiB blobs come back without base64).
    async fetchRepoFileRaw(
        repo: { owner: string; name: string; branch: string },
        path: string
    ): Promise<Buffer | null> {
        if (/^[0-9a-f]{40}$/.test(repo.branch))
            return fetchSkillSource(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.branch}/${encodePath(path)}`, SKILL_SCAN_LIMITS.fileBytes, true)
        const content = await this.fetchJson<GitHubContentResponse>(
            `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(repo.branch)}`,
            true
        )
        if (content === null) return null
        if (content.encoding !== 'base64' || typeof content.content !== 'string') throw new GitHubRequestError()
        const bytes = Buffer.from(content.content.replace(/\s/g, ''), 'base64')
        if (bytes.length > SKILL_SCAN_LIMITS.fileBytes) throw new GitHubRequestError()
        return bytes
    }

    async fetchDefaultBranch(owner: string, name: string): Promise<string> {
        const info = await this.fetchJson<{ default_branch?: string }>(
            `https://api.github.com/repos/${owner}/${name}`
        )
        if (typeof info.default_branch !== 'string' || !info.default_branch) throw new GitHubRequestError()
        return info.default_branch
    }

    // Resolve a ref to its commit sha and list every blob (path + size) at
    // that revision. Used by the library import pipeline to snapshot a skill
    // directory.
    async resolveRepoTree(input: {
        owner: string
        name: string
        ref: string
    }): Promise<{
        revision: string
        entries: { path: string; size: number }[]
    }> {
        return withSkillRequestBudget(async () => {
            const revision = await this.resolveRepoRevision({ ...input, branch: input.ref })
            return { revision, entries: await this.treeAtRevision(input, revision) }
        })
    }

    private async treeAtRevision(repo: { owner: string; name: string }, revision: string): Promise<{ path: string; size: number }[]> {
        if (!/^[0-9a-f]{40}$/.test(revision)) throw new GitHubRequestError()
        const tree = await this.fetchJson<GitHubTreeResponse>(`https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${revision}?recursive=1`)
        if (!Array.isArray(tree.tree) || tree.truncated !== false) throw new GitHubRequestError()
        const entries: { path: string; size: number }[] = []
        const seen = new Set<string>()
        for (const item of tree.tree) {
            if (!item || typeof item.path !== 'string' || !['blob', 'tree', 'commit'].includes(item.type ?? '') || item.path.startsWith('/') || item.path.split('/').some((segment) => !segment || segment === '..' || segment === '.') || seen.has(item.path))
                throw new GitHubRequestError()
            seen.add(item.path)
            if (item.type !== 'blob') continue
            if (!Number.isSafeInteger(item.size) || item.size! < 0) throw new GitHubRequestError()
            entries.push({ path: item.path, size: item.size! })
        }
        return entries
    }

    private async fetchJson<T>(url: string, allowMissing?: false): Promise<T>
    private async fetchJson<T>(url: string, allowMissing: true): Promise<T | null>
    private async fetchJson<T>(url: string, allowMissing = false): Promise<T | null> {
        const bytes = await fetchSkillSource(url, SKILL_SCAN_LIMITS.treeBytes, allowMissing)
        if (bytes === null) return null
        try {
            const value = JSON.parse(bytes.toString('utf8'))
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
            return value as T
        } catch {
            throw new GitHubRequestError()
        }
    }
}

export const snapshotRows = (repo: DiscoveryRepo, revision: string, snapshot: SkillSnapshotEntry[]): ScannedSkillSummary[] => snapshot.map((item) => ({
    ...item,
    skillId: skillIdFor({ owner: repo.owner, repo: repo.name, branch: repo.branch, sourcePath: item.sourcePath }),
    repoOwner: repo.owner, repoName: repo.name, repoBranch: repo.branch,
    latestRevision: revision,
    readmeUrl: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.branch}/${item.sourcePath === '.' ? '' : item.sourcePath}`,
    installDir: installDirBase(item.name), installed: false, enabled: false,
    userSkillId: null, repoId: repo.id, repoReadonly: repo.readonly,
    category: null, tags: [], featured: false
}))

export const repoToSummary = (repo: DiscoveryRepo): SkillRepoSummary => ({
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    branch: repo.branch,
    enabled: repo.enabled,
    readonly: repo.readonly,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt
})

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim()
        ? value.trim()
        : typeof value === 'number'
          ? String(value)
          : null

const asStringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.map(asString).filter((item): item is string => item !== null)
        : []

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}

// Frontmatter authors are arbitrary third parties; a provider_url ends up as
// a clickable href in the web app, so anything but http(s) (javascript:,
// data:, custom schemes) is dropped at the parse boundary for every consumer.
const asHttpUrl = (value: unknown): string | null => {
    const str = asString(value)
    if (!str) return null
    try {
        const url = new URL(str)
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? str
            : null
    } catch {
        return null
    }
}

const parseSecrets = (parsed: Record<string, unknown>): SkillSecretRequirement[] => {
    const setup = asRecord(parsed.setup)
    const raw = setup.collect_secrets ?? parsed.collect_secrets
    if (!Array.isArray(raw)) return []
    return raw
        .map((entry): SkillSecretRequirement | null => {
            const item = asRecord(entry)
            const envVar = asString(item.env_var)
            const prompt = asString(item.prompt)
            const providerUrl = asHttpUrl(item.provider_url)
            if (!envVar && !prompt && !providerUrl) return null
            return { envVar, prompt, providerUrl }
        })
        .filter((item): item is SkillSecretRequirement => item !== null)
}

export const parseSkillMarkdown = (raw: string): ParsedSkillMd => {
    let name: string | null = null
    let description: string | null = null
    let version: string | null = null
    let author: string | null = null
    let license: string | null = null
    let platforms: string[] = []
    let secrets: SkillSecretRequirement[] = []
    const trimmed = raw.trimStart()
    // The body is derived from the same fence bounds the meta parse uses — a
    // start-anchored strip only. An m-flagged regex here once deleted whole
    // sections between two `---` thematic breaks in frontmatter-less files.
    let body = raw.trim()
    if (/^---[ \t]*\r?\n/.test(trimmed)) {
        const end = trimmed.indexOf('\n---', 3)
        if (end !== -1) {
            body = trimmed.slice(end + 4).trim()
            try {
                const parsed = parseYaml(trimmed.slice(3, end)) as Record<
                    string,
                    unknown
                >
                name = asString(parsed.name)
                description = asString(parsed.description)
                version = asString(parsed.version)
                author = asString(parsed.author)
                license = asString(parsed.license)
                platforms = asStringList(parsed.platforms)
                secrets = parseSecrets(parsed)
            } catch {}
        }
    }
    if (!name) {
        const heading = body.match(/^#\s+(.+)$/m)
        if (heading) name = heading[1].trim()
    }
    if (!description) {
        const firstParagraph = body
            .split(/\n\s*\n/)
            .map((part) => part.trim())
            .find((part) => part && !part.startsWith('#'))
        if (firstParagraph) description = firstParagraph.replace(/\s+/g, ' ')
    }
    return {
        name: name || null,
        description: description || null,
        version: version || null,
        author,
        license,
        platforms,
        secrets,
        body
    }
}

export const readmeContent = (
    raw: string
): { body: string; meta: SkillReadmeMeta } => {
    const parsed = parseSkillMarkdown(raw)
    return {
        body: parsed.body,
        meta: {
            author: parsed.author,
            license: parsed.license,
            version: parsed.version,
            platforms: parsed.platforms,
            secrets: parsed.secrets
        }
    }
}
