import 'reflect-metadata'
import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import {
    createDb,
    users,
    runtimeHosts,
    agentRuntimes,
    agents,
    serviceLeases,
    type Agent
} from '@manyfold/db'
import { createObjectId } from '@manyfold/shared'
import { DaemonGateway } from '../../src/modules/daemon/daemon.gateway'
import { DaemonRegistryService } from '../../src/modules/daemon/daemon-registry.service'
import { McpConfigMaterializer } from '../../src/modules/agent-runtimes/mcp/mcp-config-materializer.service'
import { AgentContextDocService } from '../../src/modules/agent-self/agent-context-doc.service'
import { AgentContextDocManageService } from '../../src/modules/agents/agent-context-doc-manage.service'
import {
    DaemonConfigDeliveryService,
    daemonConfigLeaseName
} from '../../src/modules/daemon/daemon-config-delivery.service'
import { DaemonConfigReconciler } from '../../src/modules/agents/daemon-config-reconciler.service'

export const until = async (
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 5000
): Promise<void> => {
    const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n
    while (!(await predicate())) {
        if (process.hrtime.bigint() >= deadline)
            throw new Error('owned daemon fixture barrier timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

export const configFixture = async (t: TestContext) => {
    const db = createDb(process.env.DATABASE_URL!)
    const userId = createObjectId('user')
    const daemonId = createObjectId('daemonHost')
    const runtimeId = createObjectId('agentRuntime')
    const agentId = createObjectId('agent')
    const root = await mkdtemp(path.join(tmpdir(), 'manyfold-784-'))
    const home = path.join(root, 'home')
    const workspace = path.join(home, 'workspaces', 'agent')
    await mkdir(workspace, { recursive: true })
    const peerEvents: Array<{ type: string; method?: string }> = []
    const cliRoot = path.resolve(__dirname, '../../../cli')
    const peer = spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            '--import',
            './test/md-text-loader.mjs',
            'test/fixtures/config-delivery-peer.mjs'
        ],
        {
            cwd: cliRoot,
            env: {
                PATH: process.env.PATH,
                HOME: home,
                TMPDIR: root,
                MF_CONFIG_DIR: path.join(root, 'config'),
                MF_PROFILE: 'fixture',
                FIXTURE_WORKSPACE: workspace,
                TSX_TSCONFIG_PATH: path.join(cliRoot, 'tsconfig.json')
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        }
    )
    let output = ''
    assert(peer.stdout && peer.stderr)
    peer.stdout.on('data', (chunk) => {
        output += chunk
    })
    peer.stderr.on('data', (chunk) => {
        output += chunk
    })
    peer.on('message', (message) =>
        peerEvents.push(message as (typeof peerEvents)[number])
    )
    const terminal = once(peer, 'close')
    const servers: ReturnType<typeof Fastify>[] = []
    const registries: DaemonRegistryService[] = []
    const observations: Array<{
        name: string
        attrs: Record<string, unknown>
    }> = []
    const shutdown: Array<() => Promise<void>> = []
    const unregisters: Promise<void>[] = []
    t.after(async () => {
        if (peer.connected) peer.send({ type: 'stop' })
        const kill = setTimeout(() => peer.kill('SIGKILL'), 3000)
        await terminal
        clearTimeout(kill)
        for (const server of servers) await server.close()
        await Promise.allSettled(unregisters)
        for (const stop of shutdown) await stop()
        for (const registry of registries) await registry.onModuleDestroy()
        await db.delete(users).where(eq(users.id, userId))
        await db
            .delete(serviceLeases)
            .where(eq(serviceLeases.name, daemonConfigLeaseName(daemonId)))
        await db.$client.end({ timeout: 5 })
        await rm(root, { recursive: true, force: true })
    })
    await until(
        () =>
            peerEvents.some((event) => event.type === 'ready') ||
            peer.exitCode !== null
    )
    assert.equal(peer.exitCode, null, output)
    await db
        .insert(users)
        .values({ id: userId, email: `${userId}@fixture.invalid` })
    await db
        .insert(runtimeHosts)
        .values({
            id: daemonId,
            userId,
            kind: 'daemon',
            name: 'owned daemon',
            daemonUuid: daemonId,
            status: 'offline',
            cliVersion: '3.0.3',
            homeDir: home
        })
    await db
        .insert(agentRuntimes)
        .values({
            id: runtimeId,
            userId,
            kind: 'daemon',
            daemonId,
            name: 'owned runtime',
            framework: 'claude-code',
            status: 'ready',
            homeDir: home,
            mountPath: workspace
        })
    await db
        .insert(agents)
        .values({
            id: agentId,
            userId,
            framework: 'claude-code',
            runtime: 'daemon',
            daemonId,
            runtimeId,
            name: 'owned agent',
            internalId: agentId,
            status: 'running',
            workspacePath: workspace,
            mountPath: workspace,
            extras: {
                mcp: { project: '{"fixture":{"command":"offline-desired"}}' },
                contextDoc: { version: 0, generatedAt: '2026-01-01T00:00:00Z' }
            }
        })
    type FixtureAgent = Agent & {
        extras: {
            mcpDelivery?: Record<string, { status: string }>
            contextDoc?: { version: number; revision?: string }
            contextDocDelivery?: { status: string }
        }
    }
    const readAgent = async (): Promise<FixtureAgent> =>
        (
            await db.select().from(agents).where(eq(agents.id, agentId))
        )[0] as FixtureAgent
    const api = async (automatic = true) => {
        const registry = new DaemonRegistryService(
            db,
            new ConfigService({
                MF_API_INSTANCE_ID: createObjectId('daemonHost'),
                DATABASE_URL: process.env.DATABASE_URL
            })
        )
        await registry.onModuleInit()
        registries.push(registry)
        const unregister = registry.unregister.bind(registry)
        registry.unregister = (...args) => {
            const pending = unregister(...args)
            unregisters.push(pending)
            return pending
        }
        const fastify = Fastify()
        await fastify.register(websocket)
        servers.push(fastify)
        const gateway = new DaemonGateway(
            db,
            { httpAdapter: { getInstance: () => fastify } } as never,
            {
                verify: async (token: string) => {
                    assert.equal(token, 'fixture-only')
                    return { userId, daemonId }
                }
            } as never,
            {
                findById: async () =>
                    (
                        await db
                            .select()
                            .from(runtimeHosts)
                            .where(eq(runtimeHosts.id, daemonId))
                    )[0],
                touchLastSeen: async () => {}
            } as never,
            registry,
            { handleInflightStreams: async () => {} } as never
        )
        gateway.onModuleInit()
        const origin = await fastify.listen({ host: '127.0.0.1', port: 0 })
        const delivery = new DaemonConfigDeliveryService(db, registry)
        const mcp = new McpConfigMaterializer(
            db,
            {} as never,
            {} as never,
            registry,
            delivery
        )
        const context = new AgentContextDocManageService(
            db,
            {} as never,
            new AgentContextDocService(db, {
                resolveAgentConnectionsById: async () => []
            } as never),
            registry,
            delivery
        )
        const reconciler = new DaemonConfigReconciler(
            db,
            registry,
            mcp,
            context,
            {
                event(name: string, attrs: Record<string, unknown>) {
                    observations.push({ name, attrs })
                }
            } as never
        )
        if (automatic) reconciler.onModuleInit()
        shutdown.push(async () => {
            await delivery.onModuleDestroy()
            await reconciler.onModuleDestroy()
        })
        return {
            registry,
            gateway,
            mcp,
            context,
            delivery,
            reconciler,
            url: origin.replace('http:', 'ws:') + '/api/daemon/ws'
        }
    }
    const connect = async (
        url: string,
        inventory = true,
        features?: string[]
    ) => {
        const before = peerEvents.filter(
            (event) => event.type === 'welcome'
        ).length
        peer.send({ type: 'connect', url, inventory, features })
        await until(
            () =>
                peerEvents.filter((event) => event.type === 'welcome').length >
                before
        )
    }
    return {
        db,
        userId,
        daemonId,
        runtimeId,
        agentId,
        root,
        home,
        workspace,
        peer,
        peerEvents,
        api,
        connect,
        readAgent,
        observations,
        readProject: () => readFile(path.join(workspace, '.mcp.json'), 'utf8'),
        output: () => output
    }
}
