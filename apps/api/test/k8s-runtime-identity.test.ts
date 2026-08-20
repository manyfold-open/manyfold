import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    auditLogs,
    type NewAgent
} from '@manyfold/db'
import type { K8sBootstrapPlan } from '../src/modules/agents/bootstrap/k8s-framework-bootstrap'
import { K8sAgentOrchestrator } from '../src/modules/agents/orchestration/k8s-agent-orchestrator'

// B1 (k8s) — the runtime identity token is minted from an agent_runtime_tokens
// row whose agent_id FK references agents.id. Unlike sprites (which can write
// the token into the sprite shell-env AFTER provisioning), k8s carries the
// token into the env Secret built at plan() time, so the mint must run BEFORE
// the pod exists. The fix inserts a MINIMAL pending agents row before the mint
// (FK-satisfiable), then finalizes that row with an UPDATE once the pod is
// ready. These tests pin: (a) a pending agents row exists when the mint runs,
// (b) finalize updates rather than re-inserts, (c) a failure after the pending
// insert rolls the runtime back so no orphan agents row / token survives.

const now = new Date('2026-05-22T10:00:00.000Z')

const baseRuntime = () => ({
    id: 'art_k8s_1',
    userId: 'user-1',
    name: 'Core Agent',
    framework: 'claude-code',
    kind: 'k8s',
    status: 'pending',
    accountId: null,
    spriteName: null,
    spriteId: null,
    primaryAgentId: null as string | null,
    mountPath: '/workspace',
    namespace: 'ns-user-1',
    ingressHost: null,
    clusterId: 'k8c_1',
    daemonId: null,
    spriteUrl: null,
    homeDir: null,
    controlUiEnabled: true,
    dashboardEnabled: false,
    currentPhase: null,
    failureReason: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: now,
    updatedAt: now
})

const minimalPlan = (): K8sBootstrapPlan => ({
    framework: 'claude-code',
    port: 8080,
    pvcMountPath: '/data',
    workspacePath: '/data/workspace',
    envSecretData: { MF_AGENT_ID: 'placeholder' },
    readinessProbe: null,
    // null → readiness loop returns as soon as the deployment + ingress are up,
    // so the test never needs a real pod / pod-exec.
    httpReadinessPath: null
})

interface HarnessOpts {
    apiBaseUrl?: string
    mintImpl?: (args: Record<string, unknown>) => Promise<{ plaintext: string }>
    // Inject a failure at a chosen k8s step AFTER the pending insert + mint, to
    // exercise the rollback path.
    failOnCreateSecret?: boolean
    // Simulate a Nest wiring regression: RuntimeTokenService not provided.
    noTokenService?: boolean
}

interface Harness {
    orchestrator: K8sAgentOrchestrator
    db: FakeDb
    mintCalls: Array<{ agentRowCount: number; args: Record<string, unknown> }>
    runtimeDeletes: string[]
    tokenRows: Array<{ agentId: string }>
}

const buildHarness = (opts: HarnessOpts = {}): Harness => {
    const db = new FakeDb()
    const mintCalls: Array<{
        agentRowCount: number
        args: Record<string, unknown>
    }> = []
    const runtimeDeletes: string[] = []
    const tokenRows: Array<{ agentId: string }> = []

    const apis = buildFakeApis(opts.failOnCreateSecret ?? false)

    const k8s = {
        getClient: async () => ({
            clusterId: 'k8c_1',
            hostSuffix: 'example.test',
            apis
        }),
        ensureUserNamespace: async () => 'ns-user-1'
    }

    const claudeCodeK8s = {
        framework: 'claude-code',
        plan: () => minimalPlan()
        // no postProvision → no pod-exec path
    }

    const runtimeToken = {
        mintRuntimeIdentity: async (args: Record<string, unknown>) => {
            // The whole point of B1: at mint time the agents row must already
            // exist (≥ 1) so the agent_runtime_tokens.agent_id FK holds.
            mintCalls.push({ agentRowCount: db.agentRows.length, args })
            const minted = opts.mintImpl
                ? await opts.mintImpl(args)
                : { plaintext: 'nca_rt_k8s_secret' }
            // Mirror the real mint's side effect: a runtime-token row keyed by
            // agentId. Rollback (runtime delete) must FK-cascade this away.
            tokenRows.push({ agentId: args.agentId as string })
            return minted
        }
    }

    const runtimes = {
        reserveRuntime: async () => baseRuntime(),
        applyProvisioningPatch: async () => {},
        findById: async () => baseRuntime(),
        delete: async (id: string) => {
            runtimeDeletes.push(id)
            // FK cascade: deleting the runtime removes the pending agents row
            // and the runtime token keyed by that agent.
            for (const row of db.agentRows.splice(0))
                for (let i = tokenRows.length - 1; i >= 0; i--)
                    if (tokenRows[i].agentId === row.id) tokenRows.splice(i, 1)
        }
    }

    const runtimeAccess = {
        reserveRuntime: async () => baseRuntime()
    }

    const orchestrator = new K8sAgentOrchestrator(
        db as never, // db
        {
            encrypt: (plain: string) => ({
                ciphertext: `enc:${plain}`,
                keyVersion: 7
            })
        } as never, // crypto
        k8s as never, // k8s
        {
            get: (key: string) =>
                key === 'PUBLIC_API_BASE_URL'
                    ? opts.apiBaseUrl
                    : key === 'K8S_IMAGE_CLAUDE_CODE'
                      ? 'img:claude-code'
                      : key === 'K8S_STORAGE_CLASS'
                        ? 'standard'
                        : key === 'K8S_CREATE_TIMEOUT_MS'
                          ? '10000'
                          : undefined
        } as never, // config
        {} as never, // openclaw
        {} as never, // hermes
        claudeCodeK8s as never, // claudeCodeK8s
        {} as never, // codexK8s
        {} as never, // geminiCliK8s
        {} as never, // narraNexusK8s
        {} as never, // podExecFactory
        runtimes as never, // runtimes
        {
            finalizeReady: async () => {}
        } as never, // k8sProvisioner
        {} as never, // adapterRegistry
        {
            resolve: async () => ({
                framework: 'claude-code',
                providerId: 'ump_1',
                value: { anthropicAuthToken: 'sk-ant-test' }
            }),
            maybePersistInline: async () => {}
        } as never, // credentialsResolver
        runtimeAccess as never, // runtimeAccess
        {} as never, // backups
        {
            ensureProviderModelsReady: async () => {},
            updateForAgent: async () => {}
        } as never, // modelConfig
        (opts.noTokenService ? undefined : runtimeToken) as never // runtimeToken (@Optional)
    )

    return { orchestrator, db, mintCalls, runtimeDeletes, tokenRows }
}

const createCtx = {
    userId: 'user-1',
    actorUserId: 'user-1',
    isAdmin: false,
    dto: {
        name: 'Core Agent',
        framework: 'claude-code',
        runtime: 'k8s'
    }
} as never

test('k8s create inserts a pending agents row BEFORE minting the identity (FK-safe order)', async () => {
    const { orchestrator, db, mintCalls } = buildHarness({
        apiBaseUrl: 'https://api.test'
    })

    const result = await orchestrator.create(createCtx)

    assert.equal(result.status, 'running')
    assert.equal(mintCalls.length, 1)
    // The agents row must already be inserted when the mint runs, otherwise the
    // agent_runtime_tokens.agent_id FK would be violated.
    assert.equal(
        mintCalls[0].agentRowCount,
        1,
        'identity mint ran before the pending agents row was inserted — FK would fail'
    )
    assert.equal(mintCalls[0].args.agentId, result.id)
    assert.equal(mintCalls[0].args.runtimeKind, 'k8s')
    // The first op against the agents table is an INSERT, and it precedes the
    // first op against the runtime-token-bearing mint.
    assert.equal(db.agentOps[0]?.kind, 'insert')
    assert.equal(db.agentOps[0]?.values?.status, 'pending')
    assert.equal(db.agentOps[0]?.values?.currentPhase, 'preparing_namespace')
    // Minimal row: provisioning columns are deferred to the finalize UPDATE.
    assert.equal('ingressHost' in (db.agentOps[0]?.values ?? {}), false)
    assert.equal('clusterId' in (db.agentOps[0]?.values ?? {}), false)
})

test('k8s create finalizes the pending row with an UPDATE, not a second INSERT', async () => {
    const { orchestrator, db } = buildHarness({
        apiBaseUrl: 'https://api.test'
    })

    const result = await orchestrator.create(createCtx)

    assert.equal(result.status, 'running')
    // Exactly one INSERT into agents (the pending row); every later mutation is
    // an UPDATE of that same row.
    const inserts = db.agentOps.filter((o) => o.kind === 'insert')
    assert.equal(
        inserts.length,
        1,
        'the agents row must be inserted once (pending) then updated, not re-inserted'
    )
    assert.ok(db.agentOps.some((o) => o.kind === 'update'))
    // Only one physical row ends up in the table.
    assert.equal(db.agentRows.length, 1)
    assert.equal(db.agentRows[0].id, result.id)
    assert.equal(db.agentRows[0].status, 'running')
    // ingressHost was null in the pending row; the finalize UPDATE populated it.
    assert.match(db.agentRows[0].ingressHost as string, /\.example\.test$/)
})

test('k8s create rolls back (no orphan agents row / token) when provisioning fails after the pending insert', async () => {
    const { orchestrator, db, mintCalls, runtimeDeletes, tokenRows } =
        buildHarness({
            apiBaseUrl: 'https://api.test',
            failOnCreateSecret: true
        })

    await assert.rejects(
        () => orchestrator.create(createCtx),
        /k8s agent provisioning failed|createNamespacedSecret/
    )

    // The pending row was inserted and the token minted before the failure...
    assert.equal(mintCalls.length, 1)
    assert.equal(mintCalls[0].agentRowCount, 1)
    // ...and the rollback deleted the runtime, FK-cascading both away.
    assert.equal(runtimeDeletes.length, 1)
    assert.match(runtimeDeletes[0], /^art_/)
    assert.equal(
        db.agentRows.length,
        0,
        'pending agents row must not be orphaned'
    )
    assert.equal(tokenRows.length, 0, 'runtime token must not be orphaned')
})

test('k8s create fails loud when the mint throws under a gated API URL', async () => {
    const { orchestrator, db, runtimeDeletes, tokenRows } = buildHarness({
        apiBaseUrl: 'https://api.test',
        mintImpl: async () => {
            throw new Error('FK violation: agent_id not present')
        }
    })

    await assert.rejects(() => orchestrator.create(createCtx), /FK violation/)

    // The pre-audit prep block deletes the runtime, cascading the pending row.
    assert.equal(runtimeDeletes.length, 1)
    assert.match(runtimeDeletes[0], /^art_/)
    assert.equal(db.agentRows.length, 0)
    assert.equal(tokenRows.length, 0)
})

test('k8s create fails loud when the token service is unwired in a gated env (@Optional absent)', async () => {
    const { orchestrator, db, mintCalls, runtimeDeletes, tokenRows } =
        buildHarness({
            apiBaseUrl: 'https://api.test',
            noTokenService: true
        })

    // PUBLIC_API_BASE_URL is set but RuntimeTokenService is missing — a wiring
    // regression must abort before the Secret is planned, not build a tokenless
    // Secret. The pending row inserted before the check is rolled back.
    await assert.rejects(
        () => orchestrator.create(createCtx),
        /RuntimeTokenService is not wired/
    )
    assert.equal(
        mintCalls.length,
        0,
        'mint must not run without a token service'
    )
    assert.equal(runtimeDeletes.length, 1)
    assert.equal(
        db.agentRows.length,
        0,
        'pending agents row must not be orphaned'
    )
    assert.equal(tokenRows.length, 0)
})

test('k8s create skips the mint (no token) without PUBLIC_API_BASE_URL but still inserts the pending row', async () => {
    const { orchestrator, db, mintCalls } = buildHarness({
        apiBaseUrl: undefined
    })

    const result = await orchestrator.create(createCtx)

    assert.equal(result.status, 'running')
    assert.equal(
        mintCalls.length,
        0,
        'no token may be minted without a reachable API URL'
    )
    // The pending-then-finalize lifecycle is unconditional — only the mint is gated.
    assert.equal(db.agentOps.filter((o) => o.kind === 'insert').length, 1)
    assert.ok(db.agentOps.some((o) => o.kind === 'update'))
    assert.equal(db.agentRows.length, 1)
})

// --- fakes --------------------------------------------------------------------

const buildFakeApis = (failOnCreateSecret: boolean) => ({
    core: {
        createNamespacedSecret: async () => {
            if (failOnCreateSecret)
                throw new Error('createNamespacedSecret boom')
            return {}
        },
        createNamespacedPersistentVolumeClaim: async () => ({}),
        createNamespacedService: async () => ({}),
        listNamespacedPod: async () => ({ items: [] })
    },
    apps: {
        createNamespacedDeployment: async () => ({}),
        readNamespacedDeployment: async () => ({
            status: { availableReplicas: 1 }
        })
    },
    networking: {
        createNamespacedIngress: async () => ({}),
        readNamespacedIngress: async () => ({
            status: { loadBalancer: { ingress: [{ ip: '10.0.0.1' }] } }
        })
    }
})

interface AgentOp {
    kind: 'insert' | 'update'
    values?: Record<string, unknown>
}

class FakeDb {
    agentRows: Array<NewAgent & Record<string, unknown>> = []
    runtimeRows: Array<Record<string, unknown>> = []
    credentialRows: Array<Record<string, unknown>> = []
    auditRows: Array<Record<string, unknown>> = []
    // Ordered log of every operation against the agents table, so a test can
    // assert insert-before-mint and finalize=update without re-reading rows.
    agentOps: AgentOp[] = []

    select(): FakeQuery {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown): FakeQuery {
        return new FakeQuery(this, 'insert', table)
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }

    delete(): FakeQuery {
        return new FakeQuery(this, 'delete')
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
            this.agentOps.push({ kind: 'insert', values })
            const row = {
                status: 'pending',
                mountPath: '/workspace',
                extras: {},
                fileRoots: [],
                spriteStatus: null,
                k8sPodPhase: null,
                clusterId: null,
                namespace: null,
                ingressHost: null,
                workspacePath: null,
                modelProviderId: null,
                storageBytes: null,
                storageMeasuredAt: null,
                ...values,
                createdAt: now,
                updatedAt: now
            }
            this.agentRows.push(
                row as unknown as NewAgent & Record<string, unknown>
            )
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
            if (this.runtimeRows[0]) Object.assign(this.runtimeRows[0], patch)
            return this.runtimeRows.slice(0, 1)
        }
        if (table === agents) {
            this.agentOps.push({ kind: 'update', values: patch })
            if (this.agentRows[0]) Object.assign(this.agentRows[0], patch)
            return this.agentRows.slice(0, 1)
        }
        return []
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private table?: unknown
    private valuesOrPatch: Record<string, unknown> = {}

    constructor(
        private readonly db: FakeDb,
        private readonly kind: 'select' | 'insert' | 'update' | 'delete',
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
