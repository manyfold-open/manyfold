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
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { CLI_RELEASE_REPO } from '@/common/brand'
import {
    cliChannelManifestUrl,
    cliDevAllowedForDeployEnv,
    resolveMfDeployEnv
} from '@/common/deploy-env'

const CACHE_TTL_MS = 5 * 60_000
const FAILURE_CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 6_000
const MAX_VERSIONS = 30

// Below this, a release has no per-version manifest.json, so a pinned upgrade
// to it cannot be resolved by the current CLI or installer. Offering it would
// hand the user an upgrade that fails at download time.
const MANIFEST_ERA_MIN_VERSION = '0.24.0'

// Enumerates installable mf CLI versions for the update pickers. Stable versions
// come from this repository's GitHub releases (cli-v* tags), so no credentials
// are needed anywhere. The dev channel is rolling: by definition it has exactly
// one installable build, which is whatever its manifest currently names.
@Injectable()
export class CliVersionCatalogService {
    private readonly log = new Logger(CliVersionCatalogService.name)
    private cache: { value: CliVersionCatalog; expiresAt: number } | null = null

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
        const stable = atLeastMin(await this.fetchStable()).filter(
            (v) => !isCliVersionTooOld(v, MANIFEST_ERA_MIN_VERSION)
        )
        const dev = this.includeDev()
            ? atLeastMin(await this.fetchDev())
            : []
        return { stable, dev }
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
                `https://api.github.com/repos/${CLI_RELEASE_REPO}/releases?per_page=100`,
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

    // A rolling channel has exactly one installable build by definition, so
    // there is nothing to enumerate: the manifest is the list.
    private async fetchDev(): Promise<string[]> {
        return this.latestFallback('dev')
    }

    private async latestFallback(channel: MfCliChannel): Promise<string[]> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const url = cliChannelManifestUrl(channel)
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) return []
            const body = (await res.json()) as { version?: unknown }
            const version =
                typeof body.version === 'string' ? body.version.trim() : ''
            return version.length > 0 ? [version] : []
        } catch {
            return []
        } finally {
            clearTimeout(timer)
        }
    }
}
