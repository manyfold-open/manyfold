import test from 'node:test'
import assert from 'node:assert/strict'
import { daemonPaths } from '../src/daemon/config'
import { buildPlist, launchdLabelFor } from '../src/daemon/init-unit/darwin'
import { buildUnit, systemdUnitNameFor } from '../src/daemon/init-unit/linux'
import type { InstallContext } from '../src/daemon/init-unit'

const context = (profile: string): InstallContext => ({
    scope: 'user',
    programArgs: ['/usr/local/bin/mf', 'daemon', 'start', '--foreground'],
    home: '/Users/test',
    user: 'test',
    group: 'test',
    errLogPath: `/Users/test/.manyfold/profiles/${profile}/daemon/daemon.err.log`,
    profile
})

const withEnv = (
    overrides: Record<string, string | undefined>,
    fn: () => void
): void => {
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        fn()
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('every profile gets its own daemon state dir under profiles/, default included', () => {
    withEnv({ MF_CONFIG_DIR: '/tmp/mf-home', MF_PROFILE: undefined }, () => {
        assert.equal(
            daemonPaths.baseDir,
            '/tmp/mf-home/profiles/default/daemon'
        )
    })
    withEnv({ MF_CONFIG_DIR: '/tmp/mf-home', MF_PROFILE: 'staging' }, () => {
        assert.equal(
            daemonPaths.baseDir,
            '/tmp/mf-home/profiles/staging/daemon'
        )
        assert.equal(
            daemonPaths.configPath,
            '/tmp/mf-home/profiles/staging/daemon/config.json'
        )
    })
})

test('init units are suffixed for every profile — default has no privileged name', () => {
    assert.equal(launchdLabelFor('default'), 'ai.manyfold.daemon.default')
    assert.equal(launchdLabelFor('staging'), 'ai.manyfold.daemon.staging')
    assert.equal(systemdUnitNameFor('default'), 'mf-daemon-default.service')
    assert.equal(systemdUnitNameFor('staging'), 'mf-daemon-staging.service')
    assert.notEqual(launchdLabelFor('staging'), launchdLabelFor('default'))
})

test('unit content bakes MF_PROFILE and keeps the err-log sink inside the profile dir', () => {
    const plist = buildPlist(context('staging'))
    assert.match(plist, /<key>MF_PROFILE<\/key><string>staging<\/string>/)
    assert.match(plist, /profiles\/staging\/daemon\/daemon\.err\.log/)

    const unit = buildUnit(context('team-a'))
    assert.match(unit, /Environment=MF_PROFILE=team-a/)
    assert.match(unit, /profiles\/team-a\/daemon\/daemon\.err\.log/)
})
