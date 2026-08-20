import test from 'node:test'
import assert from 'node:assert/strict'
import {
    buildRegisteredDaemonConfig,
    resolveDaemonRegisterToken
} from '../src/commands/daemon/register'

test('resolveDaemonRegisterToken accepts a register command token', () => {
    assert.equal(
        resolveDaemonRegisterToken(
            { token: ' ldt_child ' },
            { token: 'ldt_root' }
        ),
        'ldt_child'
    )
})

test('resolveDaemonRegisterToken falls back to root token when commander captures it globally', () => {
    assert.equal(
        resolveDaemonRegisterToken({}, { token: 'ldt_root' }),
        'ldt_root'
    )
})

test('resolveDaemonRegisterToken reads --token - from stdin', () => {
    assert.equal(
        resolveDaemonRegisterToken(
            { token: '-' },
            undefined,
            () => '  ldt_piped\n'
        ),
        'ldt_piped'
    )
})

test('resolveDaemonRegisterToken rejects missing token', () => {
    assert.throws(
        () => resolveDaemonRegisterToken({}, {}),
        /requires --token <token>/
    )
})

test('resolveDaemonRegisterToken rejects non-daemon token values', () => {
    assert.throws(
        () => resolveDaemonRegisterToken({}, { token: 'user_session_token' }),
        /must start with ldt_/
    )
})

test('new daemon registrations record profile, channel and the declared roots', () => {
    const previous = process.env.MF_PROFILE
    process.env.MF_PROFILE = 'team-a'
    try {
        assert.deepEqual(
            buildRegisteredDaemonConfig({
                apiUrl: 'https://custom.example.test/api',
                token: 'ldt_secret',
                daemonId: 'ldh_test',
                daemonUuid: 'daemon-uuid',
                workspaceBaseDir: '/home/t/.manyfold/workspaces',
                skillsDir: '/home/t/.manyfold/skills'
            }),
            {
                apiUrl: 'https://custom.example.test/api',
                token: 'ldt_secret',
                daemonId: 'ldh_test',
                daemonUuid: 'daemon-uuid',
                workspaceBaseDir: '/home/t/.manyfold/workspaces',
                skillsDir: '/home/t/.manyfold/skills',
                profile: 'team-a',
                channel: 'stable'
            }
        )
    } finally {
        if (previous === undefined) delete process.env.MF_PROFILE
        else process.env.MF_PROFILE = previous
    }
})
