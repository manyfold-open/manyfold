import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    channels,
    createDb,
    plans,
    users,
    type Database
} from '@manyfold/db'
import { ForbiddenException } from '@nestjs/common'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import { FIXTURE } from './helpers/fixture-framework'
import { SandboxActiveDurationService } from '../src/modules/agents/sandbox-active-duration/sandbox-active-duration.service'

// Real-Postgres proof that a managed mirror (channels.origin set, ADR-0034)
// takes no channel slot, in the reservation and in the usage the web shows;
// the fake-db unit test only mirrors the filter.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/channel-slot-mirrors.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const makeService = (db: Database): RuntimeAccessService =>
    new RuntimeAccessService(
        db as never,
        {
            getCachedSpritesEffectiveCap: async () => ({
                activeCap: 1_000_000,
                softThresholdPct: 99,
                policyActiveCap: 1_000_000,
                vendorRunningLimit: null,
                clamped: false
            }),
            isFeatureEnabled: async () => true
        } as never,
        { event: () => {}, error: () => {} } as never,
        new SandboxActiveDurationService(db) as never
    )

test(
    'a managed mirror takes no channel slot; a channel of the user does',
    { skip: !RUN },
    async (t) => {
        const url = process.env.DATABASE_URL
        if (!url) throw new Error('DATABASE_URL must be set in .env')
        const db = createDb(url)
        const suffix = randomBytes(8).toString('hex')
        const userId = `user_pgtest_${suffix}`
        const planId = `plan_pgtest_${suffix}`
        const runtimeId = `rt_pgtest_${suffix}`
        const agentId = `agt_pgtest_${suffix}`
        t.after(async () => {
            // agent_runtimes, agents and channels cascade on user delete.
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(plans).where(eq(plans.id, planId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        })

        await db.insert(plans).values({
            id: planId,
            name: `pgtest-${suffix}`,
            maxAgentsProvisioned: 5,
            maxConcurrentActive: 5,
            maxStorageGb: 10,
            monthlyActiveHoursIncluded: 1,
            monthlyApiRequestLimit: null,
            maxChannels: 1
        })
        await db
            .insert(users)
            .values({ id: userId, email: `${suffix}@pgtest.local`, planId })
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId,
            name: `pgtest-runtime-${suffix}`,
            framework: 'claude-code'
        })
        await db.insert(agents).values({
            id: agentId,
            userId,
            name: `pgtest-agent-${suffix}`,
            framework: 'claude-code',
            runtimeId,
            internalId: `internal-${suffix}`
        })
        const channel = (id: string, origin: { kind: string } | null) => ({
            id,
            userId,
            agentId,
            provider: 'fake' as const,
            label: `pgtest-${id}`,
            status: 'active' as const,
            configJson: {},
            origin
        })
        await db
            .insert(channels)
            .values(channel(`chn_mirror_${suffix}`, { kind: FIXTURE }))

        const service = makeService(db)
        await service.reserveChannelSlot(userId)
        assert.equal((await service.summary(userId)).channelsUsed, 0)

        await db.insert(channels).values(channel(`chn_own_${suffix}`, null))
        assert.equal((await service.summary(userId)).channelsUsed, 1)
        await assert.rejects(
            () => service.reserveChannelSlot(userId),
            (err) => {
                assert.ok(err instanceof ForbiddenException)
                const body = err.getResponse() as Record<string, unknown>
                assert.equal(body.code, 'CHANNEL_LIMIT_REACHED')
                assert.deepEqual(body.details, {
                    current: 1,
                    limit: 1,
                    planName: `pgtest-${suffix}`
                })
                return true
            }
        )
    }
)
