import { Global, Module, type Provider } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDb } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { BusPgService } from '@/db/bus-pg.service'

const drizzleProvider: Provider = {
    provide: DRIZZLE,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
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
        return createDb(url, { max, applicationName: 'mf-api' })
    }
}

@Global()
@Module({
    providers: [drizzleProvider, BusPgService],
    exports: [drizzleProvider, BusPgService]
})
export class DbModule {}
