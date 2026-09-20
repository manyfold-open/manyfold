import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { createDb, runtimeHosts, users, type Agent } from '@manyfold/db'
import { ExecDriverFactory } from '../src/modules/chat/adapters/exec-driver-factory'
import { ChatRunnerError } from '../src/modules/chat/runner/chat-runner'

const RUN = process.env.RUN_PG_E2E === '1'

test(
    'runner admission enforces the persisted owner, presence and capability before dispatch',
    { skip: !RUN },
    async (t) => {
        const db = createDb(process.env.DATABASE_URL!)
        const suffix = randomUUID()
        const owner = `owner_${suffix}`
        const other = `other_${suffix}`
        const daemonId = `daemon_${suffix}`
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
        await db.insert(runtimeHosts).values({
            id: daemonId,
            userId: owner,
            kind: 'daemon',
            name: 'runner fixture',
            status: 'active',
            cliVersion: '4.1.0',
            rpcLastSeenAt: new Date(),
            clientFeatures: ['turn.hermes']
        })
        const factory = new ExecDriverFactory(
            db,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        const agent = {
            id: 'agent-fixture',
            framework: 'hermes',
            runtime: 'daemon',
            daemonId,
            userId: other
        } as Agent
        await assert.rejects(factory.resolveRunner(agent), ChatRunnerError)
        agent.userId = owner
        assert.equal((await factory.resolveRunner(agent)).daemonId, daemonId)
        await db
            .update(runtimeHosts)
            .set({ rpcLastSeenAt: new Date(0) })
            .where(eq(runtimeHosts.id, daemonId))
        await assert.rejects(factory.resolveRunner(agent), (error: unknown) => {
            assert.ok(error instanceof ChatRunnerError)
            assert.equal(error.chatError.code, 'chat_runner_unavailable')
            return true
        })
        await db
            .update(runtimeHosts)
            .set({ rpcLastSeenAt: new Date(), clientFeatures: [] })
            .where(eq(runtimeHosts.id, daemonId))
        await assert.rejects(factory.resolveRunner(agent), (error: unknown) => {
            assert.ok(error instanceof ChatRunnerError)
            assert.equal(error.chatError.code, 'chat_runner_upgrade_required')
            return true
        })
    }
)
