import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'

// A sandbox that opted in hands the TUI the credentials a turn would inject:
// claude's token and endpoint, or pi's key under the env var its vendor reads
// (pi's gateway, if any, is the models.json already on the sandbox).

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
    payload: Record<string, unknown> | null
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
        injectModelCredentials: true
    })

test('a pi TUI resumes its session with the vendor key under its own env var', async () => {
    const resolved = await resolveWith('pi', {
        apiKey: 'pikey-pikey-pikey',
        provider: 'openai',
        baseUrl: 'https://gw.example/v1'
    })
    assert.equal(resolved.outcome, 'applied')
    assert.deepEqual(resolved.resume, {
        command: ['pi', '--session-id', 'ref-1'],
        env: { OPENAI_API_KEY: 'pikey-pikey-pikey', PI_OFFLINE: '1' }
    })
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
