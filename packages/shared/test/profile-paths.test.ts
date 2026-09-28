import test from 'node:test'
import assert from 'node:assert/strict'
import {
    PROFILE_NAME_RE,
    cliProfileForApiUrl,
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

test('cliProfileForApiUrl names one profile per API host and port', () => {
    const cases: Array<[string, string]> = [
        ['https://api.example.com/api', 'example-com'],
        ['https://api-staging.example.com/api', 'staging-example-com'],
        ['https://mf.example.com:8443/api', 'mf-example-com-8443'],
        ['http://10.0.0.5:2222/api', '10-0-0-5-2222'],
        ['http://localhost:7180/api', 'localhost-7180'],
        ['http://127.0.0.1:7180/api', 'localhost-7180'],
        ['http://[::1]:7180/api', 'localhost-7180'],
        ['http://app.localhost:7180/api', 'localhost-7180'],
        ['http://localhost/api', 'localhost']
    ]
    for (const [apiUrl, profile] of cases)
        assert.equal(cliProfileForApiUrl(apiUrl), profile, apiUrl)
})

test('cliProfileForApiUrl never lands on a name a binary or runner owns', () => {
    assert.equal(cliProfileForApiUrl('https://api.staging/api'), 'staging-api')
    assert.equal(cliProfileForApiUrl('https://manyfold/api'), 'manyfold-api')
    assert.equal(cliProfileForApiUrl('https://dev/api'), 'dev-api')
    assert.equal(cliProfileForApiUrl('https://default/api'), 'default-api')
})

test('cliProfileForApiUrl keeps long hosts valid and distinct', () => {
    const a = cliProfileForApiUrl(
        'https://api.a-very-long-deployment-name.eu-west.example.com/api'
    )
    const b = cliProfileForApiUrl(
        'https://api.a-very-long-deployment-name.us-east.example.com/api'
    )
    assert.ok(a.length <= 32 && isValidProfileName(a), a)
    assert.ok(b.length <= 32 && isValidProfileName(b), b)
    assert.notEqual(a, b)
    assert.equal(
        cliProfileForApiUrl(
            'https://api.a-very-long-deployment-name.eu-west.example.com/api'
        ),
        a
    )
})
