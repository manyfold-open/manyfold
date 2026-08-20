import { Inject, Injectable, Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { modelPriceSnapshots, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import type {
    ModelPriceSnapshotPayload,
    ModelPriceSource
} from './usage-pricing.service'

// Warm-start cache for the public pricing tables. Keeps the pricing engine free
// of Drizzle so it stays unit-testable, the same way loadPriceConfig does.
@Injectable()
export class ModelPriceSnapshotRepository {
    private readonly log = new Logger(ModelPriceSnapshotRepository.name)

    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async read(
        source: ModelPriceSource
    ): Promise<ModelPriceSnapshotPayload | null> {
        // A missing table means the migration has not run yet on this database.
        // Returning null lets the engine fall through to a live fetch instead of
        // failing every cost computation until someone migrates.
        try {
            const [row] = await this.db
                .select({
                    prices: modelPriceSnapshots.prices,
                    etag: modelPriceSnapshots.etag,
                    fetchedAt: modelPriceSnapshots.fetchedAt
                })
                .from(modelPriceSnapshots)
                .where(eq(modelPriceSnapshots.source, source))
                .limit(1)
            if (!row) return null
            return {
                prices: row.prices,
                etag: row.etag,
                fetchedAt: row.fetchedAt
            }
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            this.log.warn(
                `model_price_snapshots is missing; ${source} pricing will be fetched live`
            )
            return null
        }
    }

    async upsert(
        source: ModelPriceSource,
        payload: ModelPriceSnapshotPayload
    ): Promise<void> {
        const entryCount = Object.keys(payload.prices).length
        try {
            await this.db
                .insert(modelPriceSnapshots)
                .values({
                    source,
                    etag: payload.etag,
                    entryCount,
                    prices: payload.prices,
                    fetchedAt: payload.fetchedAt,
                    updatedAt: new Date()
                })
                .onConflictDoUpdate({
                    target: modelPriceSnapshots.source,
                    set: {
                        etag: payload.etag,
                        entryCount,
                        prices: payload.prices,
                        fetchedAt: payload.fetchedAt,
                        updatedAt: new Date()
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
    }
}

const isMissingRelationError = (err: unknown): boolean =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '42P01'
