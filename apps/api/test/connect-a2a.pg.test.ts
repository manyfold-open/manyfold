import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, eq, like } from 'drizzle-orm'
import {
    a2aConnectSessions,
    agentRuntimes,
    agents,
    apiTokens,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { A2aService } from '../src/modules/a2a/a2a.service'
import { ApiTokenService } from '../src/modules/auth/api-token.service'
import { ConnectA2aService } from '../src/modules/connect-a2a/connect-a2a.service'

// Real-Postgres proof for what the fake in connect-a2a.service.test.ts cannot
// show: ownership/exposure rejections leave nothing behind, poll's
// approved→exchanged claim serializes concurrent polls to one winner, tokens
// exist only after a successful claim, and each minted row satisfies
// isActiveExternalA2aGrant for exactly its own target.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test --test-force-exit test/connect-a2a.pg.test.ts
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const API_ORIGIN = 'https://api.pgtest.local/api'

interface Harness {
    db: Database
    connect: ConnectA2aService
    tokens: ApiTokenService
    suffix: string
    userId: string
    otherUserId: string
    exposedId: string
    unexposedId: string
    otherAgentId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const otherUserId = `user_pgtest_o_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const exposedId = `agt_pgtest_e_${suffix}`
    const unexposedId = `agt_pgtest_u_${suffix}`
    const otherAgentId = `agt_pgtest_x_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db
        .insert(users)
        .values({ id: otherUserId, email: `o-${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    await db.insert(agents).values({
        id: exposedId,
        userId,
        name: `pgtest-${exposedId}`,
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${exposedId}`,
        extras: { a2aExposure: { enabled: true } }
    })
    await db.insert(agents).values({
        id: unexposedId,
        userId,
        name: `pgtest-${unexposedId}`,
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${unexposedId}`
    })
    await db.insert(agents).values({
        id: otherAgentId,
        userId: otherUserId,
        name: `pgtest-${otherAgentId}`,
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${otherAgentId}`
    })

    const tokens = new ApiTokenService(db)
    const a2a = new A2aService(db, null as never, null as never)
    const connect = new ConnectA2aService(
        db,
        { get: () => undefined } as never,
        tokens,
        a2a
    )

    return {
        db,
        connect,
        tokens,
        suffix,
        userId,
        otherUserId,
        exposedId,
        unexposedId,
        otherAgentId,
        close: async (): Promise<void> => {
            await db
                .delete(a2aConnectSessions)
                .where(like(a2aConnectSessions.clientName, `pgtest-${suffix}%`))
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(users).where(eq(users.id, otherUserId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const exposureEnabled = async (
    db: Database,
    agentId: string
): Promise<boolean> => {
    const [row] = await db
        .select({ extras: agents.extras })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
    return Boolean(
        (row?.extras as { a2aExposure?: { enabled?: boolean } } | null)
            ?.a2aExposure?.enabled
    )
}

const grantCount = async (db: Database, userId: string): Promise<number> => {
    const rows = await db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
            and(
                eq(apiTokens.userId, userId),
                eq(apiTokens.tokenKind, 'a2a-grant')
            )
        )
    return rows.length
}

const sessionStatus = async (db: Database, id: string): Promise<string> => {
    const [row] = await db
        .select({ status: a2aConnectSessions.status })
        .from(a2aConnectSessions)
        .where(eq(a2aConnectSessions.id, id))
        .limit(1)
    return row?.status ?? 'missing'
}

void test(
    'connect flow on real Postgres: decision-only approve, single-winner poll, per-target tokens',
    { skip: RUN ? false : 'set RUN_PG_E2E=1 with a migrated DATABASE_URL' },
    async (t) => {
        const h = await buildHarness()
        t.after(() => h.close())
        const clientName = `pgtest-${h.suffix}`

        // Ownership rejection is all-or-nothing: nothing is exposed, nothing
        // is approved, nothing is minted.
        const s1 = await h.connect.start({ clientName })
        await assert.rejects(
            () =>
                h.connect.approve({
                    requestId: s1.requestId,
                    userCode: s1.userCode,
                    userId: h.userId,
                    agentIds: [h.unexposedId, h.otherAgentId],
                    enableExposure: true
                }),
            /not owned by approving user/
        )
        assert.equal(await sessionStatus(h.db, s1.requestId), 'pending')
        assert.equal(await exposureEnabled(h.db, h.unexposedId), false)
        assert.equal(await grantCount(h.db, h.userId), 0)

        // Exposure gate without the enable switch: reject, zero writes.
        await assert.rejects(
            () =>
                h.connect.approve({
                    requestId: s1.requestId,
                    userCode: s1.userCode,
                    userId: h.userId,
                    agentIds: [h.unexposedId],
                    enableExposure: false
                }),
            /agent not exposed/
        )
        assert.equal(await sessionStatus(h.db, s1.requestId), 'pending')
        assert.equal(await exposureEnabled(h.db, h.unexposedId), false)

        // Deny is observable to the polling client.
        const s2 = await h.connect.start({ clientName })
        await h.connect.deny({ requestId: s2.requestId, userCode: s2.userCode })
        assert.deepEqual(
            await h.connect.poll({ deviceCode: s2.deviceCode }, API_ORIGIN),
            { status: 'denied' }
        )

        // Concurrent polls race the approved→exchanged claim; Postgres row
        // locking must leave exactly one winner and one set of tokens.
        const s3 = await h.connect.start({ clientName })
        await h.connect.approve({
            requestId: s3.requestId,
            userCode: s3.userCode,
            userId: h.userId,
            agentIds: [h.exposedId],
            enableExposure: false
        })
        assert.equal(await grantCount(h.db, h.userId), 0)
        const raced = await Promise.all([
            h.connect.poll({ deviceCode: s3.deviceCode }, API_ORIGIN),
            h.connect.poll({ deviceCode: s3.deviceCode }, API_ORIGIN)
        ])
        assert.equal(
            raced.filter((r) => r.status === 'approved').length,
            1,
            'exactly one concurrent poll must win the claim'
        )
        assert.equal(raced.filter((r) => r.status === 'expired').length, 1)
        assert.equal(await grantCount(h.db, h.userId), 1)

        // Full multi-agent flow with exposure enablement.
        const s4 = await h.connect.start({ clientName })
        await h.connect.approve({
            requestId: s4.requestId,
            userCode: s4.userCode,
            userId: h.userId,
            agentIds: [h.exposedId, h.unexposedId],
            enableExposure: true
        })
        assert.equal(await exposureEnabled(h.db, h.unexposedId), true)
        assert.equal(
            await grantCount(h.db, h.userId),
            1,
            'approve must not mint — poll does'
        )

        const polled = await h.connect.poll(
            { deviceCode: s4.deviceCode },
            API_ORIGIN
        )
        assert.equal(polled.status, 'approved')
        if (polled.status !== 'approved') return
        assert.equal(polled.agents.length, 2)
        assert.equal(await grantCount(h.db, h.userId), 3)
        assert.equal(await sessionStatus(h.db, s4.requestId), 'exchanged')

        for (const granted of polled.agents) {
            assert.match(granted.token, /^nca_/)
            const [row] = await h.db
                .select()
                .from(apiTokens)
                .where(eq(apiTokens.agentId, granted.agentId))
                .limit(1)
            assert.ok(row)
        }

        // Each token admits exactly its own target.
        const byAgent = new Map(polled.agents.map((a) => [a.agentId, a]))
        const exposedGrant = byAgent.get(h.exposedId)
        assert.ok(exposedGrant)
        const [exposedTokenRow] = await h.db
            .select({ id: apiTokens.id })
            .from(apiTokens)
            .where(
                and(
                    eq(apiTokens.agentId, h.exposedId),
                    eq(apiTokens.tokenKind, 'a2a-grant')
                )
            )
            .limit(1)
        assert.ok(exposedTokenRow)
        assert.equal(
            await h.tokens.isActiveExternalA2aGrant(
                exposedTokenRow.id,
                h.exposedId
            ),
            true
        )
        assert.equal(
            await h.tokens.isActiveExternalA2aGrant(
                exposedTokenRow.id,
                h.unexposedId
            ),
            false,
            'a connect-minted token must not admit any other agent'
        )

        // Repeat poll after consumption: expired, no further minting.
        assert.deepEqual(
            await h.connect.poll({ deviceCode: s4.deviceCode }, API_ORIGIN),
            { status: 'expired' }
        )
        assert.equal(await grantCount(h.db, h.userId), 3)

        // Agents deleted between approve and poll are skipped.
        const s5 = await h.connect.start({ clientName })
        await h.connect.approve({
            requestId: s5.requestId,
            userCode: s5.userCode,
            userId: h.userId,
            agentIds: [h.exposedId, h.unexposedId],
            enableExposure: false
        })
        await h.db.delete(agents).where(eq(agents.id, h.unexposedId))
        const afterDelete = await h.connect.poll(
            { deviceCode: s5.deviceCode },
            API_ORIGIN
        )
        assert.equal(afterDelete.status, 'approved')
        if (afterDelete.status !== 'approved') return
        assert.equal(afterDelete.agents.length, 1)
        assert.equal(afterDelete.agents[0].agentId, h.exposedId)
    }
)
