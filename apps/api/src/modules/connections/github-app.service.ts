import type { GithubConnectionReposResponse } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { configString } from '@/common/config-alias'
import {
    GITHUB_API_BASE,
    buildGithubAppJwt,
    githubApiHeaders,
    normalizeGithubPrivateKey
} from '@/modules/connections/github-app-jwt'

const GH_API = GITHUB_API_BASE
const TOKEN_REFRESH_SKEW_MS = 60_000
const REPOS_PER_PAGE = 100
const REPOS_MAX_PAGES = 3

export interface GithubInstallation {
    accountLogin: string
    accountType: string
    repositorySelection: string
}

interface GithubRepoPayload {
    name?: string
    full_name?: string
    private?: boolean
    html_url?: string
    default_branch?: string
    pushed_at?: string | null
}

interface CachedToken {
    token: string
    expiresAtMs: number
}

@Injectable()
export class GithubAppService {
    private readonly tokenCache = new Map<string, CachedToken>()

    constructor(private readonly config: ConfigService) {}

    isConfigured(): boolean {
        return Boolean(this.appId() && this.slug() && this.privateKeyPem())
    }

    buildInstallUrl(state: string): string {
        const slug = this.slug()
        if (!slug) throw new Error('GITHUB_APP_SLUG is not configured')
        return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(
            state
        )}`
    }

    async fetchInstallation(
        installationId: string
    ): Promise<GithubInstallation> {
        const res = await fetch(
            `${GH_API}/app/installations/${encodeURIComponent(installationId)}`,
            {
                headers: this.headers(this.appJwt()),
                signal: AbortSignal.timeout(15_000)
            }
        )
        if (!res.ok)
            throw new Error(`github installation lookup failed: ${res.status}`)
        const body = (await res.json()) as {
            account?: { login?: string; type?: string }
            repository_selection?: string
        }
        return {
            accountLogin: body.account?.login ?? 'github',
            accountType: body.account?.type ?? 'User',
            repositorySelection: body.repository_selection ?? 'selected'
        }
    }

    async mintInstallationToken(installationId: string): Promise<string> {
        const now = Date.now()
        const cached = this.tokenCache.get(installationId)
        if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now)
            return cached.token
        const res = await fetch(
            `${GH_API}/app/installations/${encodeURIComponent(
                installationId
            )}/access_tokens`,
            {
                method: 'POST',
                headers: this.headers(this.appJwt()),
                signal: AbortSignal.timeout(15_000)
            }
        )
        const body = (await res.json().catch(() => ({}))) as {
            token?: string
            expires_at?: string
        }
        if (!res.ok || !body.token)
            throw new Error(
                `github installation token mint failed: ${res.status}`
            )
        const expiresAtMs = body.expires_at
            ? new Date(body.expires_at).getTime()
            : now + 3_600_000
        this.tokenCache.set(installationId, { token: body.token, expiresAtMs })
        return body.token
    }

    // The repos the installation grants access to, via the minted installation
    // token (the app JWT itself cannot list them). Capped at 3 pages / 300
    // repos; totalCount is GitHub's real total so the UI can say "300 of N".
    async listInstallationRepos(
        installationId: string
    ): Promise<Omit<GithubConnectionReposResponse, 'repositorySelection'>> {
        const token = await this.mintInstallationToken(installationId)
        const repos: GithubConnectionReposResponse['repos'] = []
        let totalCount = 0
        for (let page = 1; page <= REPOS_MAX_PAGES; page += 1) {
            const res = await fetch(
                `${GH_API}/installation/repositories?per_page=${REPOS_PER_PAGE}&page=${page}`,
                {
                    headers: this.headers(token),
                    signal: AbortSignal.timeout(15_000)
                }
            )
            if (!res.ok)
                throw new Error(
                    `github installation repos list failed: ${res.status}`
                )
            const body = (await res.json()) as {
                total_count?: number
                repositories?: GithubRepoPayload[]
            }
            totalCount = body.total_count ?? totalCount
            const batch = body.repositories ?? []
            for (const repo of batch) {
                if (!repo.full_name) continue
                repos.push({
                    name: repo.name ?? repo.full_name,
                    fullName: repo.full_name,
                    private: repo.private ?? false,
                    htmlUrl:
                        repo.html_url ??
                        `https://github.com/${repo.full_name}`,
                    defaultBranch: repo.default_branch ?? 'main',
                    pushedAt: repo.pushed_at ?? null
                })
            }
            if (batch.length < REPOS_PER_PAGE) break
        }
        return { totalCount, repos }
    }

    private appJwt(): string {
        const pem = this.privateKeyPem()
        const appId = this.appId()
        if (!pem || !appId) throw new Error('GitHub App is not configured')
        return buildGithubAppJwt(appId, pem)
    }

    private headers(jwt: string): Record<string, string> {
        return githubApiHeaders(jwt, 'manyfold-connections')
    }

    private appId(): string | undefined {
        return configString(this.config, ['GITHUB_APP_ID'])
    }

    private slug(): string | undefined {
        return configString(this.config, ['GITHUB_APP_SLUG'])
    }

    private privateKeyPem(): string | undefined {
        const raw = configString(this.config, ['GITHUB_APP_PRIVATE_KEY'])
        if (!raw) return undefined
        return normalizeGithubPrivateKey(raw)
    }
}
