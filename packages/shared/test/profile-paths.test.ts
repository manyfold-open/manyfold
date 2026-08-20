import test from 'node:test'
import assert from 'node:assert/strict'
import {
    PROFILE_NAME_RE,
    isValidProfileName,
    machineSkillsDir,
    machineWorkspacesRoot,
    profilePaths,
    profilesRoot
} from '../src/profile-paths'

test('profilePaths derives the control-plane layout from one dir', () => {
    const paths = profilePaths('/home/t/.manyfold', 'staging')
    assert.deepEqual(paths, {
        dir: '/home/t/.manyfold/profiles/staging',
        configPath: '/home/t/.manyfold/profiles/staging/config.json',
        pendingLoginPath:
            '/home/t/.manyfold/profiles/staging/pending-login.json',
        daemonDir: '/home/t/.manyfold/profiles/staging/daemon',
        daemonConfigPath:
            '/home/t/.manyfold/profiles/staging/daemon/config.json'
    })
    assert.equal(profilesRoot('/home/t/.manyfold'), '/home/t/.manyfold/profiles')
})

test('the data plane is machine-scoped, outside every profile dir', () => {
    assert.equal(
        machineWorkspacesRoot('/home/t/.manyfold'),
        '/home/t/.manyfold/workspaces'
    )
    assert.equal(
        machineSkillsDir('/home/t/.manyfold'),
        '/home/t/.manyfold/skills'
    )
})

test('default gets the same layout as every other profile', () => {
    assert.equal(
        profilePaths('/r', 'default').configPath,
        '/r/profiles/default/config.json'
    )
})

test('profile name validation rejects path and unit-name hazards', () => {
    for (const bad of [
        '',
        ' ',
        '../x',
        'a/b',
        'a.b',
        'a b',
        'A',
        '-a',
        '_a',
        'a'.repeat(33)
    ])
        assert.equal(isValidProfileName(bad), false, JSON.stringify(bad))
    for (const good of ['default', 'staging', 'spriterunner', 'team-a', 'a_b'])
        assert.equal(isValidProfileName(good), true, good)
    assert.match('spriterunner', PROFILE_NAME_RE)
})
