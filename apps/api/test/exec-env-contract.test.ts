import {
    MF_RUNTIME_IDENTITY_ENV_KEYS,
    frameworkCapability,
    listFrameworks,
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

const ALL_FRAMEWORKS: readonly AgentFramework[] = listFrameworks()

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
        for (const runtime of frameworkCapability(framework).runtimes) {
            if (execEnvSurfacesFor(framework, runtime).length === 0)
                missing.push(`${framework} × ${runtime}`)
        }
    }
    assert.deepEqual(missing, [])
})

test('each coding runtime has exactly one daemon-carried surface', () => {
    for (const framework of ALL_FRAMEWORKS) {
        const capability = frameworkCapability(framework)
        if (capability.kind !== 'coding') continue
        for (const runtime of capability.runtimes) {
            const rows = execEnvSurfacesFor(framework, runtime)
            assert.equal(rows.length, 1)
            assert.equal(rows[0].transport, runtime === 'daemon' ? 'daemon-exec' : 'runner-exec')
        }
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
        if (frameworkCapability(framework).kind !== 'external') continue
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
                    if (table === runtimeHosts) return [{ kind: 'daemon', status: 'active', cliVersion: '4.1.0', rpcLastSeenAt: new Date(), clientFeatures: ['turn.openclaw.acp', 'turn.hermes', 'turn.openclaw'] }]
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
        {} as never,
        { reserveActiveSlot: async () => {} } as never,
        { measureIfDue: () => {} } as never,
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
        opts.runtimeTokens as never,
        {
            ensureRunner: async () => ({ handle: { daemonId: 'dh_runner' }, workspace: { outcome: 'base' } }),
            resolvePodRunner: async () => ({ handle: { daemonId: 'dh_runner' }, workspace: { outcome: 'base' } })
        } as never
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
    // #782 in one assertion. A pod host's Secret carries only its daemon's
    // enrolment, and one host carries several agents (ADR-0035) — so a turn
    // carried by the host's runner has to be handed the per-agent env.
    await withEnv({}, async () => {
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

test('a k8s coding agent with no identity row gets one ensured on first use', async () => {
    // A pod host bakes no identity into its Secret (ADR-0035): a k8s turn gets
    // the same lazily minted, rotatable token as a sprite or daemon turn.
    const ensured: Array<Record<string, unknown>> = []
    const factory = buildFactory('k8s', 'claude-code', {
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
    assert.equal(ensured[0].runtimeKind, 'k8s')
    assert.equal(ensured[0].agentId, 'agt_factory')
})

test('a k8s service agent still gets no platform base env', async () => {
    // Symmetric with the BYOD daemon case below: only coding frameworks take
    // the pod-runner transport, so assembling an env for a service framework
    // would build a channel nothing reads.
    await withEnv({}, async () => {
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
