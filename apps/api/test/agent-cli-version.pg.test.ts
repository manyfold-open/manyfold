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
    users,
    type Agent,
    type Database
} from '@manyfold/db'
import { AgentsService } from '@/modules/agents/agents.service'

// Real-Postgres proof that an agent's mf CLI version resolves for BOTH host
// shapes. A sandbox runtime carries hostId; a daemon runtime is created with
// daemonId only (daemon-runtime-sync never writes hostId, and the 0094 backfill
// was one-time), so a join on hostId alone silently reports "not detected" for
// exactly the host where the CLI is certainly installed. tsc cannot see that and
// a fake db cannot either — only a real row can. Env-gated like the other
// *.pg.test.ts:
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
    const rows: Record<string, Agent> = {}

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })

    const seed = async (
        kind: 'daemon' | 'sandbox' | 'hostless',
        cliVersion: string | null
    ): Promise<void> => {
        const hostId = `rhs_pgtest_${kind}_${suffix}`
        const runtimeId = `art_pgtest_${kind}_${suffix}`
        const agentId = `agt_pgtest_${kind}_${suffix}`
        if (kind !== 'hostless')
            await db.insert(runtimeHosts).values({
                id: hostId,
                userId,
                name: `pgtest-host-${kind}-${suffix}`,
                kind: kind === 'daemon' ? 'daemon' : 'sandbox',
                cliVersion
            })
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId,
            name: `pgtest-runtime-${kind}-${suffix}`,
            framework: 'claude-code',
            kind: kind === 'daemon' ? 'daemon' : 'sprites',
            // This is the shape each writer actually produces: a daemon runtime
            // gets daemonId (daemon-runtime-sync), a sandbox runtime gets hostId.
            ...(kind === 'daemon' ? { daemonId: hostId } : {}),
            ...(kind === 'sandbox' ? { hostId } : {})
        })
        const [agent] = await db
            .insert(agents)
            .values({
                id: agentId,
                userId,
                name: `pgtest-agent-${kind}`,
                framework: 'claude-code',
                runtime: kind === 'daemon' ? 'daemon' : 'sprites',
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
}> =>
    (
        h.service as unknown as {
            cliVersionInfoFor: (row: Agent) => Promise<{
                installed: string | null
                latest: string | null
                updateAvailable: boolean
            }>
        }
    ).cliVersionInfoFor(h.agentOn(kind))

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
