import {
    MF_RUNTIME_IDENTITY_ENV_KEYS,
    agentFramework,
    frameworkCapabilities,
    supportsRuntime
} from '@manyfold/shared'
import type { AgentFramework } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agentCredentials,
    agentRuntimeTokens,
    agents,
    runtimeHosts
} from '@manyfold/db'
import {
    execEnvSurfaceKey,
    execEnvSurfaces,
    execEnvSurfacesFor
} from './exec-env-contract'
import {
    ExecDriverFactory,
    manyfoldRuntimeEnv
} from '../src/modules/chat/adapters/exec-driver-factory'
import { ChatAdapterRegistry } from '../src/modules/chat/adapters/adapter-registry.service'
import {
    buildAdapter,
    createSeam,
    CONNECTION_MARKERS,
    EXTRAS_MARKERS,
    withEnv
} from './exec-env-harness'

const ALL_FRAMEWORKS = Object.values(agentFramework) as AgentFramework[]

// Integrity of the exec env surface contract itself: that the vocabulary is
// pinned, that the table covers every framework × runtime the platform claims
// to support, and that what the factory actually assembles per runtime is what
// the rows say it assembles. The per-cell behavioural checks live in
// exec-env-matrix.test.ts and exec-env-matrix-turn-rpc.test.ts.

test('the identity env vocabulary is pinned', () => {
    // Every other file in the matrix imports these constants, so this is the
    // one place a rename has to be argued for. The CLI reads the same names
    // back out of its process env.
    assert.deepEqual(
        [...MF_RUNTIME_IDENTITY_ENV_KEYS],
        ['MF_API_TOKEN', 'MF_AGENT_ID', 'MF_API_URL', 'MF_DEPLOY_ENV']
    )
})

test('every surface is declared once and targets a supported runtime', () => {
    const seen = new Set<string>()
    for (const surface of execEnvSurfaces) {
        const key = execEnvSurfaceKey(surface)
        assert.equal(seen.has(key), false, `duplicate surface row: ${key}`)
        seen.add(key)
        assert.equal(
            supportsRuntime(surface.framework, surface.runtime),
            true,
            `${key} declares a runtime the framework does not support`
        )
    }
})

test('every framework × supported runtime has at least one declared surface', () => {
    // The universe comes from the shared capability table, which is a
    // Record<AgentFramework, ...> — so a new framework or a newly supported
    // runtime cannot be added without landing here first.
    const missing: string[] = []
    for (const framework of ALL_FRAMEWORKS) {
        for (const runtime of frameworkCapabilities[framework].runtimes) {
            if (execEnvSurfacesFor(framework, runtime).length === 0)
                missing.push(`${framework} × ${runtime}`)
        }
    }
    assert.deepEqual(missing, [])
})

test('a coding framework on sprites declares both its direct and runner surfaces', () => {
    // The runner allowlist is framework-agnostic: any sprite coding turn can be
    // carried by that sprite's runner. A coding framework with a sprite-exec row
    // but no runner-exec row is precisely the blind spot #581 lived in.
    for (const framework of ALL_FRAMEWORKS) {
        const capability = frameworkCapabilities[framework]
        if (capability.kind !== 'coding') continue
        if (!capability.runtimes.includes('sprites')) continue
        const transports = execEnvSurfacesFor(framework, 'sprites').map(
            (surface) => surface.transport
        )
        assert.ok(
            transports.includes('sprite-exec'),
            `${framework} × sprites is missing its sprite-exec surface`
        )
        assert.ok(
            transports.includes('runner-exec'),
            `${framework} × sprites is missing its runner-exec surface`
        )
    }
})

test('a coding framework on k8s declares both its direct and runner surfaces', () => {
    // The k8s twin of the sprites ratchet above, and it exists for the same
    // reason: the pod-runner transport is the one that carries identity,
    // connection and extras env, so a framework that grows a pod-exec row
    // without a runner-exec row is a cell nobody would notice was never
    // wired — exactly #581's blind spot, one runtime over.
    for (const framework of ALL_FRAMEWORKS) {
        const capability = frameworkCapabilities[framework]
        if (capability.kind !== 'coding') continue
        if (!capability.runtimes.includes('k8s')) continue
        const transports = execEnvSurfacesFor(framework, 'k8s').map(
            (surface) => surface.transport
        )
        assert.ok(
            transports.includes('pod-exec'),
            `${framework} × k8s is missing its pod-exec surface`
        )
        assert.ok(
            transports.includes('runner-exec'),
            `${framework} × k8s is missing its runner-exec surface`
        )
    }
})

test('every runner-exec surface carries the full per-exec base env', () => {
    // What the transport swap is FOR. A runner-exec row that declares any of
    // the three groups absent is a row that silently reintroduces #581: the
    // swapped transport would dispatch a child with less env than the direct
    // transport it replaced.
    for (const surface of execEnvSurfaces) {
        if (surface.transport !== 'runner-exec') continue
        assert.deepEqual(
            [surface.identity, surface.connections, surface.extras],
            ['per-exec', 'per-exec', 'per-exec'],
            `${execEnvSurfaceKey(surface)} must carry identity, connections and extras per exec`
        )
        assert.equal(
            surface.resume,
            'attach-no-env',
            `${execEnvSurfaceKey(surface)} is carried by a daemon, so it is resumable`
        )
    }
})

test('external frameworks declare exactly one all-absent provider surface', () => {
    for (const framework of ALL_FRAMEWORKS) {
        if (frameworkCapabilities[framework].kind !== 'external') continue
        const rows = execEnvSurfaces.filter(
            (surface) => surface.framework === framework
        )
        assert.equal(rows.length, 1, `${framework} should declare one surface`)
        const [row] = rows
        assert.equal(row.transport, 'provider-http')
        assert.deepEqual(
            [
                row.identity,
                row.connections,
                row.extras,
                row.providerCreds,
                row.path,
                row.resume
            ],
            ['none', 'none', 'none', 'none', 'not-applicable', 'none'],
            `${framework} launches no process; every group must be an explicit absence`
        )
    }
})

test('every framework with an exec surface is registered in the chat adapter registry', () => {
    const seam = createSeam()
    const stub = (framework: AgentFramework): never =>
        ({ framework }) as unknown as never
    const registry = new ChatAdapterRegistry(
        stub('claude-code'),
        buildAdapter(seam, {
            framework: 'claude-code',
            runtime: 'sprites'
        }) as never,
        buildAdapter(seam, {
            framework: 'openclaw',
            runtime: 'sprites'
        }) as never,
        buildAdapter(seam, { framework: 'codex', runtime: 'sprites' }) as never,
        buildAdapter(seam, {
            framework: 'gemini-cli',
            runtime: 'sprites'
        }) as never,
        buildAdapter(seam, { framework: 'pi', runtime: 'sprites' }) as never,
        buildAdapter(seam, {
            framework: 'hermes',
            runtime: 'sprites'
        }) as never,
        buildAdapter(seam, {
            framework: 'narranexus',
            runtime: 'sprites'
        }) as never,
        stub('dify'),
        stub('langflow'),
        stub('a2a')
    )
    for (const framework of ALL_FRAMEWORKS) {
        assert.equal(
            registry.has(framework),
            true,
            `${framework} has declared exec surfaces but no registered adapter`
        )
    }
})

// --- What the factory actually assembles, per runtime ------------------------

const IDENTITY_TOKEN = 'mfr_factory_token'

const factoryDb = (
    runtime: string,
    framework: string,
    identityRows?: unknown[]
) => ({
    select: (): unknown => ({
        from: (table: unknown): unknown => ({
            where: (): unknown => ({
                limit: async (): Promise<unknown[]> => {
                    if (table === agentCredentials)
                        return [{ payloadCiphertext: 'cipher', keyVersion: 0 }]
                    if (table === agentRuntimeTokens)
                        return (
                            identityRows ?? [
                                {
                                    ciphertext: 'identity-cipher',
                                    keyVersion: 0
                                }
                            ]
                        )
                    if (table === runtimeHosts) return [{ clientFeatures: [] }]
                    if (table === agents)
                        return [
                            {
                                id: 'agt_factory',
                                userId: 'user_factory',
                                runtime,
                                framework,
                                runtimeId: 'art_factory',
                                accountId: 'sac_factory',
                                spriteName: 'sprite-factory',
                                hostId: 'rth_factory',
                                daemonId:
                                    runtime === 'daemon' ? 'dh_byod' : null,
                                namespace:
                                    runtime === 'k8s' ? 'ns-factory' : null,
                                clusterId:
                                    runtime === 'k8s' ? 'clus_factory' : null,
                                workspacePath: '/workspace',
                                extras: {
                                    envText: `${Object.entries(EXTRAS_MARKERS)
                                        .map(([k, v]) => `${k}=${v}`)
                                        .join('\n')}`
                                }
                            }
                        ]
                    return []
                }
            })
        })
    })
})

const buildFactory = (
    runtime: string,
    framework = 'claude-code',
    opts: {
        identityRows?: unknown[]
        runtimeTokens?: unknown
        onConnectionEnv?: () => void
    } = {}
): ExecDriverFactory =>
    new ExecDriverFactory(
        factoryDb(runtime, framework, opts.identityRows) as never,
        {
            getById: async () => ({ slug: 'acct', id: 'sac_factory' }),
            decryptToken: () => 'sprites-token'
        } as never,
        {
            decrypt: ({ ciphertext }: { ciphertext: string }) =>
                ciphertext === 'identity-cipher'
                    ? IDENTITY_TOKEN
                    : JSON.stringify({ anthropicAuthToken: 'sk-factory' })
        } as never,
        // k8s: enough of a client + pod lookup for the arm to reach its return.
        // The pod-exec transport itself is not what these tests pin — the env
        // the handle EXPOSES for the transport swap is.
        {
            getClient: async () => ({
                apis: {
                    core: {
                        listNamespacedPod: async () => ({
                            items: [
                                {
                                    metadata: { name: 'pod-factory' },
                                    status: { phase: 'Running' }
                                }
                            ]
                        })
                    }
                }
            })
        } as never,
        { forClient: () => ({}) } as never,
        {} as never,
        { reserveActiveSlot: async () => {} } as never,
        { measureIfDue: () => {} } as never,
        {} as never,
        {
            resolveAgentEnv: async () => {
                opts.onConnectionEnv?.()
                return CONNECTION_MARKERS
            }
        } as never,
        {
            get: (key: string) =>
                key === 'PUBLIC_API_BASE_URL'
                    ? 'https://api.factory.test'
                    : 'staging'
        } as never,
        undefined,
        opts.runtimeTokens as never
    )

test('a sprites agent gets the full per-exec base env, exposed for transport swaps', async () => {
    // The #581 root cause in one assertion: this base env is what a runner turn
    // must carry over when it replaces the sprite driver.
    const handle = await buildFactory('sprites').forAgent('agt_factory')
    assert.equal(handle.runtime, 'sprites')
    const baseEnv = handle.baseEnv ?? {}
    for (const key of MF_RUNTIME_IDENTITY_ENV_KEYS)
        assert.ok(baseEnv[key], `sprites base env is missing ${key}`)
    assert.equal(baseEnv.MF_API_TOKEN, IDENTITY_TOKEN)
    for (const [key, value] of Object.entries(CONNECTION_MARKERS))
        assert.equal(baseEnv[key], value, `connection env ${key} not carried`)
    for (const [key, value] of Object.entries(EXTRAS_MARKERS))
        assert.equal(baseEnv[key], value, `agent extras ${key} not carried`)
})

test('a BYOD daemon coding agent gets the full per-exec base env', async () => {
    // #781: identity, connection tokens and the user's env text now ride each
    // daemon exec, exactly like sprites.
    const handle = await buildFactory('daemon').forAgent('agt_factory')
    assert.equal(handle.runtime, 'daemon')
    const baseEnv = handle.baseEnv ?? {}
    for (const key of MF_RUNTIME_IDENTITY_ENV_KEYS)
        assert.ok(baseEnv[key], `daemon base env is missing ${key}`)
    assert.equal(baseEnv.MF_API_TOKEN, IDENTITY_TOKEN)
    for (const [key, value] of Object.entries(CONNECTION_MARKERS))
        assert.equal(baseEnv[key], value, `connection env ${key} not carried`)
    for (const [key, value] of Object.entries(EXTRAS_MARKERS))
        assert.equal(baseEnv[key], value, `agent extras ${key} not carried`)
})

test('a k8s coding agent exposes the base env a pod-runner turn swaps onto', async () => {
    // #782 in one assertion. The pod Secret is baked once at provision and
    // carries no connection env or extras at all, and its MF_AGENT_ID names
    // whichever agent provisioned the pod — so a turn carried by the pod's own
    // runner has to be handed the per-agent env instead of inheriting it.
    await withEnv({ MF_POD_RUNNER_AGENTS: '*' }, async () => {
        const handle = await buildFactory('k8s').forAgent('agt_factory')
        assert.equal(handle.runtime, 'k8s')
        const baseEnv = handle.baseEnv ?? {}
        for (const key of MF_RUNTIME_IDENTITY_ENV_KEYS)
            assert.ok(baseEnv[key], `k8s base env is missing ${key}`)
        assert.equal(baseEnv.MF_API_TOKEN, IDENTITY_TOKEN)
        assert.equal(baseEnv.MF_AGENT_ID, 'agt_factory')
        for (const [key, value] of Object.entries(CONNECTION_MARKERS))
            assert.equal(
                baseEnv[key],
                value,
                `connection env ${key} not carried`
            )
        for (const [key, value] of Object.entries(EXTRAS_MARKERS))
            assert.equal(baseEnv[key], value, `agent extras ${key} not carried`)
    })
})

test('a k8s coding agent outside the pod-runner rollout pays for no base env', async () => {
    // The connection env is a network mint (a GitHub installation token) and
    // seven call sites reach forAgent per turn. With the transport swap not
    // even possible for this agent, assembling the env would be pure cost on
    // the pod-exec hot path — and the pod-exec driver never receives it.
    await withEnv({ MF_POD_RUNNER_AGENTS: '' }, async () => {
        let connectionMints = 0
        const factory = buildFactory('k8s', 'claude-code', {
            onConnectionEnv: () => {
                connectionMints++
            }
        })
        const handle = await factory.forAgent('agt_factory')
        assert.equal(handle.runtime, 'k8s')
        assert.equal(handle.baseEnv, undefined)
        assert.equal(connectionMints, 0, 'no GitHub token minted for nothing')
    })
})

test('a k8s coding agent whose active identity cannot be decrypted is never rotated', async () => {
    // The pod is running on the identity its Secret was provisioned with. A
    // legacy row with no ciphertext used to trigger ensure→mint→REVOKE of that
    // very token; the pod then 401s on every `mf` call under the default
    // pod-exec transport. The read-through path must leave it alone.
    await withEnv({ MF_POD_RUNNER_AGENTS: '*' }, async () => {
        const ensured: unknown[] = []
        let readOrMintCalls = 0
        const factory = buildFactory('k8s', 'claude-code', {
            identityRows: [{ ciphertext: null, keyVersion: null }],
            runtimeTokens: {
                ensureRuntimeIdentity: async (args: unknown) => {
                    ensured.push(args)
                    return { plaintext: 'mfr_rotated' }
                },
                readOrMintRuntimeIdentity: async () => {
                    readOrMintCalls++
                    return null
                }
            }
        })
        const handle = await factory.forAgent('agt_factory')
        assert.equal(ensured.length, 0, 'the rotating path must not be used')
        assert.equal(readOrMintCalls, 1)
        assert.equal(
            'MF_API_TOKEN' in (handle.baseEnv ?? {}),
            false,
            "no per-exec token: the daemon inherits the Secret's"
        )
        // The rest of the identity still rides the swap.
        assert.equal(handle.baseEnv?.MF_AGENT_ID, 'agt_factory')
    })
})

test('a k8s service agent still gets no platform base env', async () => {
    // Symmetric with the BYOD daemon case below: only coding frameworks take
    // the pod-runner transport, so assembling an env for a service framework
    // would build a channel nothing reads.
    await withEnv({ MF_POD_RUNNER_AGENTS: '*' }, async () => {
        const handle = await buildFactory('k8s', 'openclaw').forAgent(
            'agt_factory'
        )
        assert.equal(handle.runtime, 'k8s')
        assert.equal(handle.baseEnv, undefined)
    })
})

test('a daemon agent with no identity row gets one ensured on first use', async () => {
    // Agents attached before daemon identity existed have no 'daemon' token
    // row; the factory ensures one lazily rather than requiring a backfill.
    const ensured: Array<Record<string, unknown>> = []
    const factory = buildFactory('daemon', 'claude-code', {
        identityRows: [],
        runtimeTokens: {
            ensureRuntimeIdentity: async (args: Record<string, unknown>) => {
                ensured.push(args)
                return { plaintext: 'mfr_minted_on_miss' }
            }
        }
    })
    const handle = await factory.forAgent('agt_factory')
    assert.equal(handle.baseEnv?.MF_API_TOKEN, 'mfr_minted_on_miss')
    assert.equal(ensured.length, 1)
    assert.equal(ensured[0].runtimeKind, 'daemon')
    assert.equal(ensured[0].agentId, 'agt_factory')
})

test('a BYOD daemon service agent still gets no platform base env', async () => {
    // openclaw's daemon turn payload has no env channel a resident service
    // would read (#783), so handing its driver a base env would dispatch env
    // the contract declares absent.
    const handle = await buildFactory('daemon', 'openclaw').forAgent(
        'agt_factory'
    )
    assert.equal(handle.runtime, 'daemon')
    assert.equal(handle.baseEnv, undefined)
})

test('the runtime identity helper emits the non-secret identity keys', () => {
    const env = manyfoldRuntimeEnv(
        {
            get: (key: string) =>
                key === 'PUBLIC_API_BASE_URL'
                    ? 'https://api.factory.test'
                    : 'staging'
        } as never,
        'agt_factory'
    )
    assert.equal(env.MF_AGENT_ID, 'agt_factory')
    assert.equal(env.MF_API_URL, 'https://api.factory.test/api')
    assert.ok(env.MF_DEPLOY_ENV)
    // The token is deliberately not here: it is decrypted per agent per exec.
    assert.equal('MF_API_TOKEN' in env, false)
})
