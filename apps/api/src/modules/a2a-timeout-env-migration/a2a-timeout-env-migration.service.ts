import { randomUUID } from 'node:crypto'
import {
    Inject,
    Injectable,
    Logger,
    type OnApplicationBootstrap
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    auditAction,
    MAX_A2A_ASYNC_TIMEOUT_SECONDS,
    MAX_A2A_BLOCKING_TIMEOUT_SECONDS,
    MIN_A2A_TURN_TIMEOUT_SECONDS
} from '@manyfold/shared'
import { appSettings, auditLogs, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    A2A_TURN_TIMEOUTS_SETTING_KEY,
    AdminSettingsService
} from '@/modules/admin-settings/admin-settings.service'

export type A2aTimeoutEnvMigrationResult =
    | {
          applied: true
          blockingTimeoutSeconds: number
          asyncTimeoutSeconds: number
          clamped: boolean
      }
    | { applied: false; reason: 'env-absent' | 'env-invalid' | 'row-exists' }

// One-shot migration of the legacy A2A_TURN_TIMEOUT_MS env var into the
// a2a_turn_timeouts admin setting, which owns turn timeouts now (the env
// fallback leg is gone from A2aService). No marker row: the settings row
// itself is the idempotency anchor — once it exists (from this migration or
// an admin save) the env value is inert either way, so onConflictDoNothing
// is the whole concurrency story. While the env var stays set, the warn on
// every boot is the retirement signal for it (legacy-inventory §4.2).
@Injectable()
export class A2aTimeoutEnvMigrationService implements OnApplicationBootstrap {
    private readonly log = new Logger(A2aTimeoutEnvMigrationService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly adminSettings: AdminSettingsService
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const raw = this.config.get<string>('A2A_TURN_TIMEOUT_MS')?.trim()
        try {
            const result = await this.run()
            if (result.applied)
                this.log.warn(
                    `migrated A2A_TURN_TIMEOUT_MS=${raw} into the a2a_turn_timeouts admin setting ` +
                        `(blocking ${result.blockingTimeoutSeconds}s / async ${result.asyncTimeoutSeconds}s` +
                        `${result.clamped ? ', clamped to the setting bounds' : ''}) — delete the env var`
                )
            else if (result.reason === 'row-exists')
                this.log.warn(
                    'A2A_TURN_TIMEOUT_MS is set but the a2a_turn_timeouts admin setting owns turn timeouts — the env var is ignored, delete it'
                )
            else if (result.reason === 'env-invalid')
                this.log.warn(
                    `A2A_TURN_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive number of milliseconds — ignored, delete the env var`
                )
        } catch (err) {
            // Never block boot: a database that is mid-migration is
            // recoverable on the next start (the env var is still set then).
            this.log.warn(
                `a2a timeout env migration failed: ${(err as Error).message}`
            )
        }
    }

    async run(): Promise<A2aTimeoutEnvMigrationResult> {
        const raw = this.config.get<string>('A2A_TURN_TIMEOUT_MS')?.trim()
        if (!raw) return { applied: false, reason: 'env-absent' }
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed <= 0)
            return { applied: false, reason: 'env-invalid' }

        // Ceil, never floor: shortening an operator-chosen timeout is worse
        // than lengthening it by under a second. The env carried one cap for
        // both modes, so both fields start from the same value; the clamp to
        // the setting bounds is a real behavior change for out-of-range
        // values, which is why `clamped` is surfaced in the log and result.
        const seconds = Math.ceil(parsed / 1000)
        const clamp = (max: number): number =>
            Math.min(Math.max(seconds, MIN_A2A_TURN_TIMEOUT_SECONDS), max)
        const target = {
            blockingTimeoutSeconds: clamp(MAX_A2A_BLOCKING_TIMEOUT_SECONDS),
            asyncTimeoutSeconds: clamp(MAX_A2A_ASYNC_TIMEOUT_SECONDS)
        }

        const result = await this.db.transaction(async (tx) => {
            const claimed = await tx
                .insert(appSettings)
                .values({
                    key: A2A_TURN_TIMEOUTS_SETTING_KEY,
                    valueJson: target
                })
                .onConflictDoNothing({ target: appSettings.key })
                .returning({ key: appSettings.key })
            if (claimed.length === 0)
                return { applied: false, reason: 'row-exists' } as const

            await tx.insert(auditLogs).values({
                id: randomUUID(),
                actorId: null,
                action: auditAction.A2A_TURN_TIMEOUTS_ENV_MIGRATED,
                subject: null,
                meta: { envMs: parsed, ...target }
            })
            return {
                applied: true,
                ...target,
                clamped:
                    target.blockingTimeoutSeconds !== seconds ||
                    target.asyncTimeoutSeconds !== seconds
            } as const
        })

        // Drop the possibly-cached null so the sweep/turn path sees the row
        // within this boot instead of after the 60s TTL. updateA2aTurnTimeouts
        // is not usable here: it would overwrite an admin's save.
        if (result.applied)
            this.adminSettings.invalidateA2aTurnTimeoutsCache()
        return result
    }
}
