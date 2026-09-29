import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    createDb,
    runtimeHosts,
    runtimeProviders,
    users,
    type Database
} from '@manyfold/db'
import { HostsService } from '@/modules/hosts/hosts.service'
import { SpritesProvisioner } from '@/modules/agent-runtimes/provisioning/sprites-provisioner'
import { seedSpritesHost, seedSpritesProvider } from './helpers/host-fixture'

// Deleting the last agent on a sandbox runtime tears the runtime down with
// it. Seen on staging and a local stack [2026-09-28/29]: the teardown's
// emptiness guard counted the very agent being deleted, answered 409
// RUNTIME_NOT_EMPTY, and the sandbox could then not be deleted either.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=… node --import tsx --test test/sandbox-last-agent-delete.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    provisioner: SpritesProvisioner
    runtimeId: string
    hostId: string
    agentIds: string[]
    close: () => Promise<void>
}

const buildHarness = async (agentCount: number): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const providerId = `rtp_pgtest_${suffix}`
    const hostId = `sbx_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    await db.insert(users).values({ id: userId, email: `${suffix}@pgtest.local` })
    await seedSpritesProvider(db, providerId)
    await seedSpritesHost(db, { id: hostId, userId, providerId })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        framework: 'claude-code',
        name: `runtime-${suffix}`,
        status: 'ready',
        hostId
    })
    const agentIds: string[] = []
    for (let i = 0; i < agentCount; i++) {
        const id = `agt_pgtest_${suffix}_${i}`
        await db.insert(agents).values({
            id,
            internalId: `agent-${i}`,
            userId,
            name: `agent ${i}`,
            framework: 'claude-code',
            runtimeId,
            status: 'ready'
        })
        agentIds.push(id)
    }
    // Only the database, the hosts and the active-duration settle are on
    // this path for a coding runtime.
    const provisioner = new SpritesProvisioner(
        db,
        new HostsService(db),
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
        { settleHostNotRunning: async () => {} } as never
    )
    return {
        db,
        provisioner,
        runtimeId,
        hostId,
        agentIds,
        close: async () => {
            await db.delete(agents).where(eq(agents.runtimeId, runtimeId))
            await db.delete(agentRuntimes).where(eq(agentRuntimes.id, runtimeId))
            await db.delete(runtimeHosts).where(eq(runtimeHosts.id, hostId))
            await db.delete(runtimeProviders).where(eq(runtimeProviders.id, providerId))
            await db.delete(users).where(eq(users.id, userId))
            await db.$client.end({ timeout: 5 })
        }
    }
}

const runtimeRow = async (h: Harness) => {
    const [row] = await h.db
        .select()
        .from(agentRuntimes)
        .where(eq(agentRuntimes.id, h.runtimeId))
    return row
}

test('the last agent leaving takes its runtime down and keeps the sandbox', { skip: !RUN }, async () => {
    const h = await buildHarness(1)
    try {
        await h.provisioner.teardownRuntime(await runtimeRow(h), {
            leavingAgentId: h.agentIds[0]
        })

        assert.equal(await runtimeRow(h), undefined)
        const left = await h.db.select().from(agents).where(eq(agents.runtimeId, h.runtimeId))
        assert.deepEqual(left, [])
        const [host] = await h.db.select().from(runtimeHosts).where(eq(runtimeHosts.id, h.hostId))
        assert.equal(host?.status, 'ready', 'the empty sandbox stays for reuse')
        assert.ok(host?.emptiedAt, 'and its reaper clock starts')
    } finally {
        await h.close()
    }
})

test('a runtime with another ready agent is still refused', { skip: !RUN }, async () => {
    const h = await buildHarness(2)
    try {
        await assert.rejects(
            h.provisioner.teardownRuntime(await runtimeRow(h), {
                leavingAgentId: h.agentIds[0]
            }),
            ConflictException
        )
        assert.ok(await runtimeRow(h), 'nothing was removed')
    } finally {
        await h.close()
    }
})

test('a teardown with no agent leaving counts every ready agent', { skip: !RUN }, async () => {
    const h = await buildHarness(1)
    try {
        await assert.rejects(
            h.provisioner.teardownRuntime(await runtimeRow(h)),
            ConflictException
        )
    } finally {
        await h.close()
    }
})
