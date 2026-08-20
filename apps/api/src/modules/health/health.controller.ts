import { Controller, Get, Inject } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

@Controller('health')
export class HealthController {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    @Get()
    async check(): Promise<{ status: string; db: string; version: string }> {
        let dbStatus = 'down'
        try {
            await this.db.execute(sql`select 1`)
            dbStatus = 'ok'
        } catch {}

        return {
            status: 'ok',
            db: dbStatus,
            version: process.env.npm_package_version ?? '0.0.1'
        }
    }
}
