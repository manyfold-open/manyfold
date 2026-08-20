import type {
    DiscoverableSkillSummary,
    SkillReadmeMeta,
    SkillRepoSummary,
    SkillSecretRequirement
} from '@manyfold/shared'
import {
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
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

@Injectable()
export class SkillDiscoveryService {
    private readonly log = new Logger(SkillDiscoveryService.name)

    constructor(
        private readonly config: ConfigService,
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

        const nested = await Promise.all(
            repos.map((repo) => this.scanRepo(repo))
        )
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

    private async scanRepo(
        repo: DiscoveryRepo
    ): Promise<{ rows: ScannedSkillSummary[]; truncated: boolean }> {
        const commit = await this.fetchJson<GitHubCommitResponse>(
            `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(
                repo.branch
            )}`
        )
        const revision = commit.sha ?? repo.branch
        const tree = await this.fetchJson<GitHubTreeResponse>(
            `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(
                revision
            )}?recursive=1`
        )
        if (!Array.isArray(tree.tree)) return { rows: [], truncated: false }
        if (tree.truncated)
            this.log.warn(
                `GitHub tree truncated for ${repo.owner}/${repo.name}@${repo.branch}`
            )
        const skillFiles = tree.tree
            .filter((entry) => entry.type === 'blob' && entry.path)
            .map((entry) => entry.path as string)
            .filter((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))

        const rows = await Promise.all(
            skillFiles.map(async (skillPath) => {
                const sourcePath =
                    skillPath === 'SKILL.md'
                        ? '.'
                        : skillPath.replace(/\/SKILL\.md$/, '')
                const id = skillIdFor({
                    owner: repo.owner,
                    repo: repo.name,
                    branch: repo.branch,
                    sourcePath
                })
                const md = await this.fetchSkillMd(repo, skillPath).catch(
                    (err: unknown) => {
                        this.log.warn(
                            `failed to fetch ${repo.owner}/${repo.name}/${skillPath}: ${(err as Error).message}`
                        )
                        return ''
                    }
                )
                const parsed = parseSkillMarkdown(md)
                const fallbackName =
                    sourcePath === '.'
                        ? repo.name
                        : (sourcePath.split('/').filter(Boolean).pop() ??
                          repo.name)
                const name = parsed.name ?? fallbackName
                return {
                    skillId: id,
                    name,
                    description: parsed.description,
                    repoOwner: repo.owner,
                    repoName: repo.name,
                    repoBranch: repo.branch,
                    sourcePath,
                    latestRevision: revision,
                    version: parsed.version,
                    readmeUrl: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.branch}/${sourcePath === '.' ? '' : sourcePath}`,
                    installDir: installDirBase(name),
                    installed: false,
                    enabled: false,
                    userSkillId: null,
                    repoId: repo.id,
                    repoReadonly: repo.readonly,
                    category: null,
                    tags: [],
                    featured: false
                } satisfies ScannedSkillSummary
            })
        )
        return { rows, truncated: tree.truncated === true }
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
        const res = await fetch(
            `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodePath(
                path
            )}?ref=${encodeURIComponent(repo.branch)}`,
            { headers: this.githubHeaders() }
        )
        if (res.status === 404) return null
        if (!res.ok) throw await githubRequestError(res)
        const content = (await res.json()) as GitHubContentResponse
        if (content.encoding !== 'base64' || !content.content)
            return Buffer.alloc(0)
        return Buffer.from(content.content.replace(/\s/g, ''), 'base64')
    }

    async fetchDefaultBranch(owner: string, name: string): Promise<string> {
        const info = await this.fetchJson<{ default_branch?: string }>(
            `https://api.github.com/repos/${owner}/${name}`
        )
        return info.default_branch ?? 'main'
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
        const commit = await this.fetchJson<GitHubCommitResponse>(
            `https://api.github.com/repos/${input.owner}/${input.name}/commits/${encodeURIComponent(
                input.ref
            )}`
        )
        const revision = commit.sha ?? input.ref
        const tree = await this.fetchJson<GitHubTreeResponse>(
            `https://api.github.com/repos/${input.owner}/${input.name}/git/trees/${encodeURIComponent(
                revision
            )}?recursive=1`
        )
        const entries = (tree.tree ?? [])
            .filter((entry) => entry.type === 'blob' && entry.path)
            .map((entry) => ({
                path: entry.path as string,
                size: entry.size ?? 0
            }))
        return { revision, entries }
    }

    private async fetchSkillMd(
        repo: DiscoveryRepo,
        path: string
    ): Promise<string> {
        return (await this.fetchRepoFile(repo, path)) ?? ''
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const res = await fetch(url, { headers: this.githubHeaders() })
        if (!res.ok) throw await githubRequestError(res)
        return (await res.json()) as T
    }

    private githubHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'netmind-cloud-agents'
        }
        const token = this.config.get<string>('GITHUB_TOKEN')?.trim()
        if (token) headers.Authorization = `Bearer ${token}`
        return headers
    }
}

const githubRequestError = async (
    res: Response
): Promise<ServiceUnavailableException> => {
    const body = await res.text().catch(() => '')
    const rateRemaining = res.headers.get('x-ratelimit-remaining')
    if (res.status === 403 && rateRemaining === '0')
        return new ServiceUnavailableException(
            'GitHub rate limit exceeded; configure GITHUB_TOKEN'
        )
    return new ServiceUnavailableException(
        `GitHub request failed ${res.status}: ${body.slice(0, 240)}`
    )
}

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
