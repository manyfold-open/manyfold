import { Global, Module, type Provider } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDb } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { BusPgService } from '@/db/bus-pg.service'
import { onDbConnectionClosed } from '@/db/connection-telemetry'
import { TelemetryService } from '@/common/telemetry/telemetry.service'

const drizzleProvider: Provider = {
    provide: DRIZZLE,
    inject: [ConfigService, { token: TelemetryService, optional: true }],
    useFactory: (config: ConfigService, telemetry?: TelemetryService) => {
        const url = config.get<string>('DATABASE_URL')
        if (!url) throw new Error('DATABASE_URL is required')
        // Pool size stays at the postgres.js default (10) unless explicitly
        // raised — bump DATABASE_POOL_MAX only after checking the server's
        // max_connections against instance count.
        const rawPoolMax = Number(config.get<string>('DATABASE_POOL_MAX'))
        const max =
            Number.isFinite(rawPoolMax) && rawPoolMax > 0
                ? Math.floor(rawPoolMax)
                : undefined
        return createDb(url, {
            max,
            applicationName: 'mf-api',
            onClose: onDbConnectionClosed(telemetry, 'app')
        })
    }
}

@Global()
@Module({
    providers: [drizzleProvider, BusPgService],
    exports: [drizzleProvider, BusPgService]
})
export class DbModule {}
