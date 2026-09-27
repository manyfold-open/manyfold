import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { hostDaemons, runtimeHosts, schema, users } from '@manyfold/db'
import { createObjectId, type DetectedFramework } from '@manyfold/shared'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import { HostsService } from '../src/modules/hosts/hosts.service'
import { HostDaemonsService } from '../src/modules/hosts/host-daemons.service'
import { CLI_AT_FLOOR } from './helpers/cli-floor'

const RUN = process.env.RUN_PG_E2E === '1'
const old = new Date('2020-01-01T00:00:00Z')

// The heartbeat's steady state is one UPDATE of host_daemons.last_seen_at
// (ADR-0037: the host row never sees a heartbeat), and a JSONB
// round-trip — which reorders object keys — must not read as a change.
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
            { get: () => undefined } as never,
            new HostsService(db),
            new HostDaemonsService(db),
            {} as never
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
                updated.daemon.updatedAt.getTime(),
                expectedUpdatedAt.getTime()
            )
            assert.ok(updated.daemon.lastSeenAt && updated.daemon.lastSeenAt > old)
            const writes = queries.filter((q) => q.startsWith('update '))
            assert.equal(writes.length, 1)
            assert.match(
                writes[0],
                /^update "host_daemons" set "last_seen_at" =/
            )
            assert.ok(!writes[0].includes('"detected_frameworks" ='))
            assert.ok(!writes[0].includes('"updated_at" ='))
            assert.ok(!queries.some((q) => q.startsWith('update "runtime_hosts"')))
        }
        try {
            await db.insert(users).values({
                id: userId,
                email: `${userId}@pgtest.local`
            })
            await db.insert(runtimeHosts).values({
                id: hostId,
                userId,
                kind: 'local',
                name: 'heartbeat-jsonb-fixture',
                status: 'ready',
                updatedAt: old
            })
            await db.insert(hostDaemons).values({
                hostId,
                userId,
                daemonUuid: randomUUID(),
                detectedFrameworks,
                cliVersion: args.cliVersion,
                startupMethod: args.startupMethod,
                terminalPty: args.terminalPty,
                clientFeatures: args.clientFeatures,
                updatedAt: old,
                lastSeenAt: old
            })
            const [stored] = await db
                .select()
                .from(hostDaemons)
                .where(eq(hostDaemons.hostId, hostId))
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
                    .update(hostDaemons)
                    .set({ updatedAt: old })
                    .where(eq(hostDaemons.hostId, hostId))
                queries.length = 0
                const updated = await service.heartbeat(reported)
                assert.ok(updated && updated.daemon.updatedAt > old)
                assert.deepEqual(
                    updated.daemon.detectedFrameworks,
                    reported.detectedFrameworks
                )
                assert.deepEqual(
                    updated.daemon.clientFeatures,
                    reported.clientFeatures
                )
                const writes = queries.filter((q) => q.startsWith('update '))
                assert.equal(writes.length, 1)
                assert.ok(writes[0].includes(`"${column}" =`))
                assert.ok(writes[0].includes('"updated_at" ='))
                await onlyPresence(reported, updated.daemon.updatedAt)
            }
        } finally {
            await db.delete(users).where(eq(users.id, userId))
            await client.end()
        }
    }
)
