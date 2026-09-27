import { Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import {
    runtimeProviders,
    type Database,
    type RuntimeProvider,
    type RuntimeProviderKind
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

@Injectable()
export class RuntimeProvidersService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async findById(id: string): Promise<RuntimeProvider | null> {
        const [row] = await this.db
            .select()
            .from(runtimeProviders)
            .where(eq(runtimeProviders.id, id))
            .limit(1)
        return row ?? null
    }

    async list(kind?: RuntimeProviderKind): Promise<RuntimeProvider[]> {
        return this.db
            .select()
            .from(runtimeProviders)
            .where(kind ? eq(runtimeProviders.kind, kind) : undefined)
    }

    async listEnabled(kind?: RuntimeProviderKind): Promise<RuntimeProvider[]> {
        return this.db
            .select()
            .from(runtimeProviders)
            .where(
                and(
                    eq(runtimeProviders.status, 'enabled'),
                    kind ? eq(runtimeProviders.kind, kind) : undefined
                )
            )
    }
}
