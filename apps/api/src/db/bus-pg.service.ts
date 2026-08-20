import { Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import postgres from 'postgres'

// Dedicated small client for the LISTEN/NOTIFY buses (chat stream,
// sprite status). Bus signaling must not queue behind app-query pool
// exhaustion — a burst of stream-event inserts would otherwise delay
// cross-instance wakeups — and its LISTEN connection stays isolated from
// the main pool. Mirrors the daemon RPC broker's own postgres client.
@Injectable()
export class BusPgService implements OnApplicationShutdown {
    readonly client: ReturnType<typeof postgres> | null

    constructor(config: ConfigService) {
        const url = config.get<string>('DATABASE_URL')
        this.client = url
            ? postgres(url, {
                  max: 2,
                  prepare: false,
                  connection: { application_name: 'mf-api-bus' }
              })
            : null
    }

    async onApplicationShutdown(): Promise<void> {
        await this.client?.end({ timeout: 5 }).catch(() => undefined)
    }
}
