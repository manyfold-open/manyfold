import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'
import { PI_PLATFORM_VIEW_SCRIPT } from '@/modules/agents/credentials/pi-agent-dir'
import { AGY_PLATFORM_VIEW_SCRIPT } from '@/modules/agents/credentials/antigravity-app-dir'

// A sandbox that opted in hands the TUI the credentials a turn would inject:
// claude's token and endpoint, or pi's key under the env var its vendor reads
// together with the platform view its turns run on (and the gateway override
// that lives there).

const dbReturning = (rows: unknown[][]): never => {
    let call = 0
    return {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => rows[call++] ?? []
                })
            })
        })
    } as never
}

const resolveWith = (
    framework: 'pi' | 'claude-code' | 'antigravity-cli' | 'codex',
    payload: Record<string, unknown> | null,
    workspacePath?: string,
    model?: string | null
): ReturnType<TerminalResumeService['resolve']> =>
    new TerminalResumeService(
        dbReturning([
            [{ ref: 'ref-1', inflightMessageId: null }],
            payload ? [{ payloadCiphertext: 'c', keyVersion: 1 }] : []
        ]),
        { decrypt: () => JSON.stringify(payload) } as never
    ).resolve({
        agentId: 'agt_1',
        runtimeId: 'rt_1',
        framework,
        chatSessionId: 'cs_1',
        modelCredentialsAllowed: true,
        injectModelCredentials: true,
        workspacePath,
        model
    })

test('a pi TUI resumes its session on the platform view, with the vendor key under its own env var', async () => {
    const resolved = await resolveWith('pi', {
        apiKey: 'pikey-pikey-pikey',
        provider: 'openai',
        baseUrl: 'https://gw.example/v1'
    })
    assert.equal(resolved.outcome, 'applied')
    assert.deepEqual(resolved.resume?.command, [
        'bash',
        '-c',
        PI_PLATFORM_VIEW_SCRIPT,
        'pi',
        '--session-id',
        'ref-1'
    ])
    const env = resolved.resume?.env ?? {}
    assert.equal(env.OPENAI_API_KEY, 'pikey-pikey-pikey')
    assert.equal(env.PI_OFFLINE, '1')
    assert.equal(env.MF_PI_VIEW, 'rt_1')
    assert.deepEqual(JSON.parse(env.MF_PI_MODELS_JSON), {
        providers: { openai: { baseUrl: 'https://gw.example/v1' } }
    })
})

// The turns trust the workspace the platform fills (--approve), so its TUI
// loads the same skills instead of asking; a workspace of the user's own
// choosing is theirs to trust.
test('a pi TUI trusts a managed workspace as its turns do, and only that one', async () => {
    const creds = { apiKey: 'pikey-pikey-pikey', provider: 'anthropic' }
    const managed = await resolveWith(
        'pi',
        creds,
        '/home/sprite/.manyfold/workspaces/agt_1'
    )
    assert.deepEqual(managed.resume?.command.slice(3), [
        'pi',
        '--session-id',
        'ref-1',
        '--approve'
    ])
    const custom = await resolveWith('pi', creds, '/home/sprite/code/mine')
    assert.deepEqual(custom.resume?.command.slice(3), [
        'pi',
        '--session-id',
        'ref-1'
    ])
})

test('a pi credential that names no vendor leaves a plain shell', async () => {
    const resolved = await resolveWith('pi', { apiKey: 'pikey-pikey-pikey' })
    assert.deepEqual(resolved, {
        resume: null,
        outcome: 'unavailable',
        ref: null
    })
})

test('claude still gets its token, endpoint and persistence flag', async () => {
    const resolved = await resolveWith('claude-code', {
        anthropicAuthToken: 'claude-token-fixture'
    })
    assert.equal(resolved.outcome, 'applied')
    assert.equal(
        resolved.resume?.env.ANTHROPIC_AUTH_TOKEN,
        'claude-token-fixture'
    )
    assert.equal(
        resolved.resume?.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE,
        '1'
    )
})

// Given no --model, Claude Code resumes a session on its last model, the one
// from before a switch; the TUI runs the agent's model as its turns do.
const claudeWithSettings = (
    resolveTurnConfig: () => Promise<unknown>
): ReturnType<TerminalResumeService['resolve']> =>
    new TerminalResumeService(
        dbReturning([
            [{ ref: 'ref-1', inflightMessageId: null }],
            [{ payloadCiphertext: 'c', keyVersion: 1 }]
        ]),
        {
            decrypt: () =>
                JSON.stringify({ anthropicAuthToken: 'claude-token-fixture' })
        } as never,
        { resolveTurnConfig } as never
    ).resolve({
        agentId: 'agt_1',
        userId: 'user-1',
        runtimeId: 'rt_1',
        framework: 'claude-code',
        chatSessionId: 'cs_1',
        modelCredentialsAllowed: true,
        injectModelCredentials: true,
        model: 'haiku'
    })

test("a claude TUI resumes on the agent's model, mapped as on a turn", async () => {
    const resolved = await claudeWithSettings(async () => ({
        modelConfig: {
            framework: 'claude-code',
            model: 'haiku',
            modelMap: { haiku: 'claude-haiku-4-5-20251001' }
        }
    }))
    assert.equal(resolved.outcome, 'applied')
    assert.deepEqual(resolved.resume?.command.slice(-2), ['--model', 'haiku'])
    assert.equal(
        resolved.resume?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        'claude-haiku-4-5-20251001'
    )
    assert.equal(
        resolved.resume?.env.ANTHROPIC_AUTH_TOKEN,
        'claude-token-fixture'
    )
})

test("a claude TUI whose settings cannot be read keeps the session's model", async () => {
    const resolved = await claudeWithSettings(async () => {
        throw new Error('db down')
    })
    assert.equal(resolved.outcome, 'applied')
    assert.equal(resolved.resume?.command.includes('--model'), false)
    assert.equal(
        resolved.resume?.env.ANTHROPIC_AUTH_TOKEN,
        'claude-token-fixture'
    )
})

test('a claude TUI on its own sign-in runs as the machine has it set up', async () => {
    const own = await new TerminalResumeService(
        dbReturning([[{ ref: 'ref-1', inflightMessageId: null }]]),
        { decrypt: () => assert.fail('no platform credentials') } as never,
        {
            resolveTurnConfig: async () =>
                assert.fail('no platform model settings')
        } as never
    ).resolve({
        agentId: 'agt_1',
        userId: 'user-1',
        runtimeId: 'rt_1',
        framework: 'claude-code',
        chatSessionId: 'cs_1',
        modelCredentialsAllowed: true,
        injectModelCredentials: false,
        model: 'haiku'
    })
    assert.equal(own.outcome, 'applied')
    assert.equal(own.resume?.command.includes('--model'), false)
    assert.equal(own.resume?.env.ANTHROPIC_AUTH_TOKEN, undefined)
})

// codex is not logged in on the machine: its TUI resumes on the provider its
// turns run on, the key in the env and the endpoint in `-c` overrides.
test('a codex TUI resumes on the platform provider with the key in its env', async () => {
    const resolved = await resolveWith('codex', {
        openaiApiKey: 'sk-fixture-codex-key',
        openaiBaseUrl: 'https://gw.example/v1'
    })
    assert.equal(resolved.outcome, 'applied')
    const command = resolved.resume?.command ?? []
    assert.deepEqual(command.slice(0, 3), ['codex', 'resume', 'ref-1'])
    assert.ok(command.includes('model_provider="Manyfold"'))
    assert.ok(command.includes('model_providers.Manyfold.base_url="https://gw.example/v1"'))
    assert.ok(command.includes('model_providers.Manyfold.env_key="OPENAI_API_KEY"'))
    assert.ok(!command.some((arg) => arg.includes('sk-fixture-codex-key')))
    assert.equal(resolved.resume?.env.OPENAI_API_KEY, 'sk-fixture-codex-key')
    assert.ok(!command.includes('--model'))
})

// The `-c model_provider` override also stops codex from restoring the
// thread's own model (it would take config.toml's), so the agent's model is
// passed as a turn passes it.
test('a codex TUI resumes on the agent’s model', async () => {
    const resolved = await resolveWith(
        'codex',
        {
            openaiApiKey: 'sk-fixture-codex-key',
            openaiBaseUrl: 'https://gw.example/v1'
        },
        undefined,
        'gpt-6-sol'
    )
    assert.equal(resolved.outcome, 'applied')
    assert.deepEqual((resolved.resume?.command ?? []).slice(-2), [
        '--model',
        'gpt-6-sol'
    ])
})

test('a codex credential without a key leaves a plain shell', async () => {
    const resolved = await resolveWith('codex', { openaiBaseUrl: 'https://gw.example/v1' })
    assert.equal(resolved.outcome, 'unavailable')
    assert.equal(resolved.resume, null)
})

const AGY_REF = '6bce3054-1614-4b63-b9b5-9590cdfc8458'

test('an agy TUI resumes its conversation on the platform view, with the key and the agent’s model', async () => {
    const service = new TerminalResumeService(
        dbReturning([
            [{ ref: AGY_REF, inflightMessageId: null }],
            [{ payloadCiphertext: 'c', keyVersion: 1 }]
        ]),
        {
            decrypt: () =>
                JSON.stringify({
                    googleApiKey: 'gk-marker-marker',
                    googleGeminiBaseUrl: 'https://gw.example/antigravity',
                    model: 'gemini-3.1-pro-low'
                })
        } as never
    )
    const resolved = await service.resolve({
        agentId: 'agt_1',
        runtimeId: 'rt_1',
        framework: 'antigravity-cli',
        chatSessionId: 'cs_1',
        modelCredentialsAllowed: true,
        injectModelCredentials: true,
        model: 'gemini-3.8-flash-high'
    })
    assert.equal(resolved.outcome, 'applied')
    assert.equal(resolved.ref, AGY_REF)
    assert.deepEqual(resolved.resume?.command, [
        'bash',
        '-c',
        AGY_PLATFORM_VIEW_SCRIPT,
        'agy',
        '--conversation',
        AGY_REF,
        '--dangerously-skip-permissions',
        '--model',
        'gemini-3.8-flash-high'
    ])
    const env = resolved.resume?.env ?? {}
    assert.equal(env.GEMINI_API_KEY, 'gk-marker-marker')
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'https://gw.example/antigravity')
    assert.equal(env.MF_AGY_VIEW, 'rt_1')
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
    assert.equal(env.GOOGLE_API_KEY, '')
})

test('an agy TUI without a key leaves a plain shell, and on its own sign-in runs agy as is', async () => {
    const keyless = await resolveWith('antigravity-cli', { model: 'x' })
    assert.equal(keyless.outcome, 'unavailable')
    const own = await new TerminalResumeService(
        dbReturning([[{ ref: AGY_REF, inflightMessageId: null }]]),
        { decrypt: () => 'null' } as never
    ).resolve({
        agentId: 'agt_1',
        runtimeId: 'rt_1',
        framework: 'antigravity-cli',
        chatSessionId: 'cs_1',
        modelCredentialsAllowed: true,
        injectModelCredentials: false
    })
    assert.deepEqual(own.resume, {
        command: [
            'agy',
            '--conversation',
            AGY_REF,
            '--dangerously-skip-permissions'
        ],
        env: {}
    })
})

test('an agy TUI resolves the same custom provider route as a chat turn', async () => {
    const service = new TerminalResumeService(
        dbReturning([
            [{ ref: AGY_REF, inflightMessageId: null }],
            [{ payloadCiphertext: 'c', keyVersion: 1 }]
        ]),
        { decrypt: () => JSON.stringify({ googleApiKey: 'fixture-key' }) } as never,
        { resolveTurnConfig: async (input: unknown) => {
            assert.deepEqual(input, { callerUserId: 'user-1', agentId: 'agt_1', modelConfigSource: 'platform' })
            return { modelConfig: { framework: 'antigravity-cli', model: 'gemini-3.6-flash-medium', providerModel: 'gemini-3.6-flash-medium' } }
        } } as never
    )
    const resolved = await service.resolve({
        agentId: 'agt_1', userId: 'user-1', runtimeId: 'rt_1', framework: 'antigravity-cli',
        chatSessionId: 'cs_1', modelCredentialsAllowed: true, injectModelCredentials: true
    })
    assert.equal(resolved.outcome, 'applied')
    assert.deepEqual(resolved.resume?.command.slice(-2), ['--model', 'manyfold-provider-model'])
    assert.equal(JSON.parse(resolved.resume!.env.MF_AGY_CUSTOM_MODELS_JSON)['manyfold-provider-model'].modelName, 'gemini-3.6-flash-medium')
})
