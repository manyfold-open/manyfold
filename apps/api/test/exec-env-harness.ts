import {
    MF_ENV_AGENT_ID,
    MF_ENV_API_TOKEN,
    MF_ENV_API_URL,
    MF_ENV_DEPLOY_ENV,
    frameworkCapability
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime
} from '@manyfold/shared'
import { runtimeHosts, agentCredentials } from '@manyfold/db'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import { NarraNexusChatAdapter } from '../src/modules/narranexus/narranexus-chat.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// Shared rig for the exec env surface matrix. Deliberately ONE harness rather
// than the usual per-file fakes: three hand-copied marker sets would drift in
// exactly the way this matrix exists to catch.
//
// Everything here is a seam recorder. The adapters under test are the real
// ones, constructed positionally at their current arity — narranexus keeps its
// 7-argument form on purpose, because dropping the registry argument is the
// #555 shape the matrix must be able to see.

export const IDENTITY_MARKERS: Record<string, string> = {
    [MF_ENV_API_TOKEN]: 'mfr_marker_token',
    [MF_ENV_AGENT_ID]: 'agt_marker',
    [MF_ENV_API_URL]: 'https://api.marker.test/api',
    [MF_ENV_DEPLOY_ENV]: 'matrix'
}

export const CONNECTION_MARKERS: Record<string, string> = {
    GH_TOKEN: 'gho_marker',
    GIT_CONFIG_COUNT: '1'
}

// Not an `MF_`-prefixed name on purpose: that prefix is reserved, so agent
// extras can never shadow the platform identity keys.
export const EXTRAS_MARKERS: Record<string, string> = {
    MATRIX_EXTRA: 'extra_marker'
}

// Same composition order as ExecDriverFactory.forAgent's sprites branch.
export const SPRITE_BASE_ENV: Record<string, string> = {
    ...EXTRAS_MARKERS,
    ...CONNECTION_MARKERS,
    ...IDENTITY_MARKERS
}

// What the factory's daemon branch assembles for a coding framework (#781):
// the same identity + connection + extras composition as sprites — a coding
// daemon turn spawns per exec, so nothing distinguishes the two surfaces.
export const DAEMON_BASE_ENV: Record<string, string> = {
    ...EXTRAS_MARKERS,
    ...CONNECTION_MARKERS,
    ...IDENTITY_MARKERS
}

export const PROVIDER_MARKERS = {
    anthropicAuthToken: 'sk-anthropic-marker',
    openaiApiKey: 'sk-openai-marker',
    googleApiKey: 'sk-google-marker',
    openrouterApiKey: 'sk-openrouter-marker'
}

export interface CapturedStream {
    // Which driver served it: the one the factory returned for the agent's
    // runtime, or the daemon driver an adapter swapped in for a runner turn.
    via: 'factory' | 'runner'
    cmd: string[]
    env?: Record<string, string>
    // The env the factory-provided driver carries internally (sprites only);
    // the real SpritesExecDriver merges it under the request env.
    driverEnv?: Record<string, string>
    execHandle?: string
}

export interface CapturedRpc {
    daemonId: string
    method: string
    payload: Record<string, unknown>
    refIdOverride?: string
}

export interface Seam {
    streams: CapturedStream[]
    resumes: Array<{ via: 'runner'; payload: Record<string, unknown> }>
    runnerDrivers: Array<{
        daemonId: string
        baseEnv?: Record<string, string>
    }>
    rpcs: CapturedRpc[]
    gatewayCalls: string[]
}

const emptyHandle = () => ({
    stdout: (async function* (): AsyncGenerator<string> {})(),
    stderr: (async function* (): AsyncGenerator<string> {})(),
    result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    abort: (): void => {},
    lastDeliveredSeq: (): number => 0
})

const captureDriver = (
    seam: Seam,
    via: 'factory' | 'runner',
    driverEnv?: Record<string, string>
) => ({
    stream: (req: {
        cmd: string[]
        env?: Record<string, string>
        execHandle?: string
    }) => {
        seam.streams.push({
            via,
            cmd: req.cmd,
            env: req.env,
            ...(driverEnv ? { driverEnv } : {}),
            ...(req.execHandle ? { execHandle: req.execHandle } : {})
        })
        return emptyHandle()
    },
    resumeStream: (payload: Record<string, unknown>) => {
        seam.resumes.push({ via: 'runner', payload })
        return emptyHandle()
    },
    // The interactive seam (hermes ACP): same capture, plus a handle whose
    // immediately-settled result makes the ACP client fail fast instead of
    // waiting for a handshake nothing will answer.
    streamInteractive: (req: {
        cmd: string[]
        env?: Record<string, string>
    }) => {
        seam.streams.push({
            via,
            cmd: req.cmd,
            env: req.env,
            ...(driverEnv ? { driverEnv } : {})
        })
        return {
            stdout: (async function* (): AsyncGenerator<string> {})(),
            stderr: (async function* (): AsyncGenerator<string> {})(),
            write: (): void => {},
            endInput: (): void => {},
            result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
            abort: (): void => {}
        }
    }
})

// The factory handle each runtime produces. The sprites branch builds the full
// baseEnv; a coding daemon gets the connection + extras env (#781); k8s
// identity lives in the pod Secret and a service/external daemon hands the
// adapter a driver with nothing attached.
const factoryHandleFor = (
    seam: Seam,
    runtime: AgentRuntime,
    framework: AgentFramework
): Record<string, unknown> => {
    const baseEnv =
        runtime === 'sprites'
            ? SPRITE_BASE_ENV
            : runtime === 'daemon' &&
                frameworkCapability(framework).kind === 'coding'
              ? DAEMON_BASE_ENV
              : undefined
    return {
        driver: captureDriver(seam, 'factory', baseEnv),
        creds: {
            anthropicBaseUrl: 'https://anthropic.marker.test',
            anthropicAuthToken: PROVIDER_MARKERS.anthropicAuthToken,
            openaiApiKey: PROVIDER_MARKERS.openaiApiKey,
            googleApiKey: PROVIDER_MARKERS.googleApiKey,
            googleGeminiBaseUrl: null,
            model: null,
            // The hermes shape rides the same blob: an openrouter primary so
            // the alias env (OPENROUTER_API_KEY) is derivable and measurable.
            primaryModelProvider: 'openrouter',
            primaryModelApiKey: PROVIDER_MARKERS.openrouterApiKey,
            primaryModelName: 'marker-model'
        },
        runtime,
        agent: {
            id: 'agt_marker',
            internalId: 'main',
            daemonId: runtime === 'daemon' ? 'dh_byod' : null,
            workspacePath: '/home/sprite/.manyfold/workspaces/agt_marker',
            extras: {}
        },
        ...(baseEnv ? { baseEnv } : {})
    }
}

export const createSeam = (): Seam => ({
    streams: [],
    resumes: [],
    runnerDrivers: [],
    rpcs: [],
    gatewayCalls: []
})

const driversFor = (
    seam: Seam,
    runtime: AgentRuntime,
    framework: AgentFramework
) => ({
    forAgent: async () => factoryHandleFor(seam, runtime, framework),
    daemonDriverFor: (daemonId: string, baseEnv?: Record<string, string>) => {
        seam.runnerDrivers.push({ daemonId, baseEnv })
        return captureDriver(seam, 'runner')
    },
    recoveryFsForAgent: async () => ({
        fs: { locate: async () => null }
    })
})

const registryFor = (seam: Seam) => ({
    streamRpc: (args: {
        daemonId: string
        method: string
        payload: Record<string, unknown>
        refIdOverride?: string
        onEvent?: (kind: string, data: string, seq?: number) => void
    }) => {
        seam.rpcs.push({
            daemonId: args.daemonId,
            method: args.method,
            payload: args.payload,
            ...(args.refIdOverride ? { refIdOverride: args.refIdOverride } : {})
        })
        return {
            refId: args.refIdOverride ?? 'ref_matrix',
            result: Promise.resolve({ exitCode: 0 }),
            cancel: (): void => {}
        }
    }
})

// Serves the queries the service adapters make: the agent row, the
// runtime_hosts row `daemonAdvertisesFeature` reads, and the credentials row
// hermes decrypts for the provider alias env. Discriminating on the table
// means the capability gate and the alias derivation run for real rather than
// being stubbed out.
const dbFor = (opts: {
    runtime: AgentRuntime
    framework: AgentFramework
    clientFeatures: string[]
}) => ({
    select: (): unknown => ({
        from: (table: unknown): unknown => ({
            where: (): unknown => ({
                limit: async (): Promise<unknown[]> =>
                    table === runtimeHosts
                        ? [{ clientFeatures: opts.clientFeatures }]
                        : table === agentCredentials
                          ? [
                                {
                                    payloadCiphertext: JSON.stringify({
                                        primaryModelProvider: 'openrouter',
                                        primaryModelApiKey:
                                            PROVIDER_MARKERS.openrouterApiKey
                                    }),
                                    keyVersion: 1
                                }
                            ]
                          : [
                              {
                                  runtime: opts.runtime,
                                  internalId: 'main',
                                  daemonId:
                                      opts.runtime === 'daemon'
                                          ? 'dh_byod'
                                          : null,
                                  workspacePath:
                                      '/home/sprite/.manyfold/workspaces/agt_marker',
                                  ingressHost: 'gw.marker.test',
                                  runtimeId: 'art_marker',
                                  framework: opts.framework,
                                  name: 'marker',
                                  // The same extras vocabulary the factory
                                  // reads, so an adapter that assembles its own
                                  // payload env (hermes turn.start) is measured
                                  // against the real envText parser.
                                  extras: {
                                      envText: Object.entries(EXTRAS_MARKERS)
                                          .map(([k, v]) => `${k}=${v}`)
                                          .join('\n')
                                  }
                              }
                          ]
            })
        })
    })
})

const adminSettings = {
    isFeatureEnabled: async (): Promise<boolean> => false,
    getCachedChatExecTimeoutMs: async () => ({
        timeoutMs: 1000,
        keepAliveMs: 1000,
        livenessTimeoutMs: 1000
    })
}

const chatRepo = { updateFrameworkSessionRef: async (): Promise<void> => {} }
const pricing = { computeCost: () => ({ costUsd: null, costSource: 'none' }) }
const telemetry = { event: (): void => {} }

export interface AdapterUnderTest {
    sendMessage: (
        ctx: ApiChatAdapterContext,
        message: unknown
    ) => AsyncIterable<EmittedChatEvent>
    resumeMessage?: (
        ctx: ApiChatResumeContext
    ) => AsyncIterable<EmittedChatEvent>
}

export interface BuildOptions {
    framework: AgentFramework
    runtime: AgentRuntime
    clientFeatures?: string[]
    // #555 replay: construct narranexus without the registry argument.
    withRegistry?: boolean
}

export const buildAdapter = (
    seam: Seam,
    opts: BuildOptions
): AdapterUnderTest => {
    const drivers = driversFor(seam, opts.runtime, opts.framework)
    const registry = registryFor(seam)
    const db = dbFor({
        runtime: opts.runtime,
        framework: opts.framework,
        clientFeatures: opts.clientFeatures ?? []
    })
    switch (opts.framework) {
        case 'claude-code':
            return new ClaudeCodeAdapter(
                drivers as never,
                chatRepo as never,
                adminSettings as never
            ) as unknown as AdapterUnderTest
        case 'codex':
            return new CodexAdapter(
                drivers as never,
                chatRepo as never,
                pricing as never,
                adminSettings as never
            ) as unknown as AdapterUnderTest
        case 'gemini-cli':
            return new GeminiCliAdapter(
                drivers as never,
                chatRepo as never,
                pricing as never,
                adminSettings as never
            ) as unknown as AdapterUnderTest
        case 'openclaw':
            return new OpenclawAdapter(
                db as never,
                {} as never,
                pricing as never,
                chatRepo as never,
                drivers as never,
                telemetry as never,
                registry as never,
                adminSettings as never
            ) as unknown as AdapterUnderTest
        case 'hermes':
            return new HermesAdapter(
                db as never,
                // Passthrough decrypt: the alias-env derivation reads the
                // stored blob for real, only the cipher is elided.
                { decrypt: (args: { ciphertext: string }) => args.ciphertext } as never,
                pricing as never,
                registry as never,
                chatRepo as never,
                adminSettings as never,
                undefined as never,
                drivers as never
            ) as unknown as AdapterUnderTest
        case 'narranexus':
            return opts.withRegistry === false
                ? (new NarraNexusChatAdapter(
                      db as never,
                      {} as never,
                      pricing as never,
                      chatRepo as never,
                      drivers as never,
                      telemetry as never
                  ) as unknown as AdapterUnderTest)
                : (new NarraNexusChatAdapter(
                      db as never,
                      {} as never,
                      pricing as never,
                      chatRepo as never,
                      drivers as never,
                      telemetry as never,
                      registry as never,
                      adminSettings as never
                  ) as unknown as AdapterUnderTest)
        default:
            throw new Error(
                `${opts.framework} launches no process; it has no exec seam to drive`
            )
    }
}

// Service adapters resolve gateway credentials by decrypting a stored blob.
// That is the credential path, not the exec env seam, so it is replaced with a
// recorder — the transport choice and payload assembly under test stay real.
// Both service adapters name the method the same way but return different
// shapes, so this covers the union of both.
export const stubGatewayResolution = (adapter: AdapterUnderTest): void => {
    const a = adapter as unknown as Record<string, unknown>
    a.resolveRuntime = async () => ({
        ingressHost: 'gw.marker.test',
        gatewayToken: 'gw_marker_token',
        modelId: 'marker-model',
        displayModel: null,
        apiServerKey: 'gw_marker_key',
        modelName: 'marker-model'
    })
}

// A gateway turn is an HTTP call, not a spawn. Recording it here keeps those
// cells fast and offline while still letting the real transport branch run.
export const withGatewayFetch = async (
    seam: Seam,
    fn: () => Promise<void>
): Promise<void> => {
    const prior = globalThis.fetch
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
        seam.gatewayCalls.push(String(input))
        return new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        })
    }) as typeof globalThis.fetch
    try {
        await fn()
    } finally {
        globalThis.fetch = prior
    }
}

export const adapterCtx = (
    framework: AgentFramework,
    runtime: AgentRuntime,
    extra: Partial<ApiChatAdapterContext> = {}
): ApiChatAdapterContext =>
    ({
        userId: 'user_marker',
        agentId: 'agt_marker',
        runtimeId: 'art_marker',
        sessionId: 'cts_marker',
        messageId: 'msg_marker',
        framework,
        runtimeKind: runtime,
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        ...extra
    }) as unknown as ApiChatAdapterContext

export const resumeCtx = (
    framework: AgentFramework,
    runtime: AgentRuntime,
    extra: Partial<ApiChatResumeContext> = {}
): ApiChatResumeContext =>
    ({
        ...adapterCtx(framework, runtime),
        daemonId: 'dh_carrier',
        daemonExecRef: 'msg_marker',
        fromSeq: 0,
        ...extra
    }) as unknown as ApiChatResumeContext

export const USER_MESSAGE = {
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

export const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    try {
        for await (const ev of it) out.push(ev)
    } catch {
        // A cell may fail downstream of the seam it is asserting (a recorder
        // returns no usable stream). The capture already happened.
    }
    return out
}

export const withEnv = async (
    env: Record<string, string>,
    fn: () => Promise<void>
): Promise<void> => {
    const prior = new Map(
        Object.keys(env).map((k) => [k, process.env[k]] as const)
    )
    Object.assign(process.env, env)
    try {
        await fn()
    } finally {
        for (const [k, v] of prior) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
}

// The env a child on this cell would actually see: what the transport carries
// plus what the request added. Mirrors the merge both real drivers perform.
export const effectiveEnv = (
    stream: CapturedStream,
    runnerBaseEnv?: Record<string, string>
): Record<string, string> => ({
    ...(stream.driverEnv ?? {}),
    ...(runnerBaseEnv ?? {}),
    ...(stream.env ?? {})
})
