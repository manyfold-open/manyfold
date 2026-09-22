import assert from 'node:assert/strict'
import test from 'node:test'
import {
    herdrHandoffAvailability,
    herdrHandoffBlockedLabel
} from '../src/lib/herdrHandoff'

const base = {
    runtime: 'daemon' as const,
    running: true,
    framework: 'claude-code' as const,
    daemonCanOpenInHerdr: true,
    daemonCanResume: true,
    sandboxHasHerdr: false,
    sandboxCanOpenInHerdr: false,
    sandboxModelCredentials: false,
    sessionId: 'cs-1',
    frameworkSessionRef: 'sess-abc',
    modelSource: 'platform' as const,
    runtimeLocalReady: false
}

// "Switch to herdr" replaces the browser TUI only where herdr can work
// (ADR-0031): a daemon that advertises it, or a sandbox with herdr
// installed. Everywhere else the control is not offered at all, so the
// browser terminal keeps its name.
test('the handoff is offered on a daemon that advertises herdr or a sandbox that has it', () => {
    assert.deepEqual(herdrHandoffAvailability(base), {
        offered: true,
        available: true,
        blocked: null
    })
    assert.equal(
        herdrHandoffAvailability({ ...base, daemonCanOpenInHerdr: false })
            .offered,
        false
    )
    assert.equal(
        herdrHandoffAvailability({ ...base, runtime: 'sprites' }).offered,
        false
    )
    assert.deepEqual(
        herdrHandoffAvailability({
            ...base,
            runtime: 'sprites',
            daemonCanOpenInHerdr: false,
            sandboxHasHerdr: true,
            sandboxCanOpenInHerdr: true,
            sandboxModelCredentials: true
        }),
        { offered: true, available: true, blocked: null }
    )
})

// A sandbox whose runner predates the handoff shows the control disabled
// with the Update Center as the way out; a sandbox that has not opted into
// lending credentials to the terminal is blocked the way its resume is.
test('a sandbox handoff waits for its runner CLI and for the credential opt-in', () => {
    const sandbox = {
        ...base,
        runtime: 'sprites' as const,
        daemonCanOpenInHerdr: false,
        sandboxHasHerdr: true,
        sandboxCanOpenInHerdr: true,
        sandboxModelCredentials: true
    }
    assert.equal(
        herdrHandoffAvailability({ ...sandbox, sandboxCanOpenInHerdr: false })
            .blocked,
        'sandbox-runner-needs-upgrade'
    )
    assert.equal(
        herdrHandoffAvailability({ ...sandbox, sandboxModelCredentials: false })
            .blocked,
        'needs-credential-toggle'
    )
    // codex needs no credentials, so the opt-in does not gate it.
    assert.equal(
        herdrHandoffAvailability({
            ...sandbox,
            framework: 'codex',
            sandboxModelCredentials: false
        }).available,
        true
    )
})

test('an offered control is disabled for the reasons the user can act on, in the order the API checks them', () => {
    assert.equal(
        herdrHandoffAvailability({ ...base, running: false }).blocked,
        'agent-not-running'
    )
    assert.equal(
        herdrHandoffAvailability({ ...base, sessionId: null }).blocked,
        'no-session'
    )
    assert.equal(
        herdrHandoffAvailability({ ...base, frameworkSessionRef: null })
            .blocked,
        'no-session-ref'
    )
    assert.equal(
        herdrHandoffAvailability({ ...base, framework: 'gemini-cli' }).blocked,
        'framework-unsupported'
    )
    assert.equal(
        herdrHandoffAvailability({
            ...base,
            modelSource: 'runtime-local',
            runtimeLocalReady: false
        }).blocked,
        'needs-runtime-signin'
    )
    // codex needs no sign-in probe on a daemon.
    assert.equal(
        herdrHandoffAvailability({ ...base, framework: 'codex' }).available,
        true
    )
})

test('every disabled reason the control can show has a label', () => {
    const t = (key: string): string => key
    for (const blocked of [
        'agent-not-running',
        'no-session',
        'no-session-ref',
        'framework-unsupported',
        'daemon-needs-upgrade',
        'sandbox-runner-needs-upgrade',
        'needs-credential-toggle',
        'needs-runtime-signin'
    ] as const)
        assert.ok(herdrHandoffBlockedLabel(blocked, t as never), blocked)
    assert.equal(herdrHandoffBlockedLabel('no-herdr', t as never), null)
})
