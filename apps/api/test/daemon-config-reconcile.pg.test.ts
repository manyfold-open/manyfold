import assert from 'node:assert/strict'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
    agents,
    serviceLeases,
    runtimeHosts,
    userConnections,
    type Agent
} from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as schedule } from 'node:timers'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import {
    daemonConfigLeaseName,
    type DaemonConfigSnapshot,
    type DaemonConfigAttempt
} from '../src/modules/daemon/daemon-config-delivery.service'
import { configFixture, until } from './helpers/daemon-config-fixture'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import {
    MANYFOLD_CONTEXT_START,
    MANYFOLD_CONTEXT_END
} from '../src/modules/agent-self/agent-context-doc.service'
import { CLI_AT_FLOOR } from './helpers/cli-floor'

const RUN = process.env.RUN_PG_E2E === '1'

const blockNextHostUpdate = async (
    h: Awaited<ReturnType<typeof configFixture>>
) => {
    const name = `cfg_gate_${h.daemonId.replaceAll('_', '')}`
    const key = Math.floor(Math.random() * 2_000_000_000) + 1
    const lock = await h.db.$client.reserve()
    await lock`select pg_advisory_lock(${key})`
    await h.db.execute(sql.raw(`
        create sequence ${name};
        create function ${name}() returns trigger language plpgsql as $$
        begin
            if nextval('${name}') = 1 then
                perform pg_advisory_xact_lock(${key});
            end if;
            return null;
        end $$;
        create trigger ${name} before update on runtime_hosts
            for each statement execute function ${name}();
    `))
    let released = false
    const release = async () => {
        if (released) return
        released = true
        await lock`select pg_advisory_unlock(${key})`
        lock.release()
    }
    return {
        held: () => until(async () => {
            const rows = await h.db.execute(sql`
                select 1 from pg_locks
                where locktype = 'advisory' and objid = ${key} and not granted
            `)
            return rows.length > 0
        }),
        release,
        close: async () => {
            await release()
            await h.db.execute(sql.raw(`
                drop trigger ${name} on runtime_hosts;
                drop function ${name}();
                drop sequence ${name};
            `))
        }
    }
}

const openHelloSocket = async (url: string) => {
    const socket = new WebSocket(url, {
        headers: { authorization: 'Bearer fixture-only' }
    })
    socket.on('error', () => {})
    await once(socket, 'open')
    socket.send(JSON.stringify({
        type: 'hello',
        cliVersion: CLI_AT_FLOOR,
        clientFeatures: ['fs.write.config-commit'],
        inflightStreams: []
    }))
    return socket
}

test(
    'a delayed registration cannot replace the accepted reconnect identity',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        const registrations: Promise<void>[] = []
        const register = api.registry.register.bind(api.registry)
        t.mock.method(api.registry, 'register', (...args: Parameters<typeof register>) => {
            const pending = register(...args)
            registrations.push(pending)
            return pending
        })
        const gate = await blockNextHostUpdate(h)
        let first: WebSocket | undefined
        try {
            first = await openHelloSocket(api.url)
            await gate.held()
            const oldToken = api.registry.localConfigConnectionToken(h.daemonId)
            const connecting = h.connect(api.url)
            await until(() => api.registry.localConfigConnectionToken(h.daemonId) !== oldToken)
            // The old implementation accepts B while A's already-issued SQL
            // is blocked before its row lock. A then overwrites B's identity.
            await until(() => api.registry.currentHelloEvidence(h.daemonId) !== null, 300).catch(() => {})
            await gate.release()
            await connecting
            await Promise.all(registrations)
            const [host] = await h.db.select().from(runtimeHosts).where(eq(runtimeHosts.id, h.daemonId))
            assert.equal(host.rpcConnectionToken, api.registry.localConfigConnectionToken(h.daemonId))
            await until(async () => (await h.readAgent()).extras.contextDocDelivery?.status === 'delivered', 8000)
            assert.equal(JSON.parse(await h.readProject()).mcpServers.fixture.command, 'offline-desired')
        } finally {
            first?.terminate()
            await gate.close()
        }
    }
)

for (const remote of [false, true]) test(
    `a delayed disconnect cannot clear the ${remote ? 'peer API' : 'same API'} replacement identity or stop its agents`,
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const old = await h.api(false)
        const current = remote ? await h.api(false) : old
        const first = await openHelloSocket(old.url)
        await until(() => old.registry.currentHelloEvidence(h.daemonId) !== null)
        let cleared: Promise<void> | undefined
        const unregister = old.registry.unregister.bind(old.registry)
        t.mock.method(old.registry, 'unregister', (...args: Parameters<typeof unregister>) => {
            cleared = unregister(...args)
            return cleared
        })
        const gate = await blockNextHostUpdate(h)
        try {
            first.close()
            await gate.held()
            const connecting = h.connect(current.url)
            await until(() => current.registry.localConfigConnectionToken(h.daemonId) !== undefined)
            await until(() => current.registry.currentHelloEvidence(h.daemonId) !== null, 300).catch(() => {})
            await gate.release()
            await connecting
            await cleared
            const [host] = await h.db.select().from(runtimeHosts).where(eq(runtimeHosts.id, h.daemonId))
            assert.equal(host.rpcConnectionToken, current.registry.localConfigConnectionToken(h.daemonId))
            if (remote) assert.equal((await h.readAgent()).status, 'running')
            await current.mcp.materializeForAgent(await h.readAgent())
            assert.equal(JSON.parse(await h.readProject()).mcpServers.fixture.command, 'offline-desired')
        } finally {
            first.terminate()
            await gate.close()
        }
    }
)

test(
    'offline desired MCP and old context automatically converge after an accepted hello without stream inventory',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        const offline = await api.mcp.materializeForAgent(await h.readAgent())
        assert(offline.some((scope) => scope.status === 'failed'))
        await h.connect(api.url, false)
        let converged = false
        try {
            await until(async () => {
                const row = await h.readAgent()
                const extras = row.extras as {
                    mcpDelivery?: Record<string, { status: string }>
                    contextDoc?: { version: number }
                }
                return (
                    extras.mcpDelivery?.project?.status === 'delivered' &&
                    extras.contextDoc?.version === 1
                )
            }, 1000)
            converged = true
        } catch {}
        // The existing explicit path is the control: actual CLI RPCs write real files.
        if (!converged) {
            await api.mcp.materializeForAgent(await h.readAgent())
            await api.context.refresh(h.userId, h.agentId, false)
        }
        assert.equal(
            JSON.parse(await h.readProject()).mcpServers.fixture.command,
            'offline-desired'
        )
        t.diagnostic(
            JSON.stringify({
                automaticConvergence: converged,
                realRpcCalls: h.peerEvents.filter(
                    (event) => event.type === 'rpc'
                ).length
            })
        )
        assert.equal(converged, true)
    }
)

test(
    'hello storms coalesce and unchanged delivery performs no filesystem RPC',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        h.peer.send({ type: 'hold-write' })
        await until(() =>
            h.peerEvents.some((event) => event.type === 'holding-enabled')
        )
        await h.connect(api.url)
        await until(() =>
            h.peerEvents.some((event) => event.type === 'write-held')
        )
        const before = h.peerEvents.filter(
            (event) => event.type === 'rpc'
        ).length
        for (let i = 0; i < 50; i++) h.peer.send({ type: 'hello' })
        await until(
            () =>
                (api.registry.currentHelloEvidence(h.daemonId)?.helloOrder ??
                    0) >= 51
        )
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            before
        )
        h.peer.send({ type: 'release-write' })
        await until(
            async () =>
                (await h.readAgent()).extras.contextDocDelivery?.status ===
                'delivered',
            8000
        )
        const stamp = (await stat(path.join(h.workspace, '.mcp.json'))).mtimeMs
        const complete = h.observations.length
        const rpcCount = h.peerEvents.filter(
            (event) => event.type === 'rpc'
        ).length
        h.peer.send({ type: 'hello' })
        await until(() => h.observations.length > complete, 5000)
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            rpcCount
        )
        assert.equal(
            (await stat(path.join(h.workspace, '.mcp.json'))).mtimeMs,
            stamp
        )
    }
)

test(
    'same template version still refreshes linked context after offline edits',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        await h.connect(api.url)
        await until(
            async () =>
                (await h.readAgent()).extras.contextDocDelivery?.status ===
                'delivered'
        )
        const first = (await h.readAgent()).extras.contextDoc
        h.peer.send({ type: 'disconnect' })
        await until(
            async () =>
                !(
                    await h.db
                        .select()
                        .from(runtimeHosts)
                        .where(eq(runtimeHosts.id, h.daemonId))
                )[0].rpcInstanceId
        )
        const connectionId = createObjectId('userConnection')
        await h.db.insert(userConnections).values({
            id: connectionId,
            userId: h.userId,
            provider: 'github',
            kind: 'github_app_installation',
            displayName: 'Owned fixture source',
            externalId: connectionId,
            metadata: { accountName: 'fixture-account' }
        })
        const row = await h.readAgent()
        await h.db
            .update(agents)
            .set({
                extras: { ...row.extras, githubConnectionId: connectionId }
            })
            .where(eq(agents.id, row.id))
        await h.connect(api.url)
        await until(
            async () =>
                (await h.readAgent()).extras.contextDoc?.revision !==
                first?.revision
        )
        const next = await h.readAgent()
        assert.equal(next.extras.contextDoc?.version, 1)
        assert.match(
            await readFile(
                path.join(h.workspace, 'AGENTS.manyfold.md'),
                'utf8'
            ),
            /fixture-account/
        )
        assert.equal(
            (await api.context.getStatus(h.userId, h.agentId, false)).upToDate,
            true
        )
        await h.db
            .update(agents)
            .set({ extras: { ...next.extras, githubConnectionId: null } })
            .where(eq(agents.id, h.agentId))
        h.peer.send({ type: 'hello' })
        await until(
            async () =>
                (await h.readAgent()).extras.contextDoc?.revision !==
                next.extras.contextDoc?.revision
        )
        assert.doesNotMatch(
            await readFile(
                path.join(h.workspace, 'AGENTS.manyfold.md'),
                'utf8'
            ),
            /fixture-account/
        )
        assert.equal((await h.readAgent()).extras.contextDoc?.version, 1)
    }
)

test(
    'manual, on-change and automatic delivery share ownership; an updated desired revision cannot inherit old success',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        await h.connect(api.url)
        h.peer.send({ type: 'hold-write' })
        await until(() =>
            h.peerEvents.some((event) => event.type === 'holding-enabled')
        )
        const pending = api.mcp
            .materializeForAgent(await h.readAgent())
            .catch((error: unknown) => error)
        try {
            await until(() =>
                h.peerEvents.some((event) => event.type === 'write-held')
            )
            const before = h.peerEvents.filter(
                (event) => event.type === 'rpc'
            ).length
            const row = await h.readAgent()
            await h.db
                .update(agents)
                .set({
                    extras: {
                        ...row.extras,
                        mcp: {
                            project:
                                '{"fixture":{"command":"updated-during-push"}}'
                        }
                    }
                })
                .where(eq(agents.id, h.agentId))
            const latest = await h.readAgent()
            await assert.rejects(
                api.mcp.materializeForAgent(latest),
                /configuration busy/
            )
            await api.mcp.refreshOnChange(latest)
            await assert.rejects(
                api.mcp.materializeForAgent(latest, {
                    automatic: true,
                    evidence: api.registry.currentHelloEvidence(h.daemonId)!
                }),
                /configuration busy/
            )
            assert.equal(
                h.peerEvents.filter((event) => event.type === 'rpc').length,
                before
            )
        } finally {
            h.peer.send({ type: 'release-write' })
        }
        assert((await pending) instanceof Error)
        assert.notEqual(
            (await h.readAgent()).extras.mcpDelivery?.project?.status,
            'delivered'
        )
        api.reconciler.onModuleInit()
        h.peer.send({ type: 'hello' })
        await until(
            async () =>
                (await h.readAgent()).extras.contextDocDelivery?.status ===
                'delivered'
        )
        assert.equal(
            JSON.parse(await h.readProject()).mcpServers.fixture.command,
            'updated-during-push'
        )
    }
)

test(
    'unsupported frameworks, foreign owners and revoked hosts never receive configuration writes',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        await h.connect(api.url)
        const row = await h.readAgent()
        await assert.rejects(
            api.mcp.materializeForAgent({
                ...row,
                userId: createObjectId('user')
            }),
            /unsupported/
        )
        await assert.rejects(
            api.context.refresh(createObjectId('user'), h.agentId, false),
            /not found/
        )
        for (const framework of ['openclaw', 'hermes'] as const) {
            await h.db
                .update(agents)
                .set({ framework })
                .where(eq(agents.id, h.agentId))
            await assert.rejects(
                api.mcp.materializeForAgent(await h.readAgent()),
                /do not support/
            )
            await assert.rejects(
                api.context.refresh(h.userId, h.agentId, false),
                /only available/
            )
        }
        await h.db
            .update(agents)
            .set({ framework: row.framework })
            .where(eq(agents.id, h.agentId))
        await h.db
            .update(runtimeHosts)
            .set({ status: 'revoked' })
            .where(eq(runtimeHosts.id, h.daemonId))
        await assert.rejects(
            api.mcp.materializeForAgent(await h.readAgent()),
            /cancelled/
        )
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
    }
)

test(
    'an unreadable linked secret leaves a durable failed result without leaking its contents',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        await h.connect(api.url)
        const connectionId = createObjectId('userConnection')
        await h.db.insert(userConnections).values({
            id: connectionId,
            userId: h.userId,
            provider: 'composio',
            kind: 'composio_consumer_key',
            displayName: 'Owned fixture key',
            externalId: connectionId,
            secretCiphertext: 'fixture-private-ciphertext',
            keyVersion: 1
        })
        const row = await h.readAgent()
        await h.db
            .update(agents)
            .set({
                extras: { ...row.extras, composioConnectionId: connectionId }
            })
            .where(eq(agents.id, h.agentId))
        const results = await api.mcp.materializeForAgent(await h.readAgent())
        assert(results.every((result) => result.status === 'failed'))
        assert.equal(
            (await h.readAgent()).extras.mcpDelivery?.project?.status,
            'failed'
        )
        assert.doesNotMatch(
            JSON.stringify(results),
            /fixture-private-ciphertext|decrypt|secretCiphertext/
        )
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
    }
)

test(
    'configuration high water survives release and is removed only with its permanently deleted host',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        await h.connect(api.url)
        const generations: string[] = []
        for (let i = 0; i < 2; i++)
            await api.delivery.deliver(
                await h.readAgent(),
                async (_snapshot, attempt) => {
                    generations.push(attempt.generation)
                }
            )
        assert(BigInt(generations[1]) > BigInt(generations[0]))
        assert.equal(
            (
                await h.db
                    .select()
                    .from(serviceLeases)
                    .where(
                        eq(
                            serviceLeases.name,
                            daemonConfigLeaseName(h.daemonId)
                        )
                    )
            ).length,
            1
        )
        h.peer.send({ type: 'disconnect' })
        await until(() => !api.registry.isOnline(h.daemonId))
        await h.db
            .update(runtimeHosts)
            .set({ status: 'revoked' })
            .where(eq(runtimeHosts.id, h.daemonId))
        const hosts = new DaemonHostService(
            h.db,
            {} as never,
            {} as never,
            api.registry,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        await hosts.deleteRevoked({
            id: h.daemonId,
            actorId: h.userId,
            userId: h.userId
        })
        assert.equal(
            (
                await h.db
                    .select()
                    .from(serviceLeases)
                    .where(
                        eq(
                            serviceLeases.name,
                            daemonConfigLeaseName(h.daemonId)
                        )
                    )
            ).length,
            0
        )
    }
)

test(
    'missing protected capability never falls back automatically, but explicit legacy push remains available',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        await h.connect(api.url, true, [])
        await until(() => h.observations.length > 0)
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
        const row = await h.readAgent()
        assert.equal(row.extras.mcpDelivery?.project?.status, 'skipped')
        assert.equal(row.extras.contextDoc?.version, 0)
        await api.mcp.materializeForAgent(row)
        assert.equal(
            JSON.parse(await h.readProject()).mcpServers.fixture.command,
            'offline-desired'
        )
    }
)

test(
    'protected reads reject malformed successful payloads rather than fabricating empty files',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        await h.connect(api.url)
        for (const value of [undefined, null, false, 0, {}]) {
            const controls = h.peerEvents.filter(
                (event) => event.type === 'read-mode-set'
            ).length
            h.peer.send({ type: 'malformed-read', enabled: true, value })
            await until(
                () =>
                    h.peerEvents.filter(
                        (event) => event.type === 'read-mode-set'
                    ).length > controls
            )
            const result = await api.mcp.materializeForAgent(
                await h.readAgent()
            )
            assert(result.every((entry) => entry.status === 'failed'))
        }
        assert.equal(
            h.peerEvents.filter(
                (event) => event.type === 'rpc' && event.method === 'fs.write'
            ).length,
            0
        )
        await assert.rejects(h.readProject(), { code: 'ENOENT' })
    }
)

test(
    'partial context delivery stays stale and the next reconnect completes both files',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        await writeFile(
            path.join(h.workspace, 'CLAUDE.md'),
            `User instructions before\n${MANYFOLD_CONTEXT_START}\nold managed block\n${MANYFOLD_CONTEXT_END}\nUser instructions after\n`
        )
        h.peer.send({ type: 'fail-write', suffix: 'CLAUDE.md' })
        await until(() =>
            h.peerEvents.some((event) => event.type === 'write-failure-set')
        )
        await h.connect(api.url)
        await until(
            async () =>
                (await h.readAgent()).extras.contextDocDelivery?.status ===
                'failed'
        )
        assert.equal((await h.readAgent()).extras.contextDoc?.version, 0)
        assert.match(
            await readFile(
                path.join(h.workspace, 'AGENTS.manyfold.md'),
                'utf8'
            ),
            /Manyfold platform context/
        )
        h.peer.send({ type: 'disconnect' })
        await until(() => !api.registry.isOnline(h.daemonId))
        await h.connect(api.url)
        await until(
            async () =>
                (await h.readAgent()).extras.contextDocDelivery?.status ===
                'delivered'
        )
        const instruction = await readFile(
            path.join(h.workspace, 'CLAUDE.md'),
            'utf8'
        )
        assert.match(instruction, /@AGENTS.manyfold.md/)
        assert(instruction.startsWith('User instructions before\n'))
        assert(instruction.endsWith('\nUser instructions after\n'))
        assert.doesNotMatch(instruction, /old managed block/)
    }
)

test(
    'a failed read whose path contains ENOENT is not treated as an absent configuration file',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        await h.connect(api.url)
        const original = api.registry.streamRpc.bind(api.registry)
        t.mock.method(
            api.registry,
            'streamRpc',
            (args: Parameters<typeof original>[0]) => {
                if (args.method === 'fs.read')
                    return {
                        refId: 'owned-read-error',
                        result: Promise.reject(
                            new Error(
                                'EACCES: permission denied, open /owned/ENOENT-marker/config'
                            )
                        ),
                        cancel() {}
                    }
                return original(args)
            }
        )
        const result = await api.mcp.materializeForAgent(await h.readAgent())
        assert(result.every((scope) => scope.status === 'failed'))
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
        await assert.rejects(h.readProject(), { code: 'ENOENT' })
    }
)

for (const remote of [false, true])
    test(
        `${remote ? 'brokered' : 'local'} shutdown cancels protected writes, releases ownership, and leaves stale state`,
        { skip: !RUN, timeout: 20_000 },
        async (t) => {
            const h = await configFixture(t)
            const owner = await h.api(false)
            const api = remote ? await h.api(false) : owner
            await h.connect(owner.url)
            h.peer.send({ type: 'hold-write' })
            await until(() =>
                h.peerEvents.some((event) => event.type === 'holding-enabled')
            )
            const pending = api.mcp
                .materializeForAgent(await h.readAgent())
                .catch((error: unknown) => error)
            await until(() =>
                h.peerEvents.some((event) => event.type === 'write-held')
            )
            await api.delivery.onModuleDestroy()
            await until(() =>
                h.peerEvents.some((event) => event.type === 'cancel-seen')
            )
            const before = h.peerEvents.filter(
                (event) => event.type === 'rpc-complete'
            ).length
            h.peer.send({ type: 'release-write' })
            await pending
            await until(
                () =>
                    h.peerEvents.filter(
                        (event) => event.type === 'rpc-complete'
                    ).length > before
            )
            await assert.rejects(h.readProject(), { code: 'ENOENT' })
            const [lease] = await h.db
                .select({
                    expired: sql<boolean>`${serviceLeases.expiresAt} <= clock_timestamp()`
                })
                .from(serviceLeases)
                .where(
                    eq(serviceLeases.name, daemonConfigLeaseName(h.daemonId))
                )
            assert.equal(lease.expired, true)
            assert.notEqual(
                (await h.readAgent()).extras.mcpDelivery?.project?.status,
                'delivered'
            )
        }
    )

test(
    'reconciler shutdown cancels its in-flight delivery before the delivery service is destroyed',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        h.peer.send({ type: 'hold-write' })
        await until(() =>
            h.peerEvents.some((event) => event.type === 'holding-enabled')
        )
        await h.connect(api.url)
        await until(() =>
            h.peerEvents.some((event) => event.type === 'write-held')
        )
        await api.reconciler.onModuleDestroy()
        await until(() =>
            h.peerEvents.some((event) => event.type === 'cancel-seen')
        )
        const before = h.peerEvents.filter(
            (event) => event.type === 'rpc-complete'
        ).length
        h.peer.send({ type: 'release-write' })
        await until(
            () =>
                h.peerEvents.filter((event) => event.type === 'rpc-complete')
                    .length > before
        )
        await assert.rejects(h.readProject(), { code: 'ENOENT' })
        assert(
            h.observations.some((event) => event.attrs.outcome === 'cancelled')
        )
        assert.notEqual(
            (await h.readAgent()).extras.mcpDelivery?.project?.status,
            'delivered'
        )
    }
)

test(
    'manual publication rechecks the host connection in its final transaction',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const first = await h.api(false)
        const second = await h.api(false)
        await h.connect(first.url)
        let entered = false
        let release!: () => void
        const wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const original = first.delivery.deliver.bind(first.delivery)
        Object.assign(first.delivery, {
            deliver: (
                agent: Agent,
                work: (
                    snapshot: DaemonConfigSnapshot,
                    attempt: DaemonConfigAttempt
                ) => Promise<unknown>
            ) =>
                original(agent, (snapshot, attempt) =>
                    work(snapshot, {
                        ...attempt,
                        publish: async (...args) => {
                            entered = true
                            await wait
                            return attempt.publish(...args)
                        }
                    })
                )
        })
        const pending = first.mcp
            .materializeForAgent(await h.readAgent())
            .catch((error: unknown) => error)
        try {
            await until(() => entered)
            await h.connect(second.url)
        } finally {
            release()
        }
        assert((await pending) instanceof Error)
        assert.notEqual(
            (await h.readAgent()).extras.mcpDelivery?.project?.status,
            'delivered'
        )
        await second.mcp.materializeForAgent(await h.readAgent())
        assert.equal(
            (await h.readAgent()).extras.mcpDelivery?.project?.status,
            'delivered'
        )
    }
)

test(
    'same-millisecond websocket replacement cannot publish the old manual delivery',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api(false)
        t.mock.timers.enable({
            apis: ['Date'],
            now: new Date('2026-09-17T12:00:00Z')
        })
        await h.connect(api.url)
        const first = api.registry.currentHelloEvidence(h.daemonId)!
        const [hostBefore] = await h.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, h.daemonId))
        let entered = false
        let release!: () => void
        const wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const original = api.delivery.deliver.bind(api.delivery)
        Object.assign(api.delivery, {
            deliver: (
                agent: Agent,
                work: (
                    snapshot: DaemonConfigSnapshot,
                    attempt: DaemonConfigAttempt
                ) => Promise<unknown>
            ) =>
                original(agent, (snapshot, attempt) =>
                    work(snapshot, {
                        ...attempt,
                        publish: async (...args) => {
                            entered = true
                            await wait
                            return attempt.publish(...args)
                        }
                    })
                )
        })
        const pending = api.mcp
            .materializeForAgent(await h.readAgent())
            .catch((error: unknown) => error)
        try {
            await until(() => entered)
            await h.connect(api.url)
            const [hostAfter] = await h.db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, h.daemonId))
            assert.equal(
                hostBefore.rpcConnectedAt?.getTime(),
                hostAfter.rpcConnectedAt?.getTime()
            )
            assert.notEqual(
                first.connectionToken,
                api.registry.currentHelloEvidence(h.daemonId)?.connectionToken
            )
        } finally {
            t.mock.timers.reset()
            release()
        }
        assert((await pending) instanceof Error)
        assert.notEqual(
            (await h.readAgent()).extras.mcpDelivery?.project?.status,
            'delivered'
        )
    }
)

test(
    'protected broker requests fail closed with malformed identities or a legacy receiver; normal RPC remains available',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const owner = await h.api(false)
        const caller = await h.api(false)
        await h.connect(owner.url)
        const expectedConnection = owner.registry.localConfigConnectionToken(
            h.daemonId
        )!
        const receiver = owner.registry as unknown as {
            handleBrokerMessage(message: Record<string, unknown>): Promise<void>
        }
        const original = receiver.handleBrokerMessage.bind(receiver)
        let malformed = false
        let value: unknown
        let legacy = false
        let configRequests = 0
        t.mock.method(
            receiver,
            'handleBrokerMessage',
            async (message: Record<string, unknown>) => {
                if (message.type === 'config-request') {
                    configRequests++
                    if (legacy) return
                    if (malformed) message.expectedConnection = value
                }
                return original(message)
            }
        )
        for (value of [undefined, null, 42, '', 'wrong-instance:wrong-token']) {
            malformed = true
            const request = caller.registry.streamRpc({
                daemonId: h.daemonId,
                method: 'fs.read',
                payload: { path: path.join(h.workspace, '.mcp.json') },
                expectedConnection,
                onEvent: undefined,
                timeoutMs: 500
            })
            await assert.rejects(
                request.result,
                /configuration (unsupported|superseded)/
            )
        }
        malformed = false
        legacy = true
        const old = caller.registry.streamRpc({
            daemonId: h.daemonId,
            method: 'fs.read',
            payload: { path: path.join(h.workspace, '.mcp.json') },
            expectedConnection,
            onEvent: undefined,
            timeoutMs: 150
        })
        await assert.rejects(old.result, /timed out|timeout/i)
        assert.equal(configRequests, 6)
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
        await assert.rejects(
            caller.registry.rpc({
                daemonId: h.daemonId,
                method: 'fs.read',
                payload: { path: path.join(h.workspace, '.mcp.json') }
            }),
            /ENOENT/
        )
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            1
        )
        legacy = false
        await caller.mcp.materializeForAgent(await h.readAgent())
        assert.equal(
            JSON.parse(await h.readProject()).mcpServers.fixture.command,
            'offline-desired'
        )
        const before = h.peerEvents.filter(
            (event) => event.type === 'rpc'
        ).length
        await h.db
            .update(runtimeHosts)
            .set({ rpcInstanceId: 'legacy-api-owner' })
            .where(eq(runtimeHosts.id, h.daemonId))
        await assert.rejects(
            caller.mcp.materializeForAgent(await h.readAgent()),
            /unsupported/
        )
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            before
        )
    }
)

test(
    'a rejected hello never admits automatic configuration delivery',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const api = await h.api()
        h.peer.send({ type: 'connect', url: api.url, version: '0.1.0' })
        await until(() => h.peerEvents.some((event) => event.type === 'closed'))
        assert.equal(api.registry.currentHelloEvidence(h.daemonId), null)
        assert.equal(h.observations.length, 0)
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
        assert.equal(
            (
                await h.db
                    .select()
                    .from(serviceLeases)
                    .where(
                        eq(
                            serviceLeases.name,
                            daemonConfigLeaseName(h.daemonId)
                        )
                    )
            ).length,
            0
        )
    }
)

test(
    'a crash-held delivery lease still has one bounded automatic retry after lease expiry',
    { skip: !RUN, timeout: 25_000 },
    async (t) => {
        const h = await configFixture(t)
        await h.db.insert(serviceLeases).values({
            name: daemonConfigLeaseName(h.daemonId),
            holderId: 'owned-crashed-attempt',
            acquiredAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
            expiresAt: sql`clock_timestamp() + interval '120 seconds'`
        })
        const timers: Array<{
            handle: ReturnType<typeof schedule> | number
            run: () => void
            delay: number
        }> = []
        t.mock.method(globalThis, 'setTimeout', ((
            run: () => void,
            delay = 0,
            ...args: unknown[]
        ) => {
            const handle = schedule(run, delay, ...args)
            if (delay >= 119_000 && delay <= 120_000)
                timers.push({ handle, run, delay })
            return handle
        }) as typeof setTimeout)
        const api = await h.api()
        await h.connect(api.url)
        await until(() => h.observations.length >= 2, 8000)
        await until(() => timers.length > 0, 2000)
        assert.equal(
            h.peerEvents.filter((event) => event.type === 'rpc').length,
            0
        )
        const retry = timers[0]
        assert(retry.delay >= 119_000 && retry.delay <= 120_000)
        clearTimeout(retry.handle)
        await h.db
            .update(serviceLeases)
            .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
            .where(eq(serviceLeases.name, daemonConfigLeaseName(h.daemonId)))
        retry.run()
        await until(
            async () =>
                (await h.readAgent()).extras.contextDocDelivery?.status ===
                'delivered'
        )
        assert.equal(
            JSON.parse(await h.readProject()).mcpServers.fixture.command,
            'offline-desired'
        )
    }
)

test(
    'a budget-exhausted pass resumes after its completed agent instead of starving the tail',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await configFixture(t)
        const first = await h.readAgent()
        const secondId = createObjectId('agent')
        await h.db.insert(agents).values({
            ...first,
            id: secondId,
            internalId: secondId,
            name: 'second owned agent',
            workspacePath: path.join(h.workspace, 'second'),
            mountPath: path.join(h.workspace, 'second')
        })
        const api = await h.api()
        let clock = 0
        const ordered = [first.id, secondId].sort()
        t.mock.method(performance, 'now', () => clock)
        const original = api.context.refreshDaemon.bind(api.context)
        const delivered: string[] = []
        t.mock.method(
            api.context,
            'refreshDaemon',
            async (
                agent: Agent,
                options: Parameters<typeof api.context.refreshDaemon>[1]
            ) => {
                await original(agent, options)
                delivered.push(agent.id)
                if (agent.id === ordered[0]) clock = 90_001
            }
        )
        await h.connect(api.url)
        await until(() => delivered.length === 2, 8000)
        assert.deepEqual(delivered, ordered)
        assert(
            h.observations.some((event) => event.attrs.outcome === 'deferred')
        )
        assert(
            h.observations.some((event) => event.attrs.outcome === 'complete')
        )
    }
)

for (const replace of [false, true])
    test(
        `a blocked old filesystem write cannot overwrite a newer snapshot across ${replace ? 'connection replacement' : 'two API instances'}`,
        { skip: !RUN, timeout: 20_000 },
        async (t) => {
            const h = await configFixture(t)
            const first = await h.api(false)
            const second = await h.api(false)
            await h.connect(first.url)
            h.peer.send({ type: 'hold-write' })
            await until(() =>
                h.peerEvents.some((event) => event.type === 'holding-enabled')
            )
            const old = first.mcp
                .materializeForAgent(await h.readAgent())
                .catch((error: unknown) => error)
            try {
                await until(() =>
                    h.peerEvents.some((event) => event.type === 'write-held')
                )
                const row = await h.readAgent()
                await h.db
                    .update(agents)
                    .set({
                        extras: {
                            ...row.extras,
                            mcp: {
                                project: '{"fixture":{"command":"new-desired"}}'
                            }
                        }
                    })
                    .where(eq(agents.id, h.agentId))
                if (replace) await h.connect(second.url)
                await h.db
                    .update(serviceLeases)
                    .set({
                        expiresAt: sql`clock_timestamp() - interval '1 second'`
                    })
                    .where(
                        eq(
                            serviceLeases.name,
                            daemonConfigLeaseName(h.daemonId)
                        )
                    )
                const latest = await second.mcp.materializeForAgent(
                    await h.readAgent()
                )
                assert(latest.some((scope) => scope.status === 'delivered'))
                assert.equal(
                    JSON.parse(await h.readProject()).mcpServers.fixture
                        .command,
                    'new-desired'
                )
                h.peer.send({ type: 'release-write' })
                await old
                await until(
                    async () =>
                        JSON.parse(await h.readProject()).mcpServers.fixture
                            .command === 'offline-desired',
                    1000
                ).catch(() => {})
                const final = JSON.parse(await h.readProject()).mcpServers
                    .fixture.command
                t.diagnostic(
                    JSON.stringify({ replace, final, desired: 'new-desired' })
                )
                assert.equal(final, 'new-desired')
            } finally {
                h.peer.send({ type: 'release-write' })
                await old
            }
        }
    )
