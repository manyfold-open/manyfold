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
    createDb,
    runtimeHosts,
    runtimeProviders,
    users,
    type Agent,
    type Database
} from '@manyfold/db'
import { AgentsService } from '@/modules/agents/agents.service'
import {
    seedHostDaemon,
    seedLocalHost,
    seedSpritesHost,
    seedSpritesProvider
} from './helpers/host-fixture'

// Real-Postgres proof that an agent's mf CLI version resolves for BOTH host
// shapes through the one join agents → runtime → host → host_daemons
// (ADR-0037), and that a runtime without a host degrades to "not detected".
// tsc cannot see that and a fake db cannot either — only a real row can.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const LATEST = '0.21.5'

interface Harness {
    db: Database
    service: AgentsService
    agentOn: (kind: 'daemon' | 'sandbox' | 'hostless') => Agent
    close: () => Promise<void>
}

// Only `db` and `cliVersion` are on this path; the rest of the graph would be a
// container's worth of setup to prove nothing.
const serviceFor = (db: Database): AgentsService =>
    new AgentsService(
        db,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        {
            getCachedLatest: async () => ({
                version: LATEST,
                channel: 'stable' as const
            })
        } as never
    )

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const providerId = `rtp_pgtest_${suffix}`
    const rows: Record<string, Agent> = {}

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await seedSpritesProvider(db, providerId)

    // The daemon's CLI version lives on host_daemons for every host shape:
    // a local machine's own daemon and a sandbox's runner alike.
    const seed = async (
        kind: 'daemon' | 'sandbox' | 'hostless',
        cliVersion: string | null
    ): Promise<void> => {
        const hostId = `rhs_pgtest_${kind}_${suffix}`
        const runtimeId = `art_pgtest_${kind}_${suffix}`
        const agentId = `agt_pgtest_${kind}_${suffix}`
        if (kind === 'daemon') {
            await seedLocalHost(db, { id: hostId, userId })
            await seedHostDaemon(db, { hostId, userId, cliVersion })
        }
        if (kind === 'sandbox') {
            await seedSpritesHost(db, { id: hostId, userId, providerId })
            await seedHostDaemon(db, { hostId, userId, cliVersion })
        }
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId,
            name: `pgtest-runtime-${kind}-${suffix}`,
            framework: 'claude-code',
            hostId: kind === 'hostless' ? null : hostId
        })
        const [agent] = await db
            .insert(agents)
            .values({
                id: agentId,
                userId,
                name: `pgtest-agent-${kind}`,
                framework: 'claude-code',
                runtimeId,
                internalId: `internal-${agentId}`
            })
            .returning()
        rows[kind] = agent
    }

    await seed('daemon', '0.21.0')
    await seed('sandbox', LATEST)
    await seed('hostless', null)

    return {
        db,
        service: serviceFor(db),
        agentOn: (kind) => rows[kind]!,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            await db
                .delete(runtimeHosts)
                .where(eq(runtimeHosts.userId, userId))
            await db
                .delete(runtimeProviders)
                .where(eq(runtimeProviders.id, providerId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const cliInfoFor = async (
    h: Harness,
    kind: 'daemon' | 'sandbox' | 'hostless'
): Promise<{
    installed: string | null
    latest: string | null
    updateAvailable: boolean
}> => {
    const agent = h.agentOn(kind)
    const row = (await h.service.listForUser(agent.userId)).find(
        (candidate) => candidate.agent.id === agent.id
    )
    if (!row) throw new Error(`agent ${agent.id} not listed`)
    const info = await (
        h.service as unknown as {
            cliVersionInfoFor: (row: unknown) => Promise<{
                latest: string | null
                updateAvailable: boolean
            }>
        }
    ).cliVersionInfoFor(row)
    return { installed: row.daemon?.cliVersion ?? null, ...info }
}

test(
    'an agent on your own machine reports the CLI version its daemon recorded',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const info = await cliInfoFor(h, 'daemon')
            assert.equal(info.installed, '0.21.0')
            assert.equal(info.latest, LATEST)
            assert.equal(info.updateAvailable, true)
        } finally {
            await h.close()
        }
    }
)

test(
    'an agent on a sandbox reports its host CLI version',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const info = await cliInfoFor(h, 'sandbox')
            assert.equal(info.installed, LATEST)
            assert.equal(info.updateAvailable, false)
        } finally {
            await h.close()
        }
    }
)

// A runtime with no host row at all must degrade to "not detected" rather than
// dropping the row (an inner join) or claiming an upgrade for a version nobody
// ever read.
test(
    'a runtime with no host row reads as not detected, not as out of date',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const info = await cliInfoFor(h, 'hostless')
            assert.equal(info.installed, null)
            assert.equal(info.updateAvailable, false)
        } finally {
            await h.close()
        }
    }
)
