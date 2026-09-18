import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import {
    TerminalHookController,
    parseTerminalSessionHookRequest
} from '../src/modules/terminal/terminal-hook.controller'

const VALID = {
    framework: 'claude-code',
    event: 'start',
    source: 'startup',
    sessionRef: '4f3c1d2e-aaaa-4bbb-8ccc-1234567890ab',
    cwd: '/home/me/project'
}

test('a well-formed report parses and drops what the API does not accept', () => {
    const parsed = parseTerminalSessionHookRequest({
        ...VALID,
        transcriptPath: '/home/me/.claude/projects/x.jsonl',
        terminalId: 'tms_forged'
    })
    assert.deepEqual(parsed, VALID)
})

test('shape violations are 400s with a stable code', () => {
    for (const bad of [
        { ...VALID, framework: 'gemini-cli' },
        { ...VALID, event: 'stop' },
        { ...VALID, source: 'teleport' },
        { ...VALID, sessionRef: '../../etc/passwd' },
        { ...VALID, sessionRef: 'ab' },
        { ...VALID, cwd: 'x'.repeat(5000) },
        null,
        'string'
    ])
        assert.throws(
            () => parseTerminalSessionHookRequest(bad),
            (err: unknown) =>
                err instanceof BadRequestException &&
                (err.getResponse() as { code: string }).code ===
                    'terminal_hook_invalid'
        )
})

const buildController = (terminal: { id: string } | null) => {
    const consumed: string[] = []
    const reported: unknown[] = []
    const controller = new TerminalHookController(
        {
            findLiveByTokenId: async (tokenId: string) =>
                tokenId === 'tok_live' ? terminal : null
        } as never,
        {
            report: async (_terminal: unknown, body: unknown) => {
                reported.push(body)
                return 'recorded'
            }
        } as never,
        {
            consume: (args: { key: string }) => {
                consumed.push(args.key)
            }
        } as never
    )
    return { controller, consumed, reported }
}

test('only the token of a live terminal reaches the rules', async () => {
    const { controller, reported } = buildController({ id: 'tms_1' })
    for (const principal of [
        { kind: 'human-session', userId: 'u1' },
        { kind: 'agent-runtime', userId: 'u1', agentId: 'agt_1' },
        { kind: 'human-api-token', userId: 'u1', tokenId: 'tok_pat' }
    ])
        await assert.rejects(
            controller.report(principal as never, VALID),
            (err: unknown) =>
                err instanceof ForbiddenException &&
                (err.getResponse() as { code: string }).code ===
                    'terminal_token_required'
        )
    assert.deepEqual(reported, [])
})

test('a live terminal token is rate limited per terminal and then filed', async () => {
    const { controller, consumed, reported } = buildController({ id: 'tms_1' })
    const res = await controller.report(
        { kind: 'human-api-token', userId: 'u1', tokenId: 'tok_live' } as never,
        VALID
    )
    assert.deepEqual(res, { outcome: 'recorded' })
    assert.deepEqual(consumed, ['terminal-hook:tms_1'])
    assert.deepEqual(reported, [VALID])
})
