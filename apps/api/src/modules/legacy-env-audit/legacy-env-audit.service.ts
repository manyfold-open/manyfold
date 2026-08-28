import {
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LEGACY_CONFIG_ALIASES } from '@/common/config-alias'
import { TelemetryService } from '@/common/telemetry/telemetry.service'

export interface LegacyEnvHit {
    key: string
    canonical: string
    canonicalSet: boolean
}

// The alias layer in config-alias.ts resolves silently, so nothing ever told
// an operator they are still on a pre-rename key — and self-hosted .env files
// cannot be inventoried from here, only self-reported. One warn per set alias
// at startup (plus a telemetry event) turns the removal gate from "cannot
// know" into "zero hits over an observation window". Key names only, never
// values: the values are internal hostnames and URLs.
@Injectable()
export class LegacyEnvAuditService implements OnApplicationBootstrap {
    private readonly log = new Logger(LegacyEnvAuditService.name)

    constructor(
        private readonly config: ConfigService,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    onApplicationBootstrap(): void {
        for (const hit of this.scan()) {
            this.log.warn(
                hit.canonicalSet
                    ? `legacy env ${hit.key} is set but shadowed by ${hit.canonical} — delete it`
                    : `legacy env ${hit.key} is set — rename it to ${hit.canonical}; support for the old name will be removed`
            )
            this.telemetry?.event('config.legacy_env.in_use', {
                key: hit.key,
                canonical: hit.canonical,
                canonicalSet: hit.canonicalSet
            })
        }
    }

    scan(): LegacyEnvHit[] {
        const hits: LegacyEnvHit[] = []
        for (const { canonical, aliases } of LEGACY_CONFIG_ALIASES) {
            const canonicalSet = Boolean(
                this.config.get<string>(canonical)?.trim()
            )
            for (const alias of aliases) {
                if (this.config.get<string>(alias)?.trim())
                    hits.push({ key: alias, canonical, canonicalSet })
            }
        }
        return hits
    }
}
