import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFramework } from '../src/constants'
import type { AgentFramework } from '../src/constants'
import {
    frameworkResumeArgv,
    frameworkResumeCommandLine
} from '../src/framework-resume'

test('resume argv is each CLI documented resume-by-id form', () => {
    assert.deepEqual(frameworkResumeArgv('claude-code', 'sess-1'), [
        'claude',
        '--resume',
        'sess-1'
    ])
    assert.deepEqual(frameworkResumeArgv('codex', 'sess-1'), [
        'codex',
        'resume',
        'sess-1'
    ])
})

// The copied command runs wherever it is pasted, so it must not carry the
// approval-bypass flags the API adds for a runtime it already controls.
// terminal-resume-command.ts owns those and appends them itself.
test('resume argv never carries a permission-bypass flag', () => {
    for (const framework of Object.values(agentFramework)) {
        const argv = frameworkResumeArgv(framework, 'sess-1') ?? []
        for (const arg of argv)
            assert.ok(
                !/dangerous|bypass|skip-permissions|yolo|--force/i.test(arg),
                `${framework} resume argv leaked ${arg}`
            )
    }
})

test('frameworks with no resume-by-id form return null', () => {
    // gemini-cli's --resume takes an index or "latest", not our stored UUID.
    const unsupported: AgentFramework[] = [
        'gemini-cli',
        'openclaw',
        'hermes',
        'narranexus',
        'dify',
        'langflow',
        'a2a'
    ]
    for (const framework of unsupported) {
        assert.equal(frameworkResumeArgv(framework, 'sess-1'), null, framework)
        assert.equal(
            frameworkResumeCommandLine(framework, 'sess-1'),
            null,
            framework
        )
    }
})

test('a blank session ref has nothing to resume', () => {
    assert.equal(frameworkResumeArgv('claude-code', '   '), null)
    assert.equal(frameworkResumeCommandLine('claude-code', ''), null)
})

test('the command line leaves a normal session id unquoted', () => {
    assert.equal(
        frameworkResumeCommandLine(
            'claude-code',
            '9f3c1a20-7b4e-4d2a-9c11-5e8a2f0b6d34'
        ),
        'claude --resume 9f3c1a20-7b4e-4d2a-9c11-5e8a2f0b6d34'
    )
})

// A ref carrying whitespace or a quote is malformed rather than expected, but
// a copied line that splits into two commands is the one failure worth
// spending a quote on.
test('the command line cannot split into two commands', () => {
    assert.equal(
        frameworkResumeCommandLine('codex', 'a b; rm -rf /'),
        "codex resume 'a b; rm -rf /'"
    )
    assert.equal(
        frameworkResumeCommandLine('codex', "it's"),
        "codex resume 'it'\\''s'"
    )
})
