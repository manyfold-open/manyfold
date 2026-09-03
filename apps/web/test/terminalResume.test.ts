import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalResumeAvailability } from '../src/lib/terminalResume'

const base = {
    framework: 'claude-code' as const,
    runtime: 'sprites' as const,
    daemonCanResume: false,
    frameworkSessionRef: 'sess-abc',
    modelSource: 'platform' as const,
    runtimeLocalReady: false,
    sandboxModelCredentials: false
}

// codex signs in on the sandbox at bootstrap and its auth sits on disk where a
// login shell finds it, so its TUI needs no credential opt-in. claude's are
// injected per exec and never persist, so its TUI has nothing without one.
// Getting this backwards would either hide a working control or offer a dead
// one, so it is asserted per framework rather than inferred.
test('codex resumes without the credential opt-in, claude does not', () => {
    assert.deepEqual(
        terminalResumeAvailability({ ...base, framework: 'codex' }),
        { available: true, blocked: null }
    )
    assert.deepEqual(terminalResumeAvailability(base), {
        available: false,
        blocked: 'needs-credential-toggle'
    })
})

test('the credential opt-in unblocks claude', () => {
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            sandboxModelCredentials: true
        }),
        { available: true, blocked: null }
    )
})

// A runtime-local agent runs on the CLI's own on-disk sign-in — the same
// credential the TUI will pick up — so it needs that sign-in, never the
// sandbox opt-in.
test('runtime-local needs its CLI sign-in, not the opt-in', () => {
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            modelSource: 'runtime-local',
            runtimeLocalReady: false
        }),
        { available: false, blocked: 'needs-runtime-signin' }
    )
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            modelSource: 'runtime-local',
            runtimeLocalReady: true,
            sandboxModelCredentials: false
        }),
        { available: true, blocked: null }
    )
})

// gemini's --resume takes a session index or "latest", never the id we store,
// so it must report unsupported rather than build a command that resumes the
// wrong conversation.
// A daemon runs on the user's own machine against the CLI sign-in already
// there, so it needs neither the sandbox opt-in nor a probe — but it does need
// a CLI new enough to run a command as its shell's argv, or it would open a
// plain shell while the UI promised a resumed session.
test('a capable daemon resumes with no opt-in at all', () => {
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            runtime: 'daemon',
            daemonCanResume: true,
            sandboxModelCredentials: false
        }),
        { available: true, blocked: null }
    )
})

test('an outdated daemon is withheld rather than shown lying', () => {
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            runtime: 'daemon',
            daemonCanResume: false,
            sandboxModelCredentials: true
        }),
        { available: false, blocked: 'daemon-needs-upgrade' }
    )
})

test('k8s and external runtimes have no resume path', () => {
    for (const runtime of ['k8s', 'external'] as const)
        assert.deepEqual(
            terminalResumeAvailability({
                ...base,
                runtime,
                daemonCanResume: true,
                sandboxModelCredentials: true
            }),
            { available: false, blocked: 'runtime-unsupported' },
            runtime
        )
})

test('gemini is unsupported even with a session ref and every opt-in on', () => {
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            framework: 'gemini-cli',
            runtimeLocalReady: true,
            sandboxModelCredentials: true
        }),
        { available: false, blocked: 'framework-unsupported' }
    )
})

test('a session the CLI has not named yet cannot be resumed', () => {
    for (const ref of [null, '', '   ']) {
        assert.deepEqual(
            terminalResumeAvailability({
                ...base,
                frameworkSessionRef: ref,
                sandboxModelCredentials: true
            }),
            { available: false, blocked: 'no-session-ref' },
            JSON.stringify(ref)
        )
    }
})

// framework-unsupported outranks a missing ref: a framework with no resume
// form is the durable fact, and reporting "no session yet" would imply that
// waiting for a turn would help.
test('an unsupported framework outranks a missing session ref', () => {
    assert.deepEqual(
        terminalResumeAvailability({
            ...base,
            framework: 'hermes',
            frameworkSessionRef: null
        }),
        { available: false, blocked: 'framework-unsupported' }
    )
})
