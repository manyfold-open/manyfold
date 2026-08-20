import type { MfCliChannel } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    cliCdnBaseForDeployEnv,
    cliChannelForDeployEnv,
    resolveMfDeployEnv
} from '@/common/deploy-env'

const SUCCESS_CACHE_TTL_MS = 5 * 60_000
const FAILURE_CACHE_TTL_MS = 30_000
const FETCH_TIMEOUT_MS = 5_000

export interface LatestCliVersion {
    version: string | null
    channel: MfCliChannel
}

@Injectable()
export class DaemonCliVersionService {
    private readonly log = new Logger(DaemonCliVersionService.name)
    private cache: { value: LatestCliVersion; expiresAt: number } | null = null

    constructor(private readonly config: ConfigService) {}

    async getCachedLatest(): Promise<LatestCliVersion> {
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

    private async fetchLatest(): Promise<LatestCliVersion> {
        const deployEnv = resolveMfDeployEnv(
            this.config.get<string>('MF_DEPLOY_ENV')
        )
        const channel = cliChannelForDeployEnv(deployEnv)
        const url = `${cliCdnBaseForDeployEnv(deployEnv)}/latest/version.txt`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) {
                this.log.warn(`cli latest version GET ${url} -> ${res.status}`)
                return { version: null, channel }
            }
            const version = (await res.text()).trim()
            return { version: version.length > 0 ? version : null, channel }
        } catch (err) {
            this.log.warn(
                `cli latest version fetch failed: ${(err as Error).message}`
            )
            return { version: null, channel }
        } finally {
            clearTimeout(timer)
        }
    }
}
