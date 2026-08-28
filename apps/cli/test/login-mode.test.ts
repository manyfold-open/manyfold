import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLoginMode } from '../src/commands/login'
import { buildProgram } from '../src/program'

test('resolveLoginMode picks token, auth-code, headless and browser', () => {
    assert.equal(resolveLoginMode({ token: 'mf_x' }, true), 'token')
    assert.equal(resolveLoginMode({ authCode: 'mf_auth_x' }, true), 'auth-code')
    assert.equal(resolveLoginMode({ launchBrowser: false }, true), 'headless')
    assert.equal(resolveLoginMode({}, true), 'browser')
})

test('headless mode requires a TTY without an auth code', () => {
    assert.throws(
        () => resolveLoginMode({ launchBrowser: false }, false),
        /--no-launch-browser requires an interactive terminal/
    )
})

test('agent context rejects login and points at auth ensure', () => {
    assert.throws(
        () => resolveLoginMode({}, false, true),
        /agent runtimes are already authenticated.*mf auth ensure/
    )
})

// The device-code grant flow (--poll/--wait/--scopes/--for-agent/--resume)
// retired with the auth-model refactor: `mf auth ensure --scopes <list>` is
// the only capability-request path. Commander now treats the old flags as
// unknown options instead of routing them anywhere.
test('the retired poll-mode flags are unknown options', async () => {
    for (const flag of ['--poll', '--resume', '--scopes']) {
        const program = buildProgram()
        // exitOverride is per-command and `login` was registered before we
        // got the program, so the subcommand needs its own override or an
        // unknown option kills the test process instead of rejecting.
        program.exitOverride()
        program.configureOutput({ writeErr: () => {} })
        for (const command of program.commands) {
            command.exitOverride()
            command.configureOutput({ writeErr: () => {} })
        }
        await assert.rejects(
            () =>
                program.parseAsync(
                    flag === '--scopes'
                        ? ['login', flag, 'channels:read']
                        : ['login', flag],
                    { from: 'user' }
                ),
            /unknown option/
        )
    }
})
