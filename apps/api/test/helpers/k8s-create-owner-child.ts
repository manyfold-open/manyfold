import 'reflect-metadata'
import 'tsconfig-paths/register'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { agentRuntimes, schema } from '@manyfold/db'
import {
    insertK8sCreateLease,
    K8sCreateOwnership,
    K8S_CREATE_INITIAL_AGENT
} from '../../src/modules/agent-runtimes/provisioning/k8s-create-ownership'

const [runtimeId, ownerId] = process.argv.slice(2)
if (!process.env.DATABASE_URL || !runtimeId || !ownerId)
    throw new Error('owned fixture arguments required')
const client = postgres(process.env.DATABASE_URL, { max: 2 })
const db = drizzle(client, { schema })
const main = async () => {
    await db.transaction(async (tx) => {
        await tx
            .update(agentRuntimes)
            .set({ status: 'pending', currentPhase: K8S_CREATE_INITIAL_AGENT })
            .where(eq(agentRuntimes.id, runtimeId))
        await insertK8sCreateLease(tx, runtimeId, ownerId)
    })
    const ownership = new K8sCreateOwnership(db, runtimeId, ownerId)
    await ownership.start()
    process.send?.('owned')
    process.on('message', () => {})
}
void main().catch(async (error: unknown) => {
    console.error(error)
    process.exitCode = 1
    await client.end({ timeout: 5 })
    process.disconnect?.()
})
