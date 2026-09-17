import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebSocket } from 'ws'
import { eq, sql } from 'drizzle-orm'
import { agents, runtimeHosts } from '@manyfold/db'
import {
    storageFixture as fixture,
    OLD,
    waitFor
} from './helpers/storage-fixture'

const RUN = process.env.RUN_PG_E2E === '1'

const sendOutput = (socket: WebSocket, output: string) => {
    socket.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(output)]))
    socket.send(Buffer.from([0x03, 0]))
}

test(
    'overlapping due triggers across two services admit one host measurement',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = h.service()
        const b = h.service()
        let settled = 0
        const calls = [
            a.measureHostIfDue(h.hostId),
            a.measureHostIfDue(h.hostId),
            b.measureHostIfDue(h.hostId)
        ].map((call) => call.finally(() => settled++))
        await waitFor(() => h.sockets.length + settled === 3)
        for (const socket of h.sockets) h.finish(socket)
        await Promise.all(calls)
        t.diagnostic(
            JSON.stringify({
                requests: h.sockets.length,
                peak: h.peak(),
                publications: h.events.length
            })
        )
        assert.equal(h.sockets.length, 1)
        assert.equal(h.peak(), 1)
        assert.equal(h.events.length, 1)
        const [host] = await h.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, h.hostId))
        assert.equal(host.storageBytes, 12000)
    }
)

test(
    'failed measurement preserves the previous reading and cools down another service trigger',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = h.service()
        const first = a.measureHostIfDue(h.hostId)
        await waitFor(() => h.sockets.length === 1)
        h.finish(h.sockets[0], 0, 1)
        await first
        let secondSettled = false
        const second = h
            .service()
            .measureHostIfDue(h.hostId)
            .finally(() => {
                secondSettled = true
            })
        await waitFor(() => secondSettled || h.sockets.length === 2)
        if (h.sockets[1]) h.finish(h.sockets[1], 0, 1)
        await second
        const [host] = await h.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, h.hostId))
        assert.equal(host.storageBytes, 9000)
        assert.equal(host.storageMeasuredAt?.toISOString(), OLD.toISOString())
        assert.equal(h.events.length, 0)
        t.diagnostic(
            JSON.stringify({
                requests: h.sockets.length,
                failures: h.failures.length
            })
        )
        assert.equal(h.sockets.length, 1)
        assert.equal(h.failures.length, 1)
    }
)

test(
    'a late older measurement cannot replace a newer publication',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const first = h.service().measureHostIfDue(h.hostId)
        await waitFor(() => h.sockets.length === 1)
        await h.db
            .update(runtimeHosts)
            .set({
                storageLeaseUntil: sql`clock_timestamp() - interval '1 millisecond'`
            })
            .where(eq(runtimeHosts.id, h.hostId))
        const second = h.service().measureHostIfDue(h.hostId)
        await waitFor(() => h.sockets.length === 2)
        h.finish(h.sockets[1], 22000)
        await second
        h.finish(h.sockets[0], 11000)
        await first
        const [host] = await h.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, h.hostId))
        t.diagnostic(
            JSON.stringify({
                finalBytes: host.storageBytes,
                publications: h.events.length
            })
        )
        assert.equal(host.storageBytes, 22000)
    }
)

test(
    'publication rolls back both host and agent readings on a real database failure',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const agent = await h.addAgent({
            reading: {
                storageBytes: 100,
                storageMeasuredAt: OLD,
                storageBreakdown: {
                    workspaceBytes: 100,
                    homeBytes: 0,
                    totalBytes: 100,
                    measuredVia: 'df'
                }
            }
        })
        const name = `storage_fixture_${agent.id}`
        await h.db.execute(
            sql`create function ${sql.identifier(name)}() returns trigger language plpgsql as $$ begin raise exception 'owned storage publish failure'; end $$`
        )
        await h.db.execute(
            sql`create trigger ${sql.identifier(name)} before update on agents for each row when (OLD.id = ${sql.raw(`'${agent.id}'`)}) execute function ${sql.identifier(name)}()`
        )
        try {
            const pending = h.service().measureHostIfDue(h.hostId)
            await waitFor(() => h.sockets.length === 1)
            sendOutput(
                h.sockets[0],
                '12000\n__NCA_STORAGE_SEP__\n200\n__NCA_STORAGE_SEP__\n10\n'
            )
            await pending
            const [host] = await h.db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, h.hostId))
            const [row] = await h.db
                .select()
                .from(agents)
                .where(eq(agents.id, agent.id))
            assert.equal(host.storageBytes, 9000)
            assert.equal(
                host.storageMeasuredAt?.toISOString(),
                OLD.toISOString()
            )
            assert.equal(row.storageBytes, 100)
            assert.equal(
                row.storageMeasuredAt?.toISOString(),
                OLD.toISOString()
            )
            assert.equal(host.storageFailureCount, 1)
            assert.equal(host.storageAttemptId, null)
            assert.equal(h.events.length, 0)
        } finally {
            await h.db.execute(
                sql`drop trigger ${sql.identifier(name)} on agents`
            )
            await h.db.execute(sql`drop function ${sql.identifier(name)}()`)
        }
    }
)

test(
    'repeated failures have capped persistent cooldown and sampled error capture',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        for (const [index, maximum] of [
            30000, 60000, 120000, 240000, 300000
        ].entries()) {
            await h.db
                .update(runtimeHosts)
                .set({
                    storageRetryAt: sql`clock_timestamp() - interval '1 second'`
                })
                .where(eq(runtimeHosts.id, h.hostId))
            const pending = h.service().measureHostIfDue(h.hostId)
            await waitFor(() => h.sockets.length === index + 1)
            h.finish(h.sockets[index], 0, 1)
            await pending
            const [state] =
                await h.client`select storage_failure_count as failures, extract(epoch from (storage_retry_at - clock_timestamp())) * 1000 as remaining from runtime_hosts where id = ${h.hostId}`
            assert.equal(state.failures, index + 1)
            assert(
                Number(state.remaining) > maximum - 5000 &&
                    Number(state.remaining) <= maximum
            )
        }
        assert.equal(
            h.failures.length,
            3,
            'capture failures 1, 2 and 4; retain every outcome event'
        )
        assert.equal(
            h.observations.filter(
                (event) => event.name === 'sprite_storage_measure_failed'
            ).length,
            5
        )
        assert.equal(
            h.observations.some(
                (event) =>
                    JSON.stringify(event).includes(h.hostId) ||
                    JSON.stringify(event).includes(h.userId)
            ),
            false
        )
    }
)

test(
    'missing workspace sections do not stamp legacy zero as newly measured; confirmed zero does',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const agent = await h.addAgent({
            reading: {
                storageBytes: 0,
                storageMeasuredAt: OLD,
                storageBreakdown: {
                    workspaceBytes: 0,
                    homeBytes: 0,
                    totalBytes: 0,
                    measuredVia: 'df'
                }
            }
        })
        for (const [index, output] of [
            '12000\n',
            '12000\n__NCA_STORAGE_SEP__\n0\n'
        ].entries()) {
            await h.db
                .update(runtimeHosts)
                .set({ storageMeasuredAt: OLD })
                .where(eq(runtimeHosts.id, h.hostId))
            const pending = h.service().measureHostIfDue(h.hostId)
            await waitFor(() => h.sockets.length === index + 1)
            sendOutput(h.sockets[index], output)
            await pending
            const [row] = await h.db
                .select()
                .from(agents)
                .where(eq(agents.id, agent.id))
            if (index === 0) {
                assert.equal(row.storageBreakdown?.formatVersion, undefined)
                assert.equal(
                    row.storageMeasuredAt?.toISOString(),
                    OLD.toISOString()
                )
            } else {
                assert.equal(row.storageBreakdown?.formatVersion, 1)
                assert.equal(row.storageBreakdown?.workspaceBytes, 0)
                assert.notEqual(
                    row.storageMeasuredAt?.toISOString(),
                    OLD.toISOString()
                )
            }
        }
    }
)

test(
    'same-framework agents retain both distinct config paths in the measurement target',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.addAgent({
            framework: 'codex',
            config: '/fixture/config-a',
            workspace: '/fixture/workspace-a'
        })
        const b = await h.addAgent({
            framework: 'codex',
            config: '/fixture/config-b',
            workspace: '/fixture/workspace-b'
        })
        const pending = h.service().measureHostIfDue(h.hostId)
        await waitFor(() => h.sockets.length === 1)
        const script = h.requests[0].searchParams.getAll('cmd')[2]
        assert(
            script.includes('/fixture/config-a') &&
                script.includes('/fixture/config-b')
        )
        const ordered = [a, b].sort((left, right) =>
            left.id.localeCompare(right.id)
        )
        const paths = [
            ...ordered.map((agent) => agent.workspacePath!),
            ...ordered.map((agent) => agent.mountPath)
        ]
        const sections = [
            '12000',
            ...paths.map(
                (path, index) =>
                    `\0__NCA_STORAGE_PATH__\0${index + 1}\0${path}\0${(index + 1) * 100}`
            )
        ]
        sendOutput(
            h.sockets[0],
            sections.join('\n__NCA_STORAGE_SEP__\n') + '\n'
        )
        await pending
        const [host] = await h.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, h.hostId))
        assert.deepEqual(
            host.storageBreakdown?.homes.map((home) => home.path).sort(),
            ['/fixture/config-a', '/fixture/config-b']
        )
        assert.deepEqual(
            host.storageBreakdown?.homes
                .map((home) => home.agentIds?.[0])
                .sort(),
            [a.id, b.id].sort()
        )
        assert.equal(
            host.storageBreakdown?.homes.find((home) =>
                home.agentIds?.includes(a.id)
            )?.path,
            a.mountPath
        )
        assert.equal(
            host.storageBreakdown?.homes.find((home) =>
                home.agentIds?.includes(b.id)
            )?.path,
            b.mountPath
        )
    }
)

test(
    'cold hosts and known-unavailable exec endpoints are never probed',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        for (const spriteStatus of ['cold', 'warm'] as const) {
            await h.db
                .update(runtimeHosts)
                .set({ spriteStatus })
                .where(eq(runtimeHosts.id, h.hostId))
            await h.service().measureHostIfDue(h.hostId, 'status_sync')
        }
        await h.db
            .update(runtimeHosts)
            .set({ spriteStatus: 'running' })
            .where(eq(runtimeHosts.id, h.hostId))
        await h.service(true).measureHostIfDue(h.hostId, 'chat')
        const [host] = await h.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, h.hostId))
        assert.equal(host.storageBytes, 9000)
        assert.equal(host.storageMeasuredAt?.toISOString(), OLD.toISOString())
        assert.equal(host.storageAttemptId, null)
        assert.equal(host.storageFailureCount, 0)
        assert.equal(h.requests.length, 0)
    }
)

for (const stage of ['pre_open', 'command'] as const)
    test(
        `the unchanged 8-second exec budget bounds a real ${stage} stall and reports its phase`,
        { skip: !RUN, timeout: 20_000 },
        async (t) => {
            const h = await fixture(t)
            h.network.stallBeforeOpen = stage === 'pre_open'
            const pending = h.service().measureHostIfDue(h.hostId, 'terminal')
            await waitFor(() => h.requests.length === 1)
            if (stage === 'command') {
                await waitFor(() => h.sockets.length === 1)
                h.sockets[0].send(
                    Buffer.concat([
                        Buffer.from([0x01]),
                        Buffer.from(
                            `__NCA_STORAGE_PHASE__ df start ${Date.now() * 1000}\n`
                        )
                    ])
                )
            }
            await pending
            const failure = h.observations.find(
                (event) => event.name === 'sprite_storage_measure_failed'
            )
            assert(failure)
            assert.equal(failure.attrs.timeoutMs, 8000)
            assert.equal(failure.attrs.failureClass, 'timeout')
            assert.equal(
                failure.attrs.phase,
                stage === 'pre_open' ? 'connect' : 'df'
            )
            assert.equal(failure.attrs.trigger, 'terminal')
            assert(Number(failure.attrs.durationMs) >= 7990)
            const [host] = await h.db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, h.hostId))
            assert.equal(host.storageBytes, 9000)
            assert.equal(
                host.storageMeasuredAt?.toISOString(),
                OLD.toISOString()
            )
            assert.equal(host.storageFailureCount, 1)
            assert.equal(host.storageAttemptId, null)
        }
    )

test(
    'slow but in-budget commands preserve separate connection and command timing',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const pending = h.service().measureHostIfDue(h.hostId, 'chat')
        await waitFor(() => h.sockets.length === 1)
        const started = Date.now() * 1000
        h.sockets[0].send(
            Buffer.concat([
                Buffer.from([0x01]),
                Buffer.from(`__NCA_STORAGE_PHASE__ df start ${started}\n`)
            ])
        )
        await new Promise((resolve) => setTimeout(resolve, 60))
        sendOutput(
            h.sockets[0],
            `12000\n__NCA_STORAGE_PHASE__ df end ${Date.now() * 1000}\n`
        )
        await pending
        const phase = h.observations.find(
            (event) =>
                event.name === 'sprite_storage_phase' &&
                event.attrs.phase === 'df'
        )
        assert(phase)
        assert(Number(phase.attrs.durationMs) >= 50)
        assert.equal(phase.attrs.count, 1)
        assert.equal(phase.attrs.outcome, 'success')
        assert(
            h.observations.some(
                (event) =>
                    event.name === 'sprite_storage_phase' &&
                    event.attrs.phase === 'connect'
            )
        )
        assert.equal(h.events.length, 1)
    }
)
