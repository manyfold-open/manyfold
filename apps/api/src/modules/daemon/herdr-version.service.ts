import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { compareSemverPrecedence } from '@manyfold/shared'

const SUCCESS_CACHE_TTL_MS = 5 * 60_000
const FAILURE_CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 5_000
// herdr publishes one manifest for its stable channel; the install script
// reads the same file, so what it says is what an install would land on.
const DEFAULT_MANIFEST_URL = 'https://herdr.dev/latest.json'

export interface LatestHerdrVersion {
    version: string | null
}

// The newest herdr release, for the Update Center (ADR-0031): compared
// against what each daemon reports and each sandbox is probed for.
@Injectable()
export class HerdrVersionService {
    private readonly log = new Logger(HerdrVersionService.name)
    private cache: { value: LatestHerdrVersion; expiresAt: number } | null =
        null

    constructor(private readonly config: ConfigService) {}

    async getCachedLatest(): Promise<LatestHerdrVersion> {
        if (this.cache && this.cache.expiresAt > Date.now())
            return this.cache.value
        const value = await this.fetchLatest()
        this.cache = {
            value,
            expiresAt:
                Date.now() +
                (value.version ? SUCCESS_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS)
        }
        return value
    }

    // An update is offered only for a strictly newer release; an installed
    // build the manifest does not know (a preview) is left alone.
    static updateAvailable(
        installed: string | null,
        latest: string | null
    ): boolean {
        if (!installed || !latest) return false
        return (compareSemverPrecedence(latest, installed) ?? 0) > 0
    }

    private async fetchLatest(): Promise<LatestHerdrVersion> {
        const url =
            this.config.get<string>('HERDR_MANIFEST_URL') ??
            DEFAULT_MANIFEST_URL
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) {
                this.log.warn(`herdr manifest GET ${url} -> ${res.status}`)
                return { version: null }
            }
            const body = (await res.json()) as { version?: unknown }
            const version =
                typeof body.version === 'string' ? body.version.trim() : ''
            return { version: version.length > 0 ? version : null }
        } catch (err) {
            this.log.warn(
                `herdr manifest fetch failed: ${(err as Error).message}`
            )
            return { version: null }
        } finally {
            clearTimeout(timer)
        }
    }
}
