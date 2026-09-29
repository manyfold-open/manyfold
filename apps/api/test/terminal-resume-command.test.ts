import assert from 'node:assert/strict'
import test from 'node:test'
import {
    frameworkSupportsTerminalResume,
    terminalResumeCommand,
    terminalResumeNeedsModelCredentials
} from '@/modules/terminal/terminal-resume-command'

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
    assert.deepEqual(
        terminalResumeCommand(
            'antigravity-cli',
            '6bce3054-1614-4b63-b9b5-9590cdfc8458'
        ),
        [
            'agy',
            '--conversation',
            '6bce3054-1614-4b63-b9b5-9590cdfc8458',
            '--dangerously-skip-permissions'
        ]
    )
    assert.equal(terminalResumeNeedsModelCredentials('antigravity-cli'), true)
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
// None of these CLIs is logged in on the machine: each turn carries its own
// key, so a TUI resumed in the terminal has one only if the sandbox lends it.
test('every resumable CLI needs the model-credential opt-in', () => {
    for (const framework of ['claude-code', 'codex', 'pi', 'antigravity-cli'] as const)
        assert.equal(terminalResumeNeedsModelCredentials(framework), true, framework)
})
