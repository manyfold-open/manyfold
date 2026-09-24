import assert from 'node:assert/strict'
import test from 'node:test'
import {
    HERDR_FOLLOW_HOLD_DELAY_MS,
    herdrFollowDelayMs,
    herdrHandoffAvailability,
    herdrHandoffBlockedLabel,
    viewSwitchHint
} from '../src/lib/herdrHandoff'

const base = {
    runtime: 'daemon' as const,
    running: true,
    framework: 'claude-code' as const,
    daemonCanOpenInHerdr: true,
    daemonCanResume: true,
    sandboxHasHerdr: false,
    sandboxCanOpenInHerdr: false,
    sandboxCliUpdateAvailable: false,
    sandboxModelCredentials: false,
    hostHerdrFrameworks: ['claude-code', 'codex', 'pi'] as const,
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

// herdr has an agent kind for pi too, but only a Manyfold CLI that knows it
// can start it: on an older one the control is shown disabled, pointing at
// the update, rather than failing when clicked.
test('pi goes to herdr where the CLI there can start it, and asks for the update where it cannot', () => {
    assert.deepEqual(herdrHandoffAvailability({ ...base, framework: 'pi' }), {
        offered: true,
        available: true,
        blocked: null
    })
    assert.deepEqual(
        herdrHandoffAvailability({
            ...base,
            framework: 'pi',
            hostHerdrFrameworks: ['claude-code', 'codex']
        }),
        { offered: true, available: false, blocked: 'daemon-needs-upgrade' }
    )
    const sandbox = {
        ...base,
        framework: 'pi' as const,
        runtime: 'sprites' as const,
        daemonCanOpenInHerdr: false,
        sandboxHasHerdr: true,
        sandboxCanOpenInHerdr: true,
        sandboxModelCredentials: true
    }
    assert.equal(herdrHandoffAvailability(sandbox).available, true)
    assert.equal(
        herdrHandoffAvailability({
            ...sandbox,
            hostHerdrFrameworks: ['claude-code', 'codex'],
            sandboxCliUpdateAvailable: true
        }).blocked,
        'sandbox-runner-needs-upgrade'
    )
    // Like claude, pi's TUI on a sandbox needs the credential opt-in.
    assert.equal(
        herdrHandoffAvailability({ ...sandbox, sandboxModelCredentials: false })
            .blocked,
        'needs-credential-toggle'
    )
    // claude and codex are unaffected by what the CLI knows of pi.
    assert.equal(
        herdrHandoffAvailability({
            ...base,
            hostHerdrFrameworks: ['claude-code', 'codex']
        }).available,
        true
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
    // A runner too old for herdr points at the Update Center only when it
    // has something to offer; on the newest release it waits for the next.
    assert.equal(
        herdrHandoffAvailability({
            ...sandbox,
            sandboxCanOpenInHerdr: false,
            sandboxCliUpdateAvailable: true
        }).blocked,
        'sandbox-runner-needs-upgrade'
    )
    assert.equal(
        herdrHandoffAvailability({ ...sandbox, sandboxCanOpenInHerdr: false })
            .blocked,
        'sandbox-runner-needs-release'
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
        'sandbox-runner-needs-release',
        'needs-credential-toggle',
        'needs-runtime-signin'
    ] as const)
        assert.ok(herdrHandoffBlockedLabel(blocked, t as never), blocked)
    assert.equal(herdrHandoffBlockedLabel('no-herdr', t as never), null)
})

// A session left in herdr comes back in herdr (ADR-0031): the hold has
// stood a while, so the view follows it at once; only a hold that has just
// appeared, which a refused handoff elsewhere can produce, waits.
test('a hold that has stood a while is followed at once, a fresh one waits out the rest', () => {
    const now = Date.parse('2026-09-22T20:00:10.000Z')
    assert.equal(herdrFollowDelayMs('2026-09-22T19:59:00.000Z', now), 0)
    assert.equal(herdrFollowDelayMs('2026-09-22T20:00:09.500Z', now), 700)
    assert.equal(herdrFollowDelayMs(null, now), HERDR_FOLLOW_HOLD_DELAY_MS)
    // A server clock ahead of this one never stretches the wait.
    assert.equal(
        herdrFollowDelayMs('2026-09-22T20:00:30.000Z', now),
        HERDR_FOLLOW_HOLD_DELAY_MS
    )
})

// The notes that used to sit above the composer live behind the "?" on the
// view switch: what it does or why it cannot, who holds the session, an
// import in flight, and what the last hand-back brought.
test('the view switch hint says what the switch does, or why not, and what the banner used to', () => {
    const t = (key: string): string => key
    const base = {
        mode: 'herdr' as const,
        disabledReason: null,
        heldBy: null,
        importing: false,
        notice: null
    }
    assert.equal(viewSwitchHint(base, t), 'web.sessionView.hintHerdr')
    assert.equal(
        viewSwitchHint({ ...base, mode: 'terminal' }, t),
        'web.sessionView.hintTerminal'
    )
    assert.equal(
        viewSwitchHint({ ...base, mode: 'chat', heldBy: 'herdr' }, t),
        'web.sessionView.hintChat'
    )
    assert.equal(
        viewSwitchHint({ ...base, disabledReason: 'why not' }, t),
        'why not'
    )
    assert.equal(
        viewSwitchHint({ ...base, heldBy: 'herdr' }, t),
        'web.sessionHolder.heldByHerdr'
    )
    assert.equal(
        viewSwitchHint({ ...base, mode: 'terminal', heldBy: 'terminal' }, t),
        'web.sessionHolder.heldBanner'
    )
    assert.equal(
        viewSwitchHint(
            { ...base, importing: true, notice: 'Nothing new was said.' },
            t
        ),
        'web.sessionView.hintHerdr web.sessionHolder.importPending Nothing new was said.'
    )
})
