import 'reflect-metadata'
import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { TestContext } from 'node:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and, inArray } from 'drizzle-orm'
import { WebSocket, WebSocketServer } from 'ws'
import {
    createObjectId,
    frameworkCapability,
    type AgentFramework
} from '@manyfold/shared'
import {
    schema,
    users,
    agents,
    agentRuntimes,
    runtimeHosts,
    spritesAccounts,
    type Database,
    type NewRuntimeHostRow,
    type NewAgent
} from '@manyfold/db'
import { createClient } from '@manyfold/sprites'
import { SpriteStorageService } from '../../src/modules/agents/sprite-storage/sprite-storage.service'
import { RuntimeAccessService } from '../../src/modules/runtime-access/runtime-access.service'
import { SandboxActiveDurationService } from '../../src/modules/agents/sandbox-active-duration/sandbox-active-duration.service'

export const OLD = new Date('2026-01-01T00:00:00Z')
export const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 5000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error('owned fixture barrier timed out')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

export const storageFixture = async (t: TestContext) => {
    assert(process.env.DATABASE_URL)
    const client = postgres(process.env.DATABASE_URL, { max: 6 })
    const db: Database = drizzle(client, { schema })
    const userId = createObjectId('user')
    const hostId = createObjectId('sandboxHost')
    const accountId = createObjectId('spritesAccount')
    const userIds = [userId]
    const httpServer = createServer((_request, response) => response.end('{}'))
    const server = new WebSocketServer({ noServer: true })
    const network = { stallBeforeOpen: false }
    const connections = new Set<Duplex>()
    const sockets: WebSocket[] = []
    const requests: URL[] = []
    httpServer.on('upgrade', (request, socket, head) => {
        requests.push(new URL(request.url ?? '/', 'http://fixture.invalid'))
        connections.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => connections.delete(socket))
        if (!network.stallBeforeOpen)
            server.handleUpgrade(request, socket, head, (ws) =>
                server.emit('connection', ws, request)
            )
    })
    await new Promise<void>((resolve) =>
        httpServer.listen(0, '127.0.0.1', resolve)
    )
    let active = 0
    let peak = 0
    server.on('connection', (socket) => {
        sockets.push(socket)
        active++
        peak = Math.max(peak, active)
        socket.on('message', () => {})
        socket.on('error', () => {})
        socket.once('close', () => active--)
        socket.send(
            JSON.stringify({
                type: 'session_info',
                session_id: `fixture-${sockets.length}`
            })
        )
    })
    t.after(async () => {
        for (const socket of server.clients) socket.terminate()
        for (const socket of connections) socket.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        httpServer.closeAllConnections()
        await new Promise<void>((resolve) => httpServer.close(() => resolve()))
        try {
            await db.delete(users).where(inArray(users.id, userIds))
            await db
                .delete(spritesAccounts)
                .where(eq(spritesAccounts.id, accountId))
        } finally {
            await client.end({ timeout: 5 })
        }
    })
    await db
        .insert(users)
        .values({ id: userId, email: `${userId}@fixture.invalid` })
    await db
        .insert(spritesAccounts)
        .values({
            id: accountId,
            slug: accountId,
            orgSlug: 'fixture',
            orgId: 'fixture',
            tokenId: 'fixture',
            tokenCiphertext: 'not-a-credential'
        })
    await db
        .insert(runtimeHosts)
        .values({
            id: hostId,
            userId,
            kind: 'sandbox',
            name: 'owned storage fixture',
            accountId,
            spriteName: 'owned-fixture',
            spriteStatus: 'running',
            status: 'active',
            storageBytes: 9000,
            storageMeasuredAt: OLD,
            storageBreakdown: {
                vmUsedBytes: 9000,
                workspaces: [],
                homes: [],
                measuredVia: 'df'
            }
        })
    const address = httpServer.address()
    assert(address && typeof address === 'object')
    const sprite = createClient({
        token: 'fixture-only',
        baseUrl: `http://127.0.0.1:${address.port}`,
        wsBaseUrl: `ws://127.0.0.1:${address.port}`
    })
    const events: string[] = []
    const failures: string[] = []
    const observations: { name: string; attrs: Record<string, unknown> }[] = []
    const service = (unavailable = false) => {
        const instance = new SpriteStorageService(
            db,
            {} as never,
            {
                event: (name: string, attrs: Record<string, unknown>) => {
                    observations.push({ name, attrs })
                    if (name === 'sprite_storage_measured') events.push(name)
                },
                error: (
                    name: string,
                    _error: Error,
                    attrs: Record<string, unknown>
                ) => {
                    observations.push({ name, attrs })
                    failures.push(name)
                }
            } as never,
            { isKnownUnavailable: async () => unavailable } as never
        )
        // Replace only the endpoint; use the actual measurement implementation.
        Object.assign(instance, {
            clientFor: async () => sprite
        })
        return instance
    }
    const finish = (socket: WebSocket, bytes = 12000, code = 0) => {
        socket.send(
            Buffer.concat([Buffer.from([0x01]), Buffer.from(`${bytes}\n`)])
        )
        socket.send(Buffer.from([0x03, code]))
    }
    const addUser = async () => {
        const id = createObjectId('user')
        userIds.push(id)
        await db.insert(users).values({ id, email: `${id}@fixture.invalid` })
        return id
    }
    const addHost = async (overrides: Partial<NewRuntimeHostRow> = {}) => {
        const id = createObjectId('sandboxHost')
        const [row] = await db
            .insert(runtimeHosts)
            .values({
                id,
                userId,
                kind: 'sandbox',
                name: id,
                status: 'active',
                spriteStatus: 'running',
                accountId,
                spriteName: id,
                ...overrides
            })
            .returning()
        return row
    }
    const addAgent = async (
        options: {
            hostId?: string
            userId?: string
            framework?: AgentFramework
            name?: string
            workspace?: string
            config?: string
            reading?: Pick<
                NewAgent,
                'storageBytes' | 'storageMeasuredAt' | 'storageBreakdown'
            >
        } = {}
    ) => {
        const id = createObjectId('agent')
        const owner = options.userId ?? userId
        const host = options.hostId ?? hostId
        const framework = options.framework ?? 'codex'
        let [runtime] = await db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.hostId, host),
                    eq(agentRuntimes.framework, framework)
                )
            )
            .limit(1)
        if (!runtime)
            [runtime] = await db
                .insert(agentRuntimes)
                .values({
                    id: createObjectId('agentRuntime'),
                    userId: owner,
                    name: `${framework} runtime`,
                    framework,
                    kind: 'sprites',
                    hostId: host,
                    status: 'ready',
                    mountPath: options.config ?? '/fixture'
                })
                .returning()
        const rootId =
            frameworkCapability(framework).configHome?.rootId ??
            'framework-config'
        const [row] = await db
            .insert(agents)
            .values({
                id,
                userId: owner,
                name: options.name ?? id,
                framework,
                runtime: 'sprites',
                runtimeId: runtime.id,
                hostId: host,
                internalId: id,
                status: 'running',
                accountId,
                spriteName: 'owned-fixture',
                workspacePath: options.workspace ?? `/fixture/workspaces/${id}`,
                mountPath: options.config ?? `/fixture/workspaces/${id}`,
                fileRoots: options.config
                    ? [
                          {
                              id: rootId,
                              label: 'Config',
                              path: options.config,
                              writable: true
                          }
                      ]
                    : [],
                ...options.reading
            })
            .returning()
        return row
    }
    const access = new RuntimeAccessService(
        db,
        {
            getCachedSpritesEffectiveCap: async () => ({
                activeCap: 1_000_000,
                softThresholdPct: 99,
                policyActiveCap: 1_000_000,
                vendorRunningLimit: null,
                clamped: false
            }),
            isFeatureEnabled: async () => true
        } as never,
        { event() {}, error() {} } as never,
        new SandboxActiveDurationService(db)
    )
    return {
        db,
        client,
        userId,
        hostId,
        accountId,
        sockets,
        requests,
        network,
        origin: `http://127.0.0.1:${address.port}`,
        service,
        finish,
        events,
        failures,
        observations,
        addUser,
        addHost,
        addAgent,
        access,
        peak: () => peak
    }
}
