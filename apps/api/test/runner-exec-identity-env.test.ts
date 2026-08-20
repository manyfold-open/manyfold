import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonExecDriver } from '../src/modules/chat/adapters/daemon-exec-driver'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type { ApiChatAdapterContext } from '../src/modules/chat/chat-adapter'

// #581: a runner-mediated turn swapped the sprite driver (which carries the
// per-agent identity env internally) for a bare DaemonExecDriver, so the child
// started under the shared spriterunner profile with no MF_API_TOKEN and every
// authenticated `mf` call in the turn 401'd. These pin the two halves of the
// fix: the daemon driver merges a per-agent base env UNDER the request env, and
// each framework's runner path hands that base env over when it swaps drivers.

const IDENTITY_ENV = {
    MF_API_TOKEN: 'mfr_agent_token',
    MF_AGENT_ID: 'agt_1',
    MF_API_URL: 'https://api.example/api',
    MF_DEPLOY_ENV: 'staging'
}

// --- Driver level: exec.start payload env -----------------------------------

const driverWithCapture = (baseEnv?: Record<string, string>) => {
    const payloads: Array<{ method: string; payload: Record<string, unknown> }> =
        []
    const registry = {
        streamRpc: (args: {
            method: string
            payload: Record<string, unknown>
        }) => {
            payloads.push({ method: args.method, payload: args.payload })
            return {
                refId: 'ref-1',
                result: Promise.resolve({ exitCode: 0 }),
                cancel: () => {}
            }
        }
    }
    const driver = new DaemonExecDriver(
        registry as unknown as ConstructorParameters<
            typeof DaemonExecDriver
        >[0],
        'dh_runner',
        baseEnv
    )
    return { driver, payloads }
}

test('exec.start merges the per-agent base env under the request env', async () => {
    const { driver, payloads } = driverWithCapture(IDENTITY_ENV)
    const handle = driver.stream({
        cmd: ['claude', '--print'],
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-test' },
        timeoutMs: 1000
    })
    await handle.result
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].method, 'exec.start')
    assert.deepEqual(payloads[0].payload.env, {
        ...IDENTITY_ENV,
        ANTHROPIC_AUTH_TOKEN: 'sk-test'
    })
})

test('request env wins over the base env on key conflicts', async () => {
    // Provider/model env is resolved per turn and must keep overriding whatever
    // the base carries — same precedence as the sprite driver's mergeEnv.
    const { driver, payloads } = driverWithCapture({
        ...IDENTITY_ENV,
        SHARED_KEY: 'base'
    })
    const handle = driver.stream({
        cmd: ['x'],
        env: { SHARED_KEY: 'request' },
        timeoutMs: 1000
    })
    await handle.result
    const env = payloads[0].payload.env as Record<string, string>
    assert.equal(env.SHARED_KEY, 'request')
    assert.equal(env.MF_API_TOKEN, 'mfr_agent_token')
})

test('a driver without a base env forwards the request env unchanged', async () => {
    // The daemon-runtime path (user's own machine, user's own mf login) builds
    // its driver without a base env and must stay exactly as it was.
    const { driver, payloads } = driverWithCapture()
    const handle = driver.stream({
        cmd: ['x'],
        env: { OPENAI_API_KEY: 'sk-1' },
        timeoutMs: 1000
    })
    await handle.result
    assert.deepEqual(payloads[0].payload.env, { OPENAI_API_KEY: 'sk-1' })
})

test('exec.resume carries no env — the running child already has its identity', async () => {
    const { driver, payloads } = driverWithCapture(IDENTITY_ENV)
    const handle = driver.resumeStream({
        refId: 'msg_1',
        fromSeq: 7,
        timeoutMs: 1000
    })
    await handle.result
    assert.equal(payloads[0].method, 'exec.resume')
    assert.equal('env' in payloads[0].payload, false)
})

// --- Adapter level: every framework's runner path hands the base env over ----

const emptyHandle = () => ({
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    abort: () => {},
    lastDeliveredSeq: () => 0
})

const buildDrivers = () => {
    const runnerDrivers: Array<{
        daemonId: string
        baseEnv?: Record<string, string>
    }> = []
    const streamEnvs: Array<Record<string, string> | undefined> = []
    return {
        runnerDrivers,
        streamEnvs,
        drivers: {
            forAgent: async () => ({
                driver: {
                    stream: () => {
                        throw new Error(
                            'runner turn must not use the sprite driver'
                        )
                    }
                },
                creds: {
                    anthropicBaseUrl: 'https://anthropic.example',
                    anthropicAuthToken: 'sk-test',
                    openaiApiKey: 'sk-openai',
                    googleApiKey: 'sk-google',
                    googleGeminiBaseUrl: null,
                    model: null
                },
                runtime: 'sprites' as const,
                agent: {
                    id: 'agt_1',
                    daemonId: null,
                    workspacePath: '/home/sprite/.manyfold/workspaces/agt_1',
                    extras: {}
                },
                baseEnv: IDENTITY_ENV
            }),
            daemonDriverFor: (
                daemonId: string,
                baseEnv?: Record<string, string>
            ) => {
                runnerDrivers.push({ daemonId, baseEnv })
                return {
                    stream: (req: { env?: Record<string, string> }) => {
                        streamEnvs.push(req.env)
                        return emptyHandle()
                    },
                    resumeStream: () => emptyHandle()
                }
            }
        }
    }
}

const adminSettings = {
    isFeatureEnabled: async () => false,
    getCachedChatExecTimeoutMs: async () => ({
        timeoutMs: 1000,
        keepAliveMs: 1000,
        livenessTimeoutMs: 1000
    })
}

const chatRepo = { updateFrameworkSessionRef: async () => {} }

const ctx = (framework: string): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        framework,
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        runnerDaemonId: 'dh_runner'
    }) as unknown as ApiChatAdapterContext

const userMessage = {
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

test('a claude runner turn hands the per-agent base env to the runner driver', async () => {
    const h = buildDrivers()
    const adapter = new ClaudeCodeAdapter(
        h.drivers as never,
        chatRepo as never,
        adminSettings as never
    )
    for await (const _ of adapter.sendMessage(ctx('claude-code'), userMessage))
        void _
    assert.equal(h.runnerDrivers.length, 1)
    assert.equal(h.runnerDrivers[0].daemonId, 'dh_runner')
    assert.deepEqual(h.runnerDrivers[0].baseEnv, IDENTITY_ENV)
    // Provider env still rides the request — identity must MERGE with it (the
    // driver layers them), not replace it.
    assert.equal(h.streamEnvs[0]?.ANTHROPIC_AUTH_TOKEN, 'sk-test')
})

test('a codex runner turn hands the per-agent base env to the runner driver', async () => {
    const h = buildDrivers()
    const adapter = new CodexAdapter(
        h.drivers as never,
        chatRepo as never,
        {} as never,
        adminSettings as never
    )
    for await (const _ of adapter.sendMessage(ctx('codex'), userMessage))
        void _
    assert.equal(h.runnerDrivers.length, 1)
    assert.equal(h.runnerDrivers[0].daemonId, 'dh_runner')
    assert.deepEqual(h.runnerDrivers[0].baseEnv, IDENTITY_ENV)
})

test('a gemini runner turn hands the per-agent base env to the runner driver', async () => {
    const h = buildDrivers()
    const adapter = new GeminiCliAdapter(
        h.drivers as never,
        chatRepo as never,
        {} as never,
        adminSettings as never
    )
    for await (const _ of adapter.sendMessage(ctx('gemini-cli'), userMessage))
        void _
    assert.equal(h.runnerDrivers.length, 1)
    assert.equal(h.runnerDrivers[0].daemonId, 'dh_runner')
    assert.deepEqual(h.runnerDrivers[0].baseEnv, IDENTITY_ENV)
    // Gemini resolves provider creds into the request env; identity merges in
    // at the driver, so the request must still carry the provider key.
    assert.equal(h.streamEnvs[0]?.GEMINI_API_KEY, 'sk-google')
})
