import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { and, eq } from 'drizzle-orm'
import { agentPermissions, agents, runtimeHosts } from '@manyfold/db'
import { createObjectId, apiPaths } from '@manyfold/shared'
import { AuthGuard, type AuthPrincipal } from '../src/common/guards/auth.guard'
import { AuthzService } from '../src/modules/auth/authz.service'
import { RuntimeAccessController } from '../src/modules/runtime-access/runtime-access.controller'
import { AgentDiagnosticsService } from '../src/modules/agents/agent-diagnostics.service'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'
import {
    AgentsController,
    boundAgentIdFromUser
} from '../src/modules/agents/agents.controller'
import { agentRowToSummary } from '../src/modules/agents/agents.service'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { storageFixture, OLD } from './helpers/storage-fixture'

const RUN = process.env.RUN_PG_E2E === '1'

test(
    'mf storage reports preserve self/account scope, cached sleeping bytes, and existing consent denial',
    { skip: !RUN, timeout: 45_000 },
    async (t) => {
        const h = await storageFixture(t)
        const own = await h.addAgent({
            framework: 'openclaw',
            name: 'current-agent',
            config: '/fixture/openclaw',
            workspace: '/fixture/openclaw/workspace',
            reading: {
                storageBytes: 999999,
                storageMeasuredAt: OLD,
                storageBreakdown: {
                    workspaceBytes: 1200,
                    homeBytes: 800,
                    totalBytes: 999999,
                    measuredVia: 'df'
                }
            }
        })
        const peer = await h.addAgent({ name: 'private-peer' })
        await h.db
            .update(runtimeHosts)
            .set({ spriteStatus: 'cold' })
            .where(eq(runtimeHosts.id, h.hostId))
        await h.addHost({
            name: 'Z-largest',
            spriteStatus: 'warm',
            storageBytes: 18000,
            storageMeasuredAt: OLD,
            storageBreakdown: {
                vmUsedBytes: 18000,
                measuredVia: 'df',
                homes: [],
                workspaces: []
            }
        })
        const reflector = new Reflector()
        const authz = new AuthzService(
            reflector,
            h.db,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        const identity = {
            kind: 'agent-runtime' as const,
            userId: h.userId,
            agentId: own.id
        }
        const guard = new AuthGuard(
            { verifyBearerToken: async () => ({ ...identity }) } as never,
            reflector,
            authz
        )
        const controller = new RuntimeAccessController(
            h.access,
            { upsertUser: async () => {} } as never,
            { getUserEmail: async () => null } as never
        )
        let providerReads = 0
        const diagnostics = new AgentDiagnosticsService(
            {
                findForCaller: async (id: string, userId: string) =>
                    (
                        await h.db
                            .select()
                            .from(agents)
                            .where(
                                and(
                                    eq(agents.id, id),
                                    eq(agents.userId, userId)
                                )
                            )
                            .limit(1)
                    )[0]
            } as never,
            new AgentRuntimesService(h.db, { event() {} } as never),
            {
                getById: async () => {
                    providerReads++
                    throw new Error(
                        'sleeping diagnostic must not contact provider'
                    )
                }
            } as never,
            {} as never,
            {} as never,
            {} as never
        )
        const consentRequests: unknown[] = []
        const consentUrl = 'https://fixture.invalid/owner-consent'
        let legacy = false
        let emptyList = false
        const server = createServer((incoming, response) => {
            const handle = async () => {
                const url = new URL(
                    incoming.url ?? '/',
                    'http://fixture.invalid'
                )
                const path = url.pathname.replace(/^\/api(?=\/)/, '')
                const send = (body: unknown) => {
                    if (legacy && body && typeof body === 'object') {
                        const oldAgent = (row: Record<string, unknown>) => {
                            const {
                                workspaceBytes: _bytes,
                                workspaceMeasuredAt: _at,
                                ...rest
                            } = row
                            return {
                                ...rest,
                                storageBytes: 999999,
                                storageMeasuredAt: OLD.toISOString()
                            }
                        }
                        if (Array.isArray(body)) body = body.map(oldAgent)
                        else if (path === `/agents/${own.id}`)
                            body = oldAgent(body as Record<string, unknown>)
                        else if ('scope' in body) {
                            const { scope: _scope, ...rest } = body
                            body = rest
                        }
                    }
                    response.setHeader('content-type', 'application/json')
                    response.end(JSON.stringify(body))
                }
                if (path === '/auth/whoami') {
                    send(identity)
                    return
                }
                if (path === apiPaths.AGENT_PERMISSION_REQUEST(own.id)) {
                    const chunks: Buffer[] = []
                    for await (const chunk of incoming)
                        chunks.push(Buffer.from(chunk))
                    consentRequests.push(
                        JSON.parse(Buffer.concat(chunks).toString())
                    )
                    send({ consentUrl })
                    return
                }
                const selfPrefix = `${apiPaths.ME_RUNTIME_ACCESS_SANDBOX_USAGE}/agent/`
                const isSelf = path.startsWith(selfPrefix)
                const isDiagnostic = path === `/agents/${own.id}/storage-usage`
                const isList = path === '/agents'
                const isGet = path === `/agents/${own.id}`
                if (
                    !isSelf &&
                    !isDiagnostic &&
                    !isList &&
                    !isGet &&
                    path !== apiPaths.ME_RUNTIME_ACCESS_SANDBOX_USAGE
                ) {
                    response.writeHead(404).end()
                    return
                }
                const agentId = isSelf
                    ? decodeURIComponent(path.slice(selfPrefix.length))
                    : isDiagnostic || isGet
                      ? own.id
                      : undefined
                const req = {
                    headers: incoming.headers,
                    params: { agentId, id: agentId },
                    auth: undefined as AuthPrincipal | undefined
                }
                const handler = isSelf
                    ? RuntimeAccessController.prototype.agentSandboxUsage
                    : isDiagnostic
                      ? AgentsController.prototype.storageUsage
                      : isGet
                        ? AgentsController.prototype.get
                        : isList
                          ? AgentsController.prototype.list
                          : RuntimeAccessController.prototype.sandboxUsage
                await guard.canActivate({
                    switchToHttp: () => ({ getRequest: () => req }),
                    getHandler: () => handler,
                    getClass: () =>
                        isDiagnostic || isList || isGet
                            ? AgentsController
                            : RuntimeAccessController
                } as unknown as ExecutionContext)
                assert(req.auth)
                if (isList) {
                    const bound = boundAgentIdFromUser(req.auth)
                    const rows = await h.db
                        .select()
                        .from(agents)
                        .where(
                            and(
                                eq(agents.userId, req.auth.userId),
                                bound ? eq(agents.id, bound) : undefined
                            )
                        )
                    send(
                        emptyList
                            ? []
                            : rows.map((row) => agentRowToSummary(row, null))
                    )
                } else if (isGet) {
                    const [row] = await h.db.select().from(agents).where(and(eq(agents.id, own.id), eq(agents.userId, req.auth.userId))).limit(1)
                    assert(row)
                    send(agentRowToSummary(row, null))
                }
                else if (isDiagnostic)
                    send(
                        await diagnostics.storageUsage(
                            req.auth.userId,
                            own.id,
                            false
                        )
                    )
                else
                    send(
                        isSelf
                            ? await controller.agentSandboxUsage(
                                  req.auth,
                                  agentId!
                              )
                            : await controller.sandboxUsage(req.auth)
                    )
            }
            void handle().catch((error) => {
                const reply = {
                    header: (key: string, value: string) => {
                        response.setHeader(key, value)
                        return reply
                    },
                    status: (status: number) => {
                        response.statusCode = status
                        return reply
                    },
                    send: (body: unknown) => {
                        response.setHeader('content-type', 'application/json')
                        response.end(JSON.stringify(body))
                        return reply
                    }
                }
                new HttpExceptionFilter().catch(error, {
                    switchToHttp: () => ({ getResponse: () => reply })
                } as never)
            })
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        assert(address && typeof address !== 'string')
        const configDir = await mkdtemp(join(tmpdir(), 'manyfold-storage-cli-'))
        t.after(async () => {
            server.closeAllConnections()
            await new Promise<void>((done) => server.close(() => done()))
            await rm(configDir, { recursive: true, force: true })
        })
        const cliRoot = resolve(__dirname, '../../cli')
        const run = async (args: string[]) => {
            const child = spawn(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--import',
                    './test/md-text-loader.mjs',
                    'src/index.ts',
                    ...args
                ],
                {
                    cwd: cliRoot,
                    env: {
                        PATH: process.env.PATH,
                        MF_CONFIG_DIR: configDir,
                        MF_PROFILE: 'fixture',
                        MF_API_URL: `http://127.0.0.1:${address.port}`,
                        MF_API_TOKEN: 'fixture-only',
                        MF_AGENT_ID: own.id,
                        TSX_TSCONFIG_PATH: join(cliRoot, 'tsconfig.json')
                    },
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            )
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', (chunk) => {
                stdout += chunk
            })
            child.stderr.on('data', (chunk) => {
                stderr += chunk
            })
            const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
            try {
                const [code, signal] = await once(child, 'close')
                assert.equal(signal, null, stderr)
                return { code, stdout, stderr }
            } finally {
                clearTimeout(timer)
                child.kill('SIGKILL')
            }
        }
        const self = await run(['sandbox', 'storage-usage', '--json'])
        assert.equal(self.code, 0, self.stderr)
        assert.notEqual(self.stdout.trim(), '', self.stderr)
        const selfData = JSON.parse(self.stdout)
        assert.equal(selfData.scope, 'sandbox')
        assert.equal(selfData.storageBytesTotal, 9000)
        assert.equal(selfData.hosts[0].asleep, true)
        assert.equal(selfData.hosts[0].storageFreshness, 'stale')
        assert.equal(self.stdout.includes(peer.id), false)
        const denied = await run([
            'sandbox',
            'storage-usage',
            '--account',
            '--json'
        ])
        assert.equal(denied.code, 3, denied.stderr)
        assert.equal(denied.stdout, '')
        const denial = JSON.parse(denied.stderr)
        assert.equal(denial.error.consentUrl, consentUrl)
        assert.deepEqual(denial.error.scopes, ['agents:read'])
        assert.deepEqual(consentRequests, [{ scopes: ['agents:read'] }])
        assert.equal('hosts' in denial, false)
        await h.db
            .insert(agentPermissions)
            .values({
                id: createObjectId('agentPermission'),
                agentId: own.id,
                userId: h.userId,
                scopes: ['agents:read']
            })
        const account = await run([
            'sandbox',
            'storage-usage',
            '--account',
            '--json'
        ])
        assert.equal(account.code, 0, account.stderr)
        const report = JSON.parse(account.stdout)
        assert.equal(report.scope, 'account')
        assert.equal(report.storageBytesTotal, 27000)
        assert.equal(report.hosts[0].name, 'Z-largest')
        const list = await run(['agent', 'list', '--json'])
        assert.equal(list.code, 0, list.stderr)
        const listed = JSON.parse(list.stdout)
        assert.equal(listed.scope, 'agent')
        assert.equal(listed.agents.length, 1)
        assert.equal(listed.agents[0].workspaceBytes, 1200)
        assert.equal(listed.agents[0].workspaceMeasuredAt, OLD.toISOString())
        assert.equal('storageBytes' in listed.agents[0], false)
        const diagnostic = await run([
            'agent',
            'storage-usage',
            own.id,
            '--json'
        ])
        assert.equal(diagnostic.code, 0, diagnostic.stderr)
        const paths = JSON.parse(diagnostic.stdout)
        assert.equal(paths.scope, 'agent-paths')
        assert.equal(paths.totalBytes, null)
        assert.equal(paths.cachedSandbox.storageBytes, 9000)
        assert.equal(paths.cachedSandbox.scope, 'sandbox')
        assert.equal(paths.asleep, true)
        assert(
            paths.items.every((item: { bytes: unknown }) => item.bytes === null)
        )
        assert.equal(providerReads, 0)
        assert.equal(h.sockets.length, 0)
        await h.db.update(agents).set({ storageBreakdown: null, storageMeasuredAt: null }).where(eq(agents.id, own.id))
        const unknownWorkspace = await run(['agent', 'get', own.id, '--json'])
        assert.equal(unknownWorkspace.code, 0, unknownWorkspace.stderr)
        assert.equal(JSON.parse(unknownWorkspace.stdout).workspaceBytes, null)
        assert.equal(JSON.parse(unknownWorkspace.stdout).workspaceMeasuredAt, null)
        emptyList = true
        const empty = await run(['agent', 'list', '--json'])
        assert.equal(empty.code, 0, empty.stderr)
        assert.deepEqual(JSON.parse(empty.stdout).agents, [])
        emptyList = false
        legacy = true
        for (const args of [
            ['sandbox', 'storage-usage', '--account', '--json'],
            ['agent', 'list', '--json'],
            ['agent', 'get', own.id, '--json'],
            ['agent', 'storage-usage', own.id, '--json']
        ]) {
            const rejected = await run(args)
            assert.equal(rejected.code, 1)
            assert.equal(rejected.stdout, '')
            assert.match(
                JSON.parse(rejected.stderr).error.message,
                /API does not support the current storage contract/
            )
        }
    }
)
