import {
    AgentFramework,
    FrameworkBlockedVersionRange,
    FrameworkDefaultVersionsSettings,
    FrameworkVersionCatalogEntry,
    FrameworkVersionSourceKind,
    VersionedFramework,
    blockedVersionRangesFor,
    compareSemverPrecedence,
    findBlockedVersionRange,
    frameworkPrereleaseAllowed,
    isPrereleaseVersion,
    isSemverVersionTag,
    resolveFrameworkRepo
} from '@manyfold/shared'
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { GitHubRequestError, githubResponseError } from '@/common/github-request-error'
import { eq } from 'drizzle-orm'
import { appSettings, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import {
    allFrameworkVersionDescriptors,
    frameworkVersionDescriptor,
    releaseArtifactsFrom,
    type FrameworkReleaseArtifacts,
    type FrameworkReleaseBinary,
    type FrameworkVersionDescriptor
} from '@/modules/framework-versions/framework-version-registry'
import {
    resolveFrameworkInstallVersion,
    type ResolvedInstallVersion
} from '@/modules/framework-versions/resolve-install-version'

export const FRAMEWORK_VERSIONS_CATALOG_SETTING_KEY =
    'framework_versions_catalog'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// How stale a stored `latest` may be before `latestForFresh` re-fetches that one
// framework. The catalog is otherwise only refreshed on boot and by the admin
// refresh endpoint, which would make "install latest" mean "latest as of the
// last deploy".
const LATEST_STALE_MS = 60 * 60 * 1000
const NPM_REGISTRY = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 15_000
// Cap stored versions per framework — npm packages can carry hundreds of
// historical releases; the picker only needs a reasonable recent window.
const MAX_VERSIONS = 200
// Prereleases are capped separately rather than sharing the budget above:
// claude-code and friends publish preview tags continuously, and a shared cap
// would let them evict the stable history the picker exists to show.
const MAX_PRERELEASE_VERSIONS = 50

interface StoredEntry {
    latest: string | null
    versions: string[]
    // semver prereleases, kept apart from `versions` so `latest` stays stable by
    // construction and the opt-in can be applied at read time. Absent on rows
    // written before the opt-in existed, which read as "none".
    prereleases?: string[]
    source: FrameworkVersionSourceKind
    // which repository produced these versions; absent on rows written before
    // the source became configurable, which read as the default repo
    repo?: string | null
    fetchedAt: string | null
    // per version, the Linux asset digests of a release-binary framework
    artifacts?: Record<string, FrameworkReleaseArtifacts>
}

type StoredCatalog = Partial<Record<VersionedFramework, StoredEntry>>

// One upstream fetch's result, before policy.
interface FetchedVersions {
    latest: string | null
    versions: string[]
    prereleases: string[]
    artifacts?: Record<string, FrameworkReleaseArtifacts>
}

// Pre-policy view: the DTO plus the prerelease list, which is withheld or merged
// into `versions` by withPolicy() and never leaves this service.
interface RawCatalogEntry extends FrameworkVersionCatalogEntry {
    prereleases: string[]
}

@Injectable()
export class FrameworkVersionsService implements OnModuleInit {
    private readonly log = new Logger(FrameworkVersionsService.name)
    private cache: {
        value: RawCatalogEntry[]
        expiresAt: number
    } | null = null

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly adminSettings: AdminSettingsService
    ) {}

    onModuleInit(): void {
        // Warm the catalog on boot without blocking app start.
        void this.refresh().catch((err) =>
            this.log.warn(
                `framework-versions warm refresh failed: ${(err as Error).message}`
            )
        )
    }

    async getCatalog(): Promise<FrameworkVersionCatalogEntry[]> {
        return this.withPolicy(await this.readCatalog())
    }

    async getCached(): Promise<FrameworkVersionCatalogEntry[]> {
        if (this.cache && this.cache.expiresAt > Date.now())
            return this.withPolicy(this.cache.value)
        const value = await this.readCatalog()
        this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
        return this.withPolicy(value)
    }

    // Raw upstream view, blocked releases and the repo they came from included.
    // Only withPolicy() may hand this out — the cached copy stays raw so an
    // operator adding a broken window, switching the source repo or flipping the
    // prerelease opt-in takes effect on the next read instead of waiting out a
    // 6h TTL.
    private async readCatalog(): Promise<RawCatalogEntry[]> {
        const stored = await this.read()
        return allFrameworkVersionDescriptors().map((d) => {
            const entry = stored[d.framework]
            return {
                framework: d.framework,
                latest: entry?.latest ?? null,
                versions: entry?.versions ?? [],
                prereleases: entry?.prereleases ?? [],
                source: d.source.kind,
                sourceRepo:
                    d.source.kind === 'github'
                        ? (entry?.repo ?? d.source.repo)
                        : null,
                fetchedAt: entry?.fetchedAt ?? null,
                blocked: []
            }
        })
    }

    // The single place a broken release, a stale repository or a withheld
    // prerelease is filtered: every picker, every "install latest" and every
    // upgrade target reads the catalog through here, so filtering once covers
    // them all. `latest` falls back to the newest surviving release rather than
    // going null, or a blocked dist-tag would strand fresh agents on the sprite
    // image's baked-in CLI.
    private async withPolicy(
        entries: RawCatalogEntry[]
    ): Promise<FrameworkVersionCatalogEntry[]> {
        const settings = await this.versionSettings()
        return entries.map((raw) => {
            const { prereleases, ...entry } = this.withEffectiveRepo(
                raw,
                settings
            )
            const blocked = blockedVersionRangesFor(entry.framework, settings)
            const admitted = frameworkPrereleaseAllowed(
                entry.framework,
                settings
            )
                ? [...entry.versions, ...prereleases].sort(
                      (a, b) => -(compareSemverPrecedence(a, b) ?? 0)
                  )
                : entry.versions
            if (!blocked.length) return { ...entry, versions: admitted }
            const versions = admitted.filter(
                (v) => !findBlockedVersionRange(v, blocked)
            )
            // Stays the newest surviving STABLE release: `versions` may now lead
            // with a prerelease, and `latest` drives the implicit tier every
            // fresh agent installs plus the upgrade-available nag.
            const latest = findBlockedVersionRange(entry.latest, blocked)
                ? (versions.find((v) => !isPrereleaseVersion(v)) ?? null)
                : entry.latest
            return { ...entry, latest, versions, blocked }
        })
    }

    // Tags stored from one repository say nothing about which tags another
    // serves, so a source switch empties the entry rather than serving the old
    // repo's list. `fetchedAt: null` makes latestForFresh() re-fetch on the next
    // create, and the upgrade whitelist refuses targets until it does — both
    // fail closed. Doing it here rather than at write time means every replica
    // converges on the settings cache TTL without an invalidation broadcast.
    private withEffectiveRepo(
        entry: RawCatalogEntry,
        settings: FrameworkDefaultVersionsSettings | null
    ): RawCatalogEntry {
        if (entry.source !== 'github') return entry
        const effective = resolveFrameworkRepo(entry.framework, settings)
        if (!effective || effective === entry.sourceRepo) return entry
        return {
            ...entry,
            latest: null,
            versions: [],
            prereleases: [],
            sourceRepo: effective,
            fetchedAt: null
        }
    }

    // Whole framework version settings object. Named for the read, not for one
    // caller: the blocked windows and the source repo both live here.
    private async versionSettings(): Promise<FrameworkDefaultVersionsSettings | null> {
        try {
            return await this.adminSettings.getCachedFrameworkDefaultVersions()
        } catch (err) {
            // Operator config is a bonus; the built-in blocked list and the
            // default source repo must still apply when settings are unreadable
            // (missing table on a fresh db).
            this.log.warn(
                `framework version settings unavailable, using built-ins only: ${(err as Error).message}`
            )
            return null
        }
    }

    async getForFramework(
        framework: VersionedFramework
    ): Promise<FrameworkVersionCatalogEntry> {
        const all = await this.getCached()
        const found = all.find((e) => e.framework === framework)
        if (found) return found
        return {
            framework,
            latest: null,
            versions: [],
            source: 'npm',
            sourceRepo: null,
            fetchedAt: null,
            blocked: []
        }
    }

    async blockedRangesFor(
        framework: VersionedFramework
    ): Promise<FrameworkBlockedVersionRange[]> {
        return blockedVersionRangesFor(framework, await this.versionSettings())
    }

    // Effective git source for a framework, admin override applied. The catalog
    // fetch, the fresh install and the rebuild upgrade all resolve through here,
    // so the versions on offer and the repository cloned cannot disagree.
    // Returns null for an npm-installed framework.
    async repoFor(framework: VersionedFramework): Promise<string | null> {
        return resolveFrameworkRepo(framework, await this.versionSettings())
    }

    async latestFor(framework: VersionedFramework): Promise<string | null> {
        return (await this.getForFramework(framework)).latest
    }

    // `latestFor` with a freshness guarantee, for the agent-create path: re-fetch
    // this one framework when the stored entry is missing or older than
    // LATEST_STALE_MS. Never throws — a registry outage falls back to the stored
    // value (or null), which lets the caller keep the framework's built-in
    // default rather than failing the create.
    async latestForFresh(framework: VersionedFramework): Promise<string | null> {
        const entry = await this.getForFramework(framework)
        if (!isStale(entry.fetchedAt)) return entry.latest
        try {
            const refreshed = await this.refreshFramework(framework)
            return refreshed.latest ?? entry.latest
        } catch (err) {
            this.log.warn(
                `latest refresh failed for ${framework}, using stored value: ${(err as Error).message}`
            )
            return entry.latest
        }
    }

    // Git installs admit against the complete snapshot. A refresh may succeed
    // while a source switch makes its returned entry empty; do not substitute
    // the previous repository's latest in that case.
    async catalogForFresh(
        framework: VersionedFramework
    ): Promise<FrameworkVersionCatalogEntry> {
        const entry = await this.getForFramework(framework)
        if (!isStale(entry.fetchedAt)) return entry
        try {
            return await this.refreshFramework(framework)
        } catch (err) {
            this.log.warn(
                `catalog refresh failed for ${framework}: ${(err as Error).message}`
            )
            // Re-apply current source/policy to the cache: same-source entries
            // remain usable, but an intervening source switch invalidates them.
            return this.getForFramework(framework)
        }
    }

    // The build a fresh install of `framework` gets (request > admin pin >
    // catalog latest, blocked windows applied); see resolveFrameworkInstallVersion.
    async resolveInstallVersion(
        framework: AgentFramework,
        requested?: string | null
    ): Promise<ResolvedInstallVersion> {
        return resolveFrameworkInstallVersion(
            {
                settings:
                    await this.adminSettings.getCachedFrameworkDefaultVersions(),
                latestForFresh: (fw) => this.latestForFresh(fw),
                catalogForFresh: (fw) => this.catalogForFresh(fw),
                releaseArtifacts: (fw, version) =>
                    this.releaseArtifacts(fw, version)
            },
            framework,
            requested
        )
    }

    // The digests a release-binary install checks its download against. The
    // stored catalog carries them for every version it offers; a version it
    // does not (an admin pin fetched before the release was listed) is read
    // from that one release. Throws rather than let an install go unchecked.
    async releaseArtifacts(
        framework: VersionedFramework,
        version: string
    ): Promise<FrameworkReleaseArtifacts> {
        const descriptor = frameworkVersionDescriptor(framework)
        if (!descriptor.binary || descriptor.source.kind !== 'github')
            throw new Error(`${framework} does not install release binaries`)
        const repo = (await this.repoFor(framework)) ?? descriptor.source.repo
        const stored = (await this.read())[framework]
        if ((stored?.repo ?? repo) === repo) {
            const known = stored?.artifacts?.[version]
            if (known) return known
        }
        const release = await this.githubJson<{ assets?: unknown }>(
            `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(version)}`
        )
        const artifacts = releaseArtifactsFrom(release.assets, descriptor.binary)
        if (!artifacts)
            throw new Error(
                `${framework} ${version} has no complete set of Linux release assets in ${repo}`
            )
        return artifacts
    }

    // Refresh a single framework's entry. `refresh()` fans out to every
    // descriptor (6 upstream fetches), which is too much to sit in front of an
    // agent create.
    async refreshFramework(
        framework: VersionedFramework
    ): Promise<FrameworkVersionCatalogEntry> {
        const descriptor = frameworkVersionDescriptor(framework)
        const repo = await this.repoFor(framework)
        const fetched = await this.fetchUpstream(descriptor, repo)
        if (fetched) {
            const stored = await this.read()
            stored[framework] = {
                latest: fetched.latest,
                versions: fetched.versions,
                prereleases: fetched.prereleases,
                source: descriptor.source.kind,
                repo,
                fetchedAt: new Date().toISOString(),
                ...(fetched.artifacts ? { artifacts: fetched.artifacts } : {})
            }
            await this.write(stored)
            this.cache = null
        }
        return this.getForFramework(framework)
    }

    async refresh(): Promise<FrameworkVersionCatalogEntry[]> {
        const stored = await this.read()
        const now = new Date().toISOString()
        for (const d of allFrameworkVersionDescriptors()) {
            try {
                const repo = await this.repoFor(d.framework)
                const fetched = await this.fetchUpstream(d, repo)
                if (fetched)
                    stored[d.framework] = {
                        latest: fetched.latest,
                        versions: fetched.versions,
                        prereleases: fetched.prereleases,
                        source: d.source.kind,
                        repo,
                        fetchedAt: now,
                        ...(fetched.artifacts
                            ? { artifacts: fetched.artifacts }
                            : {})
                    }
            } catch (err) {
                this.log.warn(
                    `version fetch failed for ${d.framework}: ${(err as Error).message}`
                )
            }
        }
        await this.write(stored)
        this.cache = null
        return this.getCatalog()
    }

    // Split an upstream list into stable and prerelease, each newest-first by
    // semver precedence and separately capped. `latest` is the newest STABLE
    // entry, which is what makes "the implicit install tier never drifts onto a
    // release candidate" a property of the stored data rather than of every
    // reader.
    //
    // isSemverVersionTag is stricter than the parseCliSemver check it replaces:
    // it requires all three core components, so a two-part tag like `v1.7` is no
    // longer offered. That tag could never have been installed anyway — both
    // clone builders and the npm install shell demand three — so this drops an
    // offer that was guaranteed to fail at the shell.
    private partitionVersions(names: readonly string[]): FetchedVersions {
        const valid = names.filter((name) => isSemverVersionTag(name))
        const newestFirst = (a: string, b: string): number =>
            -(compareSemverPrecedence(a, b) ?? 0)
        const versions = valid
            .filter((v) => !isPrereleaseVersion(v))
            .sort(newestFirst)
            .slice(0, MAX_VERSIONS)
        const prereleases = valid
            .filter((v) => isPrereleaseVersion(v))
            .sort(newestFirst)
            .slice(0, MAX_PRERELEASE_VERSIONS)
        return { latest: versions[0] ?? null, versions, prereleases }
    }

    private fetchUpstream(
        descriptor: FrameworkVersionDescriptor,
        repo: string | null
    ): Promise<FetchedVersions | null> {
        if (descriptor.source.kind === 'npm')
            return this.fetchNpm(descriptor.source.package)
        const effective = repo ?? descriptor.source.repo
        return descriptor.binary
            ? this.fetchGithubReleases(effective, descriptor.binary)
            : this.fetchGithub(effective)
    }

    private async fetchNpm(pkg: string): Promise<FetchedVersions | null> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const res = await fetch(
                `${NPM_REGISTRY}/${pkg.replace('/', '%2F')}`,
                {
                    headers: {
                        accept: 'application/vnd.npm.install-v1+json'
                    },
                    signal: controller.signal
                }
            )
            if (!res.ok) throw new Error(`registry responded ${res.status}`)
            const body = (await res.json()) as {
                'dist-tags'?: Record<string, string>
                versions?: Record<string, unknown>
            }
            const partitioned = this.partitionVersions(
                Object.keys(body.versions ?? {})
            )
            // The `latest` dist-tag is npm's own answer and beats "newest we
            // happened to list", but only while it is a stable release —
            // convention puts prereleases on `next`/`beta`, and a publisher who
            // breaks that must not move every fresh agent onto a preview.
            const distTag = body['dist-tags']?.latest ?? null
            const latest =
                distTag && !isPrereleaseVersion(distTag)
                    ? distTag
                    : partitioned.latest
            return { ...partitioned, latest }
        } finally {
            clearTimeout(timer)
        }
    }

    // GitHub tags drive the catalog for git-installed frameworks (hermes and
    // any rebuild-mode framework). There's no dist-tag "latest" — the newest semver
    // tag wins. hermes may have no semver tags, in which case it stays empty
    // (display shows whatever the on-sprite probe reports, e.g. a git sha).
    private async fetchGithub(repo: string): Promise<FetchedVersions | null> {
        const body = await this.githubJson<Array<{ name?: string }>>(
            `https://api.github.com/repos/${repo}/tags?per_page=100`
        )
        if (!Array.isArray(body)) throw new GitHubRequestError()
        return this.partitionVersions(
            body
                .map((tag) => tag.name)
                .filter((name): name is string => typeof name === 'string')
        )
    }

    // A release-binary framework's catalog is its published releases, not its
    // tags: a version is offered only when its Linux assets and their digests
    // are all there, since that is what an install downloads and checks.
    // Drafts are never offered; a release GitHub flags as a prerelease is
    // offered only when its tag says so too, where the opt-in can see it.
    private async fetchGithubReleases(
        repo: string,
        binary: FrameworkReleaseBinary
    ): Promise<FetchedVersions | null> {
        const body = await this.githubJson<
            Array<{
                tag_name?: unknown
                draft?: unknown
                prerelease?: unknown
                assets?: unknown
            }>
        >(`https://api.github.com/repos/${repo}/releases?per_page=100`)
        if (!Array.isArray(body)) throw new GitHubRequestError()
        const artifacts: Record<string, FrameworkReleaseArtifacts> = {}
        for (const release of body) {
            const tag = release.tag_name
            if (typeof tag !== 'string' || release.draft === true) continue
            if (release.prerelease === true && !isPrereleaseVersion(tag))
                continue
            const digests = releaseArtifactsFrom(release.assets, binary)
            if (digests) artifacts[tag] = digests
        }
        const fetched = this.partitionVersions(Object.keys(artifacts))
        const kept = new Set([...fetched.versions, ...fetched.prereleases])
        return {
            ...fetched,
            artifacts: Object.fromEntries(
                Object.entries(artifacts).filter(([tag]) => kept.has(tag))
            )
        }
    }

    private async githubJson<T>(url: string): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const headers: Record<string, string> = {
                accept: 'application/vnd.github+json',
                'user-agent': 'netmind-cloud-agents'
            }
            const token = this.config.get<string>('GITHUB_TOKEN')?.trim()
            if (token) headers.authorization = `Bearer ${token}`
            const res = await fetch(url, { headers, signal: controller.signal })
            if (!res.ok) throw await githubResponseError(res)
            return (await res.json()) as T
        } catch (error) {
            throw error instanceof GitHubRequestError ? error : new GitHubRequestError()
        } finally {
            clearTimeout(timer)
        }
    }

    private async read(): Promise<StoredCatalog> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(
                    eq(appSettings.key, FRAMEWORK_VERSIONS_CATALOG_SETTING_KEY)
                )
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        const raw = row?.valueJson?.frameworks
        if (!raw || typeof raw !== 'object') return {}
        return raw as StoredCatalog
    }

    private async write(catalog: StoredCatalog): Promise<void> {
        const now = new Date()
        const valueJson = { frameworks: catalog } as unknown as Record<
            string,
            unknown
        >
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: FRAMEWORK_VERSIONS_CATALOG_SETTING_KEY,
                    valueJson,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: { valueJson, updatedAt: now }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
    }
}

// Never fetched, or fetched long enough ago that the stored `latest` can't be
// trusted for a fresh install. An unparseable timestamp counts as stale.
const isStale = (fetchedAt: string | null): boolean => {
    if (!fetchedAt) return true
    const ts = Date.parse(fetchedAt)
    if (Number.isNaN(ts)) return true
    return Date.now() - ts > LATEST_STALE_MS
}

const isMissingRelationError = (err: unknown): boolean =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '42P01'
