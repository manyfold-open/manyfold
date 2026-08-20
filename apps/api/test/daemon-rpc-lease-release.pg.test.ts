import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { createDb, runtimeHosts, users, type Database } from '@manyfold/db'
import type { ConfigService } from '@nestjs/config'
import { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'

// Regression for the staging 2026-08-03 turn loss. An api instance died on an
// unhandled rejection, so `clearConnectionLease` never ran and runtime_hosts
// kept naming it as the holder of a daemon socket. The broker inbox is derived
// from the machine id, so the RESTARTED process re-subscribed to the same inbox
// and answered relayed `exec.start` pushes with `daemon … is not connected` for
// as long as the 45s lease looked fresh. Two codex turns dispatched 18s after
// the crash were lost that way.
//
// Real Postgres because the whole fix is one UPDATE's WHERE clause and its
// column selection: the FakeDb unit harness returns whatever it is told and
// structurally cannot fail on either. Both invariants below are about which
// rows and which columns the statement actually touches.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

const ME = 'instance-me'
const PEER = 'instance-peer'

interface Harness {
    db: Database
    registry: {
        releaseOwnRpcLeases(): Promise<void>
        releaseOwnRpcLease(daemonId: string): Promise<void>
    }
    ids: string[]
    addHost: (name: string, owner: string | null) => Promise<string>
    read: (id: string) => Promise<typeof runtimeHosts.$inferSelect>
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    const config = {
        get: (key: string) => (key === 'MF_API_INSTANCE_ID' ? ME : undefined)
    } as unknown as ConfigService
    const registry = new DaemonRegistryService(db, config)
    const ids: string[] = []
    return {
        db,
        registry: registry as unknown as Harness['registry'],
        ids,
        addHost: async (name: string, owner: string | null) => {
            const id = `dh_pgtest_${name}_${suffix}`
            const stamp = new Date('2026-08-03T08:24:02.000Z')
            await db.insert(runtimeHosts).values({
                id,
                userId,
                daemonUuid: `${name}-${suffix}`,
                name: `${name}-${suffix}`,
                homeDir: '/home/dev',
                status: 'active',
                lastSeenAt: stamp,
                rpcInstanceId: owner,
                rpcInbox: owner ? `inbox-${owner}` : null,
                rpcConnectedAt: owner ? stamp : null,
                rpcLastSeenAt: owner ? stamp : null
            })
            ids.push(id)
            return id
        },
        read: async (id: string) => {
            const [row] = await db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, id))
                .limit(1)
            assert.ok(row, `host ${id} vanished`)
            return row
        },
        close: async (): Promise<void> => {
            if (ids.length > 0)
                await db.delete(runtimeHosts).where(inArray(runtimeHosts.id, ids))
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

test(
    'boot disowns every rpc lease this instance left behind, and nothing else',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const mine = await h.addHost('mine', ME)
            const alsoMine = await h.addHost('alsomine', ME)
            const peers = await h.addHost('peers', PEER)
            const unowned = await h.addHost('unowned', null)

            await h.registry.releaseOwnRpcLeases()

            for (const id of [mine, alsoMine]) {
                const row = await h.read(id)
                assert.equal(row.rpcInstanceId, null, `${id} still leased`)
                assert.equal(row.rpcInbox, null, `${id} kept its inbox`)
                assert.equal(row.rpcConnectedAt, null)
                // resolveRemoteInbox gates on `rpc_last_seen_at > now - 45s`, so
                // leaving this set would keep routing pushes at us even with a
                // null inbox — the row would match and then throw `is offline`.
                assert.equal(row.rpcLastSeenAt, null, `${id} kept its lease age`)
                // The presence sweep owns liveness. Flipping these on every boot
                // would mark healthy daemons offline and stop their agents.
                assert.equal(row.status, 'active', `${id} lost its status`)
                assert.ok(row.lastSeenAt, `${id} lost its heartbeat`)
            }

            // A peer's lease is the peer's to release. Clearing it here would
            // strand a daemon that IS connected, somewhere else.
            const peerRow = await h.read(peers)
            assert.equal(peerRow.rpcInstanceId, PEER)
            assert.equal(peerRow.rpcInbox, `inbox-${PEER}`)
            assert.ok(peerRow.rpcLastSeenAt)

            const unownedRow = await h.read(unowned)
            assert.equal(unownedRow.rpcInstanceId, null)
            assert.equal(unownedRow.status, 'active')
        } finally {
            await h.close()
        }
    }
)

test(
    'the per-daemon release only touches a lease this instance holds',
    { skip: !RUN },
    async () => {
        // handleBrokerRequest calls this when a relayed push finds no local
        // socket: we are the named holder, we cannot serve it, so disown it so
        // the next resolve routes to whoever actually has the daemon. It must
        // never be able to disown a peer's lease — a request naming a daemon
        // owned elsewhere would otherwise knock out a live connection.
        const h = await buildHarness()
        try {
            const mine = await h.addHost('mine', ME)
            const peers = await h.addHost('peers', PEER)

            await h.registry.releaseOwnRpcLease(peers)
            const untouched = await h.read(peers)
            assert.equal(untouched.rpcInstanceId, PEER)
            assert.equal(untouched.rpcInbox, `inbox-${PEER}`)

            await h.registry.releaseOwnRpcLease(mine)
            const released = await h.read(mine)
            assert.equal(released.rpcInstanceId, null)
            assert.equal(released.rpcInbox, null)
            assert.equal(released.rpcLastSeenAt, null)
            assert.equal(released.status, 'active')
        } finally {
            await h.close()
        }
    }
)
