import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { runtimeHosts, schema, users } from '@manyfold/db'
import { createObjectId, type DetectedFramework } from '@manyfold/shared'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import { CLI_AT_FLOOR } from './helpers/cli-floor'

const RUN = process.env.RUN_PG_E2E === '1'
const old = new Date('2020-01-01T00:00:00Z')

test(
    'JSONB-round-tripped heartbeat metadata converges without losing real changes',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        if (!url) throw new Error('DATABASE_URL must be set')
        const client = postgres(url, { max: 1 })
        const queries: string[] = []
        const db = drizzle(client, {
            schema,
            logger: { logQuery: (query) => queries.push(query) }
        })
        const userId = createObjectId('user')
        const hostId = createObjectId('daemonHost')
        const service = new DaemonHostService(
            db,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { get: () => undefined } as never
        )
        const detectedFrameworks: DetectedFramework[] = [
            { framework: 'codex', version: '0.1.0', path: '/fixture/codex' },
            {
                framework: 'openclaw',
                version: '1.0.0',
                path: '/fixture/openclaw',
                gateway: {
                    port: 18789,
                    reachable: null,
                    checkedAt: old.toISOString()
                }
            }
        ]
        const args = {
            daemonId: hostId,
            detectedFrameworks,
            cliVersion: CLI_AT_FLOOR,
            startupMethod: 'manual' as const,
            terminalPty: true,
            clientFeatures: ['exec.resume', 'fs.write.mode']
        }
        const onlyPresence = async (
            reported: typeof args,
            expectedUpdatedAt: Date
        ): Promise<void> => {
            queries.length = 0
            const updated = await service.heartbeat(reported)
            assert.ok(updated)
            assert.equal(
                updated.updatedAt.getTime(),
                expectedUpdatedAt.getTime()
            )
            assert.ok(updated.lastSeenAt && updated.lastSeenAt > old)
            const writes = queries.filter((q) => q.startsWith('update '))
            assert.equal(writes.length, 1)
            assert.match(
                writes[0],
                /^update "runtime_hosts" set "last_seen_at" =/
            )
            assert.ok(!writes[0].includes('"detected_frameworks" ='))
            assert.ok(!writes[0].includes('"updated_at" ='))
        }
        try {
            await db.insert(users).values({
                id: userId,
                email: `${userId}@pgtest.local`
            })
            await db.insert(runtimeHosts).values({
                id: hostId,
                userId,
                name: 'heartbeat-jsonb-fixture',
                kind: 'daemon',
                daemonUuid: randomUUID(),
                detectedFrameworks,
                cliVersion: args.cliVersion,
                startupMethod: args.startupMethod,
                terminalPty: args.terminalPty,
                clientFeatures: args.clientFeatures,
                status: 'active',
                updatedAt: old,
                lastSeenAt: old
            })
            const [stored] = await db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, hostId))
            assert.deepEqual(stored.detectedFrameworks, detectedFrameworks)
            assert.notEqual(
                JSON.stringify(stored.detectedFrameworks),
                JSON.stringify(detectedFrameworks),
                'fixture must expose PostgreSQL JSONB object-key reordering'
            )
            await onlyPresence(args, old)
            await onlyPresence(args, old)

            const versionChanged = structuredClone(args)
            versionChanged.detectedFrameworks[0].version = '0.2.0'
            const nestedChanged = structuredClone(versionChanged)
            nestedChanged.detectedFrameworks[1].gateway!.reachable = true
            const orderChanged = structuredClone(nestedChanged)
            orderChanged.detectedFrameworks.reverse()
            const featuresChanged = structuredClone(orderChanged)
            featuresChanged.clientFeatures.reverse()
            for (const [reported, column] of [
                [versionChanged, 'detected_frameworks'],
                [nestedChanged, 'detected_frameworks'],
                [orderChanged, 'detected_frameworks'],
                [featuresChanged, 'client_features']
            ] as const) {
                await db
                    .update(runtimeHosts)
                    .set({ updatedAt: old })
                    .where(eq(runtimeHosts.id, hostId))
                queries.length = 0
                const updated = await service.heartbeat(reported)
                assert.ok(updated && updated.updatedAt > old)
                assert.deepEqual(
                    updated.detectedFrameworks,
                    reported.detectedFrameworks
                )
                assert.deepEqual(
                    updated.clientFeatures,
                    reported.clientFeatures
                )
                const writes = queries.filter((q) => q.startsWith('update '))
                assert.equal(writes.length, 1)
                assert.ok(writes[0].includes(`"${column}" =`))
                assert.ok(writes[0].includes('"updated_at" ='))
                await onlyPresence(reported, updated.updatedAt)
            }
        } finally {
            await db.delete(users).where(eq(users.id, userId))
            await client.end()
        }
    }
)
