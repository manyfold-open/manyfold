import {
    compareCliSemver,
    isCliVersionTooOld,
    parseCliSemver
} from '@manyfold/shared'
import type {
    CliVersionCatalog,
    MfCliChannel
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import {
    cliCdnBaseForChannel,
    cliDevAllowedForDeployEnv,
    resolveMfDeployEnv
} from '@/common/deploy-env'

const CACHE_TTL_MS = 5 * 60_000
const FAILURE_CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 6_000
const MAX_VERSIONS = 30
const GITHUB_REPO = 'protagolabs/manyfold'

// Enumerates installable mf CLI versions for the update pickers. Stable versions
// come from GitHub releases (cli-v* tags) so prod needs no extra credentials.
// Dev builds are not released on GitHub — only pushed to R2 under
// cli/staging/v*/ — so they are listed via the bucket and only in non-prod
// deploy envs. Without R2 credentials the dev list degrades to the public
// latest pointer rather than failing.
@Injectable()
export class CliVersionCatalogService {
    private readonly log = new Logger(CliVersionCatalogService.name)
    private cache: { value: CliVersionCatalog; expiresAt: number } | null = null
    private s3: S3Client | null = null

    constructor(
        private readonly config: ConfigService,
        private readonly adminSettings: AdminSettingsService
    ) {}

    async getCachedCatalog(): Promise<CliVersionCatalog> {
        if (this.cache && this.cache.expiresAt > Date.now())
            return this.cache.value
        const value = await this.build()
        const ok = value.stable.length > 0 || value.dev.length > 0
        this.cache = {
            value,
            expiresAt:
                Date.now() + (ok ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS)
        }
        return value
    }

    // Guards a user-supplied target version before it reaches a shell or the
    // daemon.update RPC: only versions we actually list are installable.
    async isInstallableVersion(version: string): Promise<boolean> {
        const catalog = await this.getCachedCatalog()
        return (
            catalog.stable.includes(version) || catalog.dev.includes(version)
        )
    }

    private includeDev(): boolean {
        return cliDevAllowedForDeployEnv(
            resolveMfDeployEnv(this.config.get<string>('MF_DEPLOY_ENV'))
        )
    }

    private async build(): Promise<CliVersionCatalog> {
        // Only offer versions at or above the admin-configured floor — older
        // builds are unsupported, so they must not be selectable for upgrade
        // (this also blocks them at isInstallableVersion below).
        const { minVersion } =
            await this.adminSettings.getCachedCliMinimumVersion()
        const atLeastMin = (versions: string[]): string[] =>
            minVersion
                ? versions.filter((v) => !isCliVersionTooOld(v, minVersion))
                : versions
        const stable = atLeastMin(await this.fetchStable())
        const dev = this.includeDev()
            ? atLeastMin(await this.fetchDev())
            : []
        // `staging` mirrors `dev` for web bundles predating the rename.
        return { stable, dev, staging: dev }
    }

    private async fetchStable(): Promise<string[]> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const headers: Record<string, string> = {
                accept: 'application/vnd.github+json',
                'user-agent': 'manyfold-api'
            }
            const token = this.config.get<string>('GITHUB_TOKEN')?.trim()
            if (token) headers.authorization = `Bearer ${token}`
            const res = await fetch(
                `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`,
                { headers, signal: controller.signal }
            )
            if (!res.ok) throw new Error(`github responded ${res.status}`)
            const body = (await res.json()) as Array<{ tag_name?: string }>
            return body
                .map((r) => r.tag_name)
                .filter(
                    (t): t is string =>
                        typeof t === 'string' && t.startsWith('cli-v')
                )
                .map((t) => t.slice('cli-v'.length))
                .filter((v) => parseCliSemver(v) !== null)
                .sort((a, b) => -(compareCliSemver(a, b) ?? 0))
                .slice(0, MAX_VERSIONS)
        } catch (err) {
            this.log.warn(
                `cli stable list fetch failed: ${(err as Error).message}`
            )
            return this.latestFallback('stable')
        } finally {
            clearTimeout(timer)
        }
    }

    private async fetchDev(): Promise<string[]> {
        const s3 = this.r2Client()
        // The bucket name is deployment config like the credentials; without
        // either, degrade to the public latest pointer the same way.
        const bucket = this.config.get<string>('R2_PUBLIC_BUCKET')?.trim()
        if (!s3 || !bucket) return this.latestFallback('dev')
        try {
            const out = await s3.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: 'cli/staging/',
                    Delimiter: '/'
                })
            )
            const versions = (out.CommonPrefixes ?? [])
                .map((p) => /^cli\/staging\/v(.+)\/$/.exec(p.Prefix ?? '')?.[1])
                .filter((v): v is string => typeof v === 'string')
                // x.y.z-<marker>.<stamp>.<sha>: lexical desc ≈ newest stamp first
                .sort((a, b) => b.localeCompare(a))
                .slice(0, MAX_VERSIONS)
            return versions
        } catch (err) {
            this.log.warn(`cli dev list (R2) failed: ${(err as Error).message}`)
            return this.latestFallback('dev')
        }
    }

    private async latestFallback(channel: MfCliChannel): Promise<string[]> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const url = `${cliCdnBaseForChannel(channel)}/latest/version.txt`
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) return []
            const version = (await res.text()).trim()
            return version.length > 0 ? [version] : []
        } catch {
            return []
        } finally {
            clearTimeout(timer)
        }
    }

    private r2Client(): S3Client | null {
        const endpoint = this.config.get<string>('R2_S3_ENDPOINT')?.trim()
        const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID')?.trim()
        const secretAccessKey = this.config
            .get<string>('R2_SECRET_ACCESS_KEY')
            ?.trim()
        if (!endpoint || !accessKeyId || !secretAccessKey) return null
        if (!this.s3)
            this.s3 = new S3Client({
                endpoint,
                region: 'auto',
                forcePathStyle: true,
                credentials: { accessKeyId, secretAccessKey }
            })
        return this.s3
    }
}
