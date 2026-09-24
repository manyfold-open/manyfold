import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'
import { PI_PLATFORM_VIEW_SCRIPT } from '@/modules/agents/credentials/pi-agent-dir'

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
    framework: 'pi' | 'claude-code',
    payload: Record<string, unknown> | null,
    workspacePath?: string
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
        workspacePath
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
