import test from 'node:test'
import assert from 'node:assert/strict'
import { NarraNexusAgentAdapter } from '../src/modules/narranexus/narranexus-agent.adapter'

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'narranexus',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    primaryAgentId: 'agent-1',
    mountPath: null,
    namespace: null,
    ingressHost: 'narranexus.example.com',
    clusterId: null,
    spriteUrl: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const credentialRow = { payloadCiphertext: 'ct', keyVersion: 1 }

const makeDb = (rows: Array<Record<string, unknown>>) => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => rows
            })
        })
    })
})

const fakeCrypto = {
    decrypt: () => JSON.stringify({ gatewayToken: 'tok' })
}

const makeAdapter = (rows: Array<Record<string, unknown>> = [credentialRow]) =>
    new NarraNexusAgentAdapter(makeDb(rows) as never, fakeCrypto as never)

const fetchResponse = (status: number, body: string) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body
})

const withFetch = async (
    stub: () => Promise<unknown>,
    fn: () => Promise<void>
) => {
    const orig = globalThis.fetch
    globalThis.fetch = stub as never
    try {
        await fn()
    } finally {
        globalThis.fetch = orig
    }
}

const rejectFetch = async (): Promise<unknown> => {
    throw new Error('fetch must not be called in this scenario')
}

// Returning [] when the runtime has no ingress host told reconcile that
// every agent was deleted — the #108 root cause. Enumeration must throw.
test('listAgents throws when the runtime has no ingress host', async () => {
    const adapter = makeAdapter()
    await withFetch(rejectFetch, async () => {
        await assert.rejects(
            adapter.listAgents({
                runtime: fakeRuntime({ ingressHost: null }) as never,
                primaryAgentId: null
            }),
            /no ingress host/,
            'missing ingress host returned [] before fix A, telling reconcile every agent was deleted (#108 root cause)'
        )
    })
})

// A missing/undecryptable gateway token means we cannot ask the runtime
// anything — that must never read as "the runtime has zero agents"
test('listAgents throws when no gateway token credential row exists', async () => {
    const adapter = makeAdapter([])
    await withFetch(rejectFetch, async () => {
        await assert.rejects(
            adapter.listAgents({
                runtime: fakeRuntime() as never,
                primaryAgentId: null
            }),
            /missing gateway token/,
            'a runtime we cannot authenticate to must reject, not report zero agents'
        )
    })
})

// 'cannot reach the service' must be distinguishable from 'service says empty'
test('listAgents throws on non-2xx response', async () => {
    const adapter = makeAdapter()
    await withFetch(
        async () => fetchResponse(502, 'Bad Gateway'),
        async () => {
            await assert.rejects(
                adapter.listAgents({
                    runtime: fakeRuntime() as never,
                    primaryAgentId: null
                }),
                /status 502/,
                "'cannot reach the service' must be distinguishable from 'service says empty'"
            )
        }
    )
})

// A 200 error envelope without a data array is the same bug class as the
// swallowed errors: it must throw, not read as "zero agents"
test('listAgents throws on 200 response without a data array', async () => {
    const adapter = makeAdapter()
    await withFetch(
        async () => fetchResponse(200, '{"object":"list"}'),
        async () => {
            await assert.rejects(
                adapter.listAgents({
                    runtime: fakeRuntime() as never,
                    primaryAgentId: null
                }),
                /unexpected response shape/,
                'a 200 without a data array is an error envelope, not an empty agent list'
            )
        }
    )
})

// Success regression: a well-formed listing still maps to FrameworkAgent rows
test('listAgents maps a 200 response with agents', async () => {
    const adapter = makeAdapter()
    await withFetch(
        async () => fetchResponse(200, '{"data":[{"agent_id":"a1"}]}'),
        async () => {
            const agents = await adapter.listAgents({
                runtime: fakeRuntime() as never,
                primaryAgentId: null
            })
            assert.equal(agents.length, 1, 'one row maps to one agent')
            assert.equal(agents[0].id, 'a1')
            assert.equal(agents[0].name, 'a1', 'name falls back to agent_id')
            // /manyfold/agents reports no working path, and the layout under
            // BASE_WORKING_PATH is NarraNexus's to change — it already did.
            // Deriving one here is what pointed every file call at a directory
            // outside the workspace; reconcile keeps the row's existing value
            // and FilesContextBuilder backfills the resolved one.
            assert.equal(
                agents[0].workspace,
                null,
                'the adapter must not invent a workspace path'
            )
            assert.equal(agents[0].model, null)
        }
    )
})

// Confirmed-empty is the ONLY legal empty result; the fresh-boot 200+[]
// race is guarded by reconcile confirmation (fix B), not by the adapter
test('listAgents returns [] only when the runtime confirms zero agents', async () => {
    const adapter = makeAdapter()
    await withFetch(
        async () => fetchResponse(200, '{"data":[]}'),
        async () => {
            const agents = await adapter.listAgents({
                runtime: fakeRuntime() as never,
                primaryAgentId: null
            })
            assert.deepEqual(
                agents,
                [],
                'a confirmed 200 with data: [] is the only path allowed to report empty'
            )
        }
    )
})
