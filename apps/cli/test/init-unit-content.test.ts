import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlist } from '../src/daemon/init-unit/darwin'
import { buildUnit } from '../src/daemon/init-unit/linux'
import type { InstallContext, Scope } from '../src/daemon/init-unit'

const context = (scope: Scope): InstallContext => ({
    scope,
    programArgs: [
        '/usr/local/bin/node',
        '/opt/mf/index.js',
        'daemon',
        'start',
        '--foreground'
    ],
    home: '/Users/test',
    user: 'test',
    group: 'test',
    errLogPath: '/Users/test/.manyfold/daemon/daemon.err.log',
    profile: 'team-a'
})

test('launchd sends raw stdout and stderr to the daemon error sink', () => {
    for (const scope of ['user', 'system'] as const) {
        const plist = buildPlist(context(scope))
        assert.equal(plist.match(/daemon\.err\.log/g)?.length, 2)
        assert.doesNotMatch(plist, /daemon\.log/)
        assert.match(plist, /daemon/)
        assert.match(plist, /start/)
        assert.match(plist, /--foreground/)
        assert.match(plist, /<key>MF_PROFILE<\/key><string>team-a<\/string>/)
    }
})

test('systemd sends raw stdout and stderr to the daemon error sink', () => {
    for (const scope of ['user', 'system'] as const) {
        const unit = buildUnit(context(scope))
        assert.equal(unit.match(/daemon\.err\.log/g)?.length, 2)
        assert.doesNotMatch(unit, /daemon\.log/)
        assert.match(unit, /ExecStart=.*daemon start --foreground/)
        assert.match(unit, /Environment=MF_PROFILE=team-a/)
    }
})
