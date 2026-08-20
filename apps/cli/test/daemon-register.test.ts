import test from 'node:test'
import assert from 'node:assert/strict'
import {
    buildRegisteredDaemonConfig,
    resolveDaemonRegisterApiUrl,
    resolveDaemonRegisterToken
} from '../src/commands/daemon/register'
import { DEFAULT_API_URL } from '../src/channel'

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

test('resolveDaemonRegisterApiUrl prefers the profile-stored apiUrl over the channel default', () => {
    assert.equal(
        resolveDaemonRegisterApiUrl(undefined, {
            apiUrl: 'http://localhost:12222/api'
        }),
        'http://localhost:12222/api',
        'login already recorded which API this profile talks to; registering against the channel default instead ships the ldt_ token to the wrong server, which answers "daemon token not found"'
    )
})

test('resolveDaemonRegisterApiUrl lets an explicit root --api-url beat the profile', () => {
    assert.equal(
        resolveDaemonRegisterApiUrl('https://override.example.test/api', {
            apiUrl: 'http://localhost:12222/api'
        }),
        'https://override.example.test/api',
        'an operator pointing register somewhere on purpose must always win over stored state'
    )
})

test('resolveDaemonRegisterApiUrl falls back to the channel default on a fresh profile', () => {
    assert.equal(resolveDaemonRegisterApiUrl(undefined, {}), DEFAULT_API_URL)
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
