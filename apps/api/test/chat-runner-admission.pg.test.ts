import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { DAEMON_FEATURE_EXEC_ROOTS } from '@manyfold/shared'
import { agentRuntimes, agents, createDb, hostDaemons, users } from '@manyfold/db'
import { ExecDriverFactory } from '../src/modules/chat/adapters/exec-driver-factory'
import { ChatRunnerError } from '../src/modules/chat/runner/chat-runner'
import { HostDaemonAccess } from '../src/modules/agents/adapters/host-daemon-access'
import { HostDaemonsService } from '../src/modules/hosts/host-daemons.service'
import { RuntimeContextService } from '../src/modules/hosts/runtime-context.service'
import { seedHostDaemon, seedLocalHost } from './helpers/host-fixture'

const RUN = process.env.RUN_PG_E2E === '1'

// Admission goes agent → runtime → host → host_daemons (ADR-0037): the owner
// is the agent's, presence is the daemon row's last_seen_at, and the
// capability the framework needs is what the daemon advertised.
test(
    'runner admission enforces the persisted owner, presence and capability before dispatch',
    { skip: !RUN },
    async (t) => {
        const db = createDb(process.env.DATABASE_URL!)
        const suffix = randomUUID()
        const owner = `owner_${suffix}`
        const other = `other_${suffix}`
        const hostId = `rth_${suffix}`
        const runtimeId = `art_${suffix}`
        const ownAgent = `agt_own_${suffix}`
        const otherAgent = `agt_other_${suffix}`
        t.after(async () => {
            try {
                await db.delete(users).where(inArray(users.id, [owner, other]))
            } finally {
                await (
                    db as unknown as { $client: { end(): Promise<void> } }
                ).$client.end()
            }
        })
        await db.insert(users).values([
            { id: owner, email: `${owner}@example.test` },
            { id: other, email: `${other}@example.test` }
        ])
        await seedLocalHost(db, { id: hostId, userId: owner })
        await seedHostDaemon(db, {
            hostId,
            userId: owner,
            // The turn carries its workspace roots (ADR-0038): a daemon that
            // cannot take them is refused as too old.
            clientFeatures: ['turn.hermes', DAEMON_FEATURE_EXEC_ROOTS]
        })
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId: owner,
            name: 'hermes',
            framework: 'hermes',
            hostId,
            status: 'ready'
        })
        await db.insert(agents).values([
            {
                id: ownAgent,
                userId: owner,
                name: 'own',
                framework: 'hermes',
                runtimeId,
                internalId: ownAgent,
                status: 'ready'
            },
            {
                id: otherAgent,
                userId: other,
                name: 'other',
                framework: 'hermes',
                runtimeId,
                internalId: otherAgent,
                status: 'ready'
            }
        ])
        const daemons = new HostDaemonsService(db)
        const factory = new ExecDriverFactory(
            db,
            new RuntimeContextService(db),
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            daemons,
            new HostDaemonAccess(daemons, { rpc: async () => ({}) } as never)
        )
        // Another user's agent on the same runtime is refused: the machine
        // is the runtime owner's, and an agent never inherits it.
        await assert.rejects(factory.resolveRunner(otherAgent), ChatRunnerError)
        assert.equal((await factory.resolveRunner(ownAgent)).daemonId, hostId)
        // The socket is gone: a heartbeat, however fresh, is not reachability
        // (ADR-0038).
        await db
            .update(hostDaemons)
            .set({ rpcInstanceId: null, rpcConnectionToken: null, rpcInbox: null, rpcConnectedAt: null })
            .where(eq(hostDaemons.hostId, hostId))
        await assert.rejects(factory.resolveRunner(ownAgent), (error: unknown) => {
            assert.ok(error instanceof ChatRunnerError)
            assert.equal(error.chatError.code, 'chat_runner_unavailable')
            return true
        })
        await db
            .update(hostDaemons)
            .set({
                rpcInstanceId: 'api-test',
                rpcConnectionToken: `token-${hostId}`,
                rpcInbox: `inbox-${hostId}`,
                rpcConnectedAt: new Date(),
                rpcLastSeenAt: new Date(),
                clientFeatures: []
            })
            .where(eq(hostDaemons.hostId, hostId))
        await assert.rejects(factory.resolveRunner(ownAgent), (error: unknown) => {
            assert.ok(error instanceof ChatRunnerError)
            assert.equal(error.chatError.code, 'chat_runner_upgrade_required')
            return true
        })
    }
)
