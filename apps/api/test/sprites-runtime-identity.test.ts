import { AgentCreateStep } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    auditLogs,
    type NewAgent
} from '@manyfold/db'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import {
    contextOf,
    fakeRuntimeContext,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// The sandbox the provisioner hands back.
const HOST = spritesHostRow({
    id: 'rth_1',
    userId: 'user-1',
    providerRef: { kind: 'sprites', spriteName: 'agt-core-agent', spriteId: 'sprite-1' }
})

// B1 — the runtime identity token is minted from an agent_runtime_tokens row
// whose agent_id FK references agents.id. The mint therefore MUST run AFTER the
// agents row is inserted; minting during provisioning (the old behaviour)
// violated the FK and was swallowed WARN-only, leaving the agent tokenless.
// These tests pin the ordering, the post-insert fail-loud rollback, and the
// no-URL skip that keeps local/non-gated provisions unchanged.

const now = new Date('2026-05-22T10:00:00.000Z')

const baseProvisionedRuntime = () => ({
    id: 'art_1',
    userId: 'user-1',
    name: 'Core Agent',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'pending',
    accountId: 'spa_1',
    spriteName: 'agt-core-agent',
    spriteId: 'sprite-1',
    mountPath: '/repo/project',
    namespace: null,
    ingressHost: null,
    clusterId: null,
    daemonId: null,
    spriteUrl: null,
    homeDir: '/home/sprite',
    currentPhase: null,
    failureReason: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: now,
    updatedAt: now
})

interface OrchestratorHarnessResult {
    service: AgentOrchestratorService
    db: FakeCreateAgentDb
    identityCalls: Array<{
        agentRowCount: number
        args: Record<string, unknown>
    }>
    teardownCalls: string[]
    fakeSpritesClient: object
}

const buildOrchestrator = (opts: {
    identityImpl: (args: Record<string, unknown>) => Promise<void> | void
}): OrchestratorHarnessResult => {
    const db = new FakeCreateAgentDb()
    const provisionedRuntime = baseProvisionedRuntime()
    const fakeSpritesClient = { id: 'spritesClient' }
    const identityCalls: Array<{
        agentRowCount: number
        args: Record<string, unknown>
    }> = []
    const teardownCalls: string[] = []

    // The created agent with its machine, as the orchestrator reads it back.
    const runtimeContext = fakeRuntimeContext((id: string) => {
        const agent = db.agentRows.find((row) => row.id === id)
        return agent
            ? contextOf({
                  agent: agent as never,
                  runtime: provisionedRuntime as never,
                  host: HOST
              })
            : null
    })
    const service = new AgentOrchestratorService(
        db as never,
        {} as never,
        runtimeContext as never,
        {
            encrypt: (plain: string) => ({
                ciphertext: `enc:${plain}`,
                keyVersion: 7
            })
        } as never,
        {} as never,
        {
            provisionRuntime: async (args: Record<string, unknown>) => {
                const emitter = args.emitter as {
                    step(step: AgentCreateStep): void
                }
                emitter.step('selecting_account')
                emitter.step('checking_quota')
                emitter.step('creating_sprite')
                emitter.step('bootstrapping')
                db.runtimeRows.push(provisionedRuntime)
                return {
                    runtime: provisionedRuntime,
                    host: HOST,
                    provider: { id: 'rtp_1', name: 'default' },
                    spritesClient: fakeSpritesClient,
                    homeDir: '/home/sprite'
                }
            },
            installRuntimeIdentity: async (args: Record<string, unknown>) => {
                // Capture how many agents rows exist at the moment the mint is
                // attempted — the whole point of B1 is that this is ≥ 1.
                identityCalls.push({
                    agentRowCount: db.agentRows.length,
                    args
                })
                await opts.identityImpl(args)
            },
            finalizeReady: async () => {},
            teardownRuntime: async (runtime: { id: string }) => {
                teardownCalls.push(runtime.id)
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {
            resolve: async () => ({
                framework: 'claude-code',
                providerId: 'ump_1',
                value: {
                    anthropicAuthToken: 'sk-ant-test',
                    anthropicBaseUrl: 'https://anthropic.example.test'
                }
            }),
            maybePersistInline: async () => {}
        } as never,
        {
            restoreBackupToAgentForCreate: async () => {}
        } as never,
        {} as never,
        {
            ensureProviderModelsReady: async () => {},
            updateForAgent: async () => {}
        } as never,
        {
            getCachedFrameworkRuntimeDefaults: async () => ({
                defaults: { hermes: 'sprites', openclaw: 'sprites' }
            }),
            getCachedFrameworkDefaultVersions: async () => ({ defaults: {} })
        } as never,
        {
            latestForFresh: async () => null
        } as never,
        {
            getFrameworkRuntimeOverrides: async () => ({ overrides: {} })
        } as never,
        {
            get: () => ({
                assignFor: async () => null
            })
        } as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never
    )

    return { service, db, identityCalls, teardownCalls, fakeSpritesClient }
}

const createDto = {
    name: 'Core Agent',
    framework: 'claude-code',
    runtime: 'sprites',
    workspace: '/repo/project',
    claudeCodeCredentials: { providerId: 'ump_1' }
} as never

test('createSprites mints the runtime identity only AFTER the agents row exists (FK-safe order)', async () => {
    const { service, db, identityCalls, teardownCalls } = buildOrchestrator({
        identityImpl: () => {}
    })

    const result = await service.create({
        userId: 'user-1',
        actorUserId: 'user-1',
        isAdmin: false,
        dto: createDto
    })

    assert.equal(result.status, 'ready')
    assert.equal(identityCalls.length, 1)
    // The agents row must already be inserted when the mint runs, otherwise the
    // agent_runtime_tokens.agent_id FK would be violated.
    assert.equal(
        identityCalls[0].agentRowCount,
        1,
        'identity mint ran before the agents row was inserted — FK would fail'
    )
    assert.equal(identityCalls[0].args.agentId, result.id)
    assert.deepEqual(identityCalls[0].args, { userId: 'user-1', agentId: result.id })
    assert.equal(db.credentialRows.length, 1)
    assert.deepEqual(teardownCalls, [])
})

test('createSprites tears the runtime down when identity injection fails (fail-loud)', async () => {
    const { service, teardownCalls } = buildOrchestrator({
        identityImpl: () => {
            throw new Error('mint failed: FK violation')
        }
    })

    await assert.rejects(
        () =>
            service.create({
                userId: 'user-1',
                actorUserId: 'user-1',
                isAdmin: false,
                dto: createDto
            }),
        /mint failed/
    )

    assert.deepEqual(
        teardownCalls,
        ['art_1'],
        'a failed identity injection must roll the half-provisioned runtime back'
    )
})

// --- SpritesProvisioner.installRuntimeIdentity unit gate ----------------------

const provisionerWith = (opts: {
    apiBaseUrl?: string
    runtimeToken?: { mintRuntimeIdentity: (a: unknown) => Promise<unknown> }
}): SpritesProvisioner =>
    new SpritesProvisioner(
        {} as never, // db
        {} as never, // hosts
        {} as never, // hostDaemons
        {} as never, // clients
        {} as never, // placement
        {} as never, // providers
        {} as never, // hostAccess
        {} as never, // tokens
        {} as never, // runtimes
        {} as never, // hostServices
        {} as never, // runtimeAccess
        {
            get: (key: string) =>
                key === 'PUBLIC_API_BASE_URL' ? opts.apiBaseUrl : undefined
        } as never, // config
        { settleHostNotRunning: async () => {} } as never, // activeDuration
        opts.runtimeToken as never // runtimeToken (@Optional)
    )

// The mint encrypts + stores the token for per-exec injection. Nothing writes
// it to the sprite's shared shell profile — co-resident agents on one VM would
// otherwise clash on a single profile identity — and the provisioner has no
// profile writer at all: the bring-up writes the tokenless block.
test('installRuntimeIdentity mints (encrypted) for per-exec injection', async () => {
    const mintArgs: Record<string, unknown>[] = []
    const provisioner = provisionerWith({
        apiBaseUrl: 'https://api.test',
        runtimeToken: {
            mintRuntimeIdentity: async (a: unknown) => {
                mintArgs.push(a as Record<string, unknown>)
                return { plaintext: 'nca_rt_secret' }
            }
        }
    })

    await provisioner.installRuntimeIdentity({
        userId: 'user-1',
        agentId: 'agt_A'
    })

    assert.equal(mintArgs.length, 1)
    assert.deepEqual(mintArgs[0], {
        userId: 'user-1',
        agentId: 'agt_A',
        runtimeKind: 'sprites'
    })
})

test('installRuntimeIdentity throws when the mint fails (gated)', async () => {
    const provisioner = provisionerWith({
        apiBaseUrl: 'https://api.test',
        runtimeToken: {
            mintRuntimeIdentity: async () => {
                throw new Error('FK violation: agent_id not present')
            }
        }
    })

    await assert.rejects(
        () =>
            provisioner.installRuntimeIdentity({
                userId: 'user-1',
                agentId: 'agt_A'
            }),
        /FK violation/
    )
})

test('installRuntimeIdentity skips (no mint, no throw) without PUBLIC_API_BASE_URL', async () => {
    let minted = false
    const provisioner = provisionerWith({
        apiBaseUrl: undefined,
        runtimeToken: {
            mintRuntimeIdentity: async () => {
                minted = true
                return { plaintext: 'nca_rt_secret' }
            }
        }
    })

    await provisioner.installRuntimeIdentity({
        userId: 'user-1',
        agentId: 'agt_A'
    })

    assert.equal(
        minted,
        false,
        'no token may be minted without a reachable API URL'
    )
})

test('installRuntimeIdentity throws when the token service is unwired in a gated env (@Optional absent)', async () => {
    const provisioner = provisionerWith({
        apiBaseUrl: 'https://api.test',
        runtimeToken: undefined
    })

    // PUBLIC_API_BASE_URL is set, so a missing RuntimeTokenService is a wiring
    // regression — fail loud rather than silently provision a tokenless agent.
    await assert.rejects(
        () =>
            provisioner.installRuntimeIdentity({
                userId: 'user-1',
                agentId: 'agt_A'
            }),
        /RuntimeTokenService is not wired/
    )
})

class FakeCreateAgentDb {
    agentRows: Array<NewAgent & Record<string, unknown>> = []
    runtimeRows: Array<Record<string, unknown>> = []
    credentialRows: Array<Record<string, unknown>> = []
    auditRows: Array<Record<string, unknown>> = []

    select(): FakeQuery {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown): FakeQuery {
        return new FakeQuery(this, 'insert', table)
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }

    rowsFor(table: unknown): Record<string, unknown>[] {
        if (table === agents) return this.agentRows
        if (table === agentRuntimes) return this.runtimeRows
        return []
    }

    insertRow(
        table: unknown,
        values: Record<string, unknown>
    ): Record<string, unknown>[] {
        if (table === agents) {
            const row = {
                ...values,
                storageBytes: null,
                storageMeasuredAt: null,
                createdAt: now,
                updatedAt: now
            }
            this.agentRows.push(row as NewAgent & Record<string, unknown>)
            return [row]
        }
        if (table === agentCredentials) {
            this.credentialRows.push(values)
            return [values]
        }
        if (table === auditLogs) {
            this.auditRows.push(values)
            return [values]
        }
        return []
    }

    updateRows(
        table: unknown,
        patch: Record<string, unknown>
    ): Record<string, unknown>[] {
        if (table === agentRuntimes) {
            Object.assign(this.runtimeRows[0], patch)
            return this.runtimeRows.slice(0, 1)
        }
        if (table === agents) {
            Object.assign(this.agentRows[0], patch)
            return this.agentRows.slice(0, 1)
        }
        return []
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private table?: unknown
    private valuesOrPatch: Record<string, unknown> = {}

    constructor(
        private readonly db: FakeCreateAgentDb,
        private readonly kind: 'select' | 'insert' | 'update',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown): this {
        this.table = table
        return this
    }

    where(): this {
        return this
    }

    limit(n: number): Promise<unknown[]> {
        return Promise.resolve(this.resolveRows().slice(0, n))
    }

    values(values: Record<string, unknown>): this {
        this.valuesOrPatch = values
        return this
    }

    set(patch: Record<string, unknown>): this {
        this.valuesOrPatch = patch
        return this
    }

    returning(): Promise<unknown[]> {
        return Promise.resolve(this.resolveRows())
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve(this.resolveRows()).then(onfulfilled, onrejected)
    }

    private resolveRows(): unknown[] {
        if (this.kind === 'select') return this.db.rowsFor(this.table)
        if (this.kind === 'insert')
            return this.db.insertRow(this.table, this.valuesOrPatch)
        if (this.kind === 'update')
            return this.db.updateRows(this.table, this.valuesOrPatch)
        return []
    }
}
