import {
    MF_RUNTIME_IDENTITY_ENV_KEYS,
    PATH_PREPEND_LOCAL_BIN,
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
    EXTRAS_MARKERS
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
    assert.equal(PATH_PREPEND_LOCAL_BIN, 'export PATH="$HOME/.local/bin:$PATH"')
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
    opts: { identityRows?: unknown[]; runtimeTokens?: unknown } = {}
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
        {} as never,
        {} as never,
        { reserveActiveSlot: async () => {} } as never,
        { measureIfDue: () => {} } as never,
        {} as never,
        { resolveAgentEnv: async () => CONNECTION_MARKERS } as never,
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

test('a daemon agent with no identity row gets one minted on first use', async () => {
    // Agents attached before daemon identity existed have no 'daemon' token
    // row; the factory mints lazily rather than requiring a backfill.
    const minted: Array<Record<string, unknown>> = []
    const factory = buildFactory('daemon', 'claude-code', {
        identityRows: [],
        runtimeTokens: {
            mintRuntimeIdentity: async (args: Record<string, unknown>) => {
                minted.push(args)
                return { plaintext: 'mfr_minted_on_miss' }
            }
        }
    })
    const handle = await factory.forAgent('agt_factory')
    assert.equal(handle.baseEnv?.MF_API_TOKEN, 'mfr_minted_on_miss')
    assert.equal(minted.length, 1)
    assert.equal(minted[0].runtimeKind, 'daemon')
    assert.equal(minted[0].agentId, 'agt_factory')
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
