import { DEFAULT_PLAN_ID, auditAction } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    Inject,
    Injectable,
    Logger,
    type OnApplicationBootstrap
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import { appSettings, auditLogs, plans, users, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'

export const SELF_HOST_PLAN_BACKFILL_SETTING_KEY = 'self_host_plan_backfill'

export type SelfHostPlanBackfillResult =
    | { applied: true; planId: string; movedUserIds: string[] }
    | {
          applied: false
          reason: 'billing-edition' | 'no-self-host-default' | 'already-applied'
      }

// MF_DEFAULT_PLAN_ID only ever reached the users INSERT, so an account created
// before a deployment set it stayed on 'free' forever — and the open-source
// composition root has no BillingModule, so there was no route to move it
// either. This is the one-shot repair for that upgrade boundary.
@Injectable()
export class SelfHostPlanBackfillService implements OnApplicationBootstrap {
    private readonly log = new Logger(SelfHostPlanBackfillService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly capabilities: CapabilitiesRegistry
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        try {
            const result = await this.run()
            if (result.applied)
                this.log.log(
                    `moved ${result.movedUserIds.length} account(s) from '${DEFAULT_PLAN_ID}' to '${result.planId}'`
                )
            else this.log.debug(`skipped: ${result.reason}`)
        } catch (err) {
            // Never block boot: a database that is mid-migration or missing the
            // configured plan row is recoverable on the next start.
            this.log.warn(
                `self-host plan backfill failed: ${(err as Error).message}`
            )
        }
    }

    async run(): Promise<SelfHostPlanBackfillResult> {
        // Edition is read from what this composition root wired, NOT from the
        // presence of a 'self_hosted' plans row — cloud databases carry that
        // row too, so it cannot tell the two apart.
        if (this.capabilities.has('billing'))
            return { applied: false, reason: 'billing-edition' }

        const targetPlanId = this.config
            .get<string>('MF_DEFAULT_PLAN_ID')
            ?.trim()
        if (!targetPlanId || targetPlanId === DEFAULT_PLAN_ID)
            return { applied: false, reason: 'no-self-host-default' }

        return this.db.transaction(async (tx) => {
            // The marker insert IS the mutex: concurrent API replicas race on
            // the primary key and exactly one wins. Claiming inside the
            // transaction means a failure below rolls the claim back too, so a
            // half-done run never marks itself complete.
            const claimed = await tx
                .insert(appSettings)
                .values({
                    key: SELF_HOST_PLAN_BACKFILL_SETTING_KEY,
                    valueJson: { planId: targetPlanId }
                })
                .onConflictDoNothing({ target: appSettings.key })
                .returning({ key: appSettings.key })
            if (claimed.length === 0)
                return { applied: false, reason: 'already-applied' as const }

            const [plan] = await tx
                .select({ id: plans.id })
                .from(plans)
                .where(eq(plans.id, targetPlanId))
                .limit(1)
            if (!plan)
                throw new Error(
                    `MF_DEFAULT_PLAN_ID='${targetPlanId}' has no matching plans row`
                )

            const moved = await tx
                .update(users)
                .set({ planId: targetPlanId, updatedAt: new Date() })
                .where(eq(users.planId, DEFAULT_PLAN_ID))
                .returning({ id: users.id })
            const movedUserIds = moved.map((row) => row.id)

            const appliedAt = new Date()
            await tx
                .update(appSettings)
                .set({
                    valueJson: {
                        planId: targetPlanId,
                        appliedAt: appliedAt.toISOString(),
                        movedUserCount: movedUserIds.length
                    },
                    updatedAt: appliedAt
                })
                .where(eq(appSettings.key, SELF_HOST_PLAN_BACKFILL_SETTING_KEY))

            if (movedUserIds.length > 0)
                await tx.insert(auditLogs).values({
                    id: randomUUID(),
                    actorId: null,
                    action: auditAction.USER_PLAN_BACKFILLED,
                    subject: null,
                    meta: {
                        fromPlanId: DEFAULT_PLAN_ID,
                        toPlanId: targetPlanId,
                        userIds: movedUserIds
                    }
                })

            return { applied: true as const, planId: targetPlanId, movedUserIds }
        })
    }
}
