import assert from 'node:assert/strict'
import test from 'node:test'
import {
    frameworkSupportsTerminalResume,
    terminalResumeCommand,
    terminalResumeNeedsModelCredentials
} from '@/modules/terminal/terminal-resume-command'
import { terminalShellCommand } from '@/modules/terminal/sprites-terminal'

test('the supported frameworks build their own interactive resume argv', () => {
    // Each carries its full-access flag so the resumed TUI does not prompt for
    // per-action approval on a runtime that is already the trust boundary.
    assert.deepEqual(terminalResumeCommand('claude-code', 'sess-1'), [
        'claude',
        '--resume',
        'sess-1',
        '--dangerously-skip-permissions'
    ])
    assert.deepEqual(terminalResumeCommand('codex', 'sess-1'), [
        'codex',
        'resume',
        'sess-1',
        '--dangerously-bypass-approvals-and-sandbox'
    ])
})

// gemini's --resume takes a session index or "latest", not the UUID stored in
// framework_session_ref, so building a command for it would resume whichever
// conversation happens to sit at that index.
test('gemini and the non-CLI frameworks have no resume command', () => {
    for (const framework of ['gemini-cli', 'hermes', 'a2a', 'dify'] as const) {
        assert.equal(frameworkSupportsTerminalResume(framework), false)
        assert.equal(terminalResumeCommand(framework, 'sess-1'), null)
    }
})

test('a blank session ref yields no command', () => {
    assert.equal(terminalResumeCommand('claude-code', '   '), null)
})

// Only claude needs the sandbox opt-in: codex logs in on the sprite at
// bootstrap and its auth lives on disk.
test('only claude-code needs the model-credential opt-in', () => {
    assert.equal(terminalResumeNeedsModelCredentials('claude-code'), true)
    assert.equal(terminalResumeNeedsModelCredentials('codex'), false)
})

test('no resume asked for leaves the plain login shell', () => {
    assert.deepEqual(terminalShellCommand(null), ['bash', '-il'])
    assert.deepEqual(terminalShellCommand(undefined), ['bash', '-il'])
    assert.deepEqual(terminalShellCommand({ command: [] }), ['bash', '-il'])
})

// Quitting the TUI must land the user in the shell they would otherwise have
// had, not close the websocket, so the argv ends with `exec bash -il`.
test('a resume argv runs as the shell and leaves a shell behind', () => {
    assert.deepEqual(
        terminalShellCommand({ command: ['claude', '--resume', 'sess-1'] }),
        ['bash', '-ilc', "'claude' '--resume' 'sess-1'; exec bash -il"]
    )
})

// The ref reaches a shell command line, so a quote in it must not be able to
// end the argument and append a second command.
test('a session ref cannot break out of its quoting', () => {
    const [, , script] = terminalShellCommand({
        command: terminalResumeCommand(
            'claude-code',
            "x'; rm -rf /tmp/pwned; echo '"
        ) as string[]
    })
    assert.ok(script.startsWith("'claude' '--resume' '"))
    assert.ok(!script.includes('; rm -rf /tmp/pwned; echo ;'))
    // Every injected quote is neutralised as the '\'' idiom, so the payload
    // stays one argument to claude.
    assert.match(script, /'x'\\''; rm -rf \/tmp\/pwned; echo '\\'''/)
})
