import test from 'node:test'
import assert from 'node:assert/strict'
import {
    buildPlist,
    parsePlistProgramArgs
} from '../src/daemon/init-unit/darwin'
import { buildUnit, parseExecStart } from '../src/daemon/init-unit/linux'
import {
    initUnitDirs,
    initUnitFileName,
    profileOfInitUnitFile,
    type InstallContext,
    type Scope
} from '../src/daemon/init-unit'

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

test('an installed unit reads back to the program it runs', () => {
    const programArgs = [
        '/Users/o&brien/My Tools/<mf>',
        '/opt/mf/index "quoted".js',
        'daemon',
        'start',
        '--foreground'
    ]
    for (const scope of ['user', 'system'] as const) {
        const ctx = { ...context(scope), programArgs }
        assert.deepEqual(parsePlistProgramArgs(buildPlist(ctx)), programArgs)
        assert.deepEqual(parseExecStart(buildUnit(ctx)), programArgs)
    }
    assert.equal(parsePlistProgramArgs('<plist></plist>'), null)
    assert.equal(parseExecStart('[Service]\nType=simple\n'), null)
})

test('unit file names map back to their profile', () => {
    for (const platform of ['darwin', 'linux'] as const) {
        const file = initUnitFileName(platform, 'team-a')
        assert.equal(profileOfInitUnitFile(platform, file), 'team-a')
    }
    assert.equal(
        profileOfInitUnitFile('darwin', 'ai.manyfold.daemon.Bad Name.plist'),
        null
    )
    assert.deepEqual(initUnitDirs('darwin', '/Users/test'), {
        user: '/Users/test/Library/LaunchAgents',
        system: '/Library/LaunchDaemons'
    })
    assert.equal(initUnitDirs('win32', 'C:\\Users\\test'), null)
})

test('a custom config dir travels into the unit, and only then', () => {
    for (const scope of ['user', 'system'] as const) {
        const plain = context(scope)
        assert.doesNotMatch(buildPlist(plain), /MF_CONFIG_DIR/)
        assert.doesNotMatch(buildUnit(plain), /MF_CONFIG_DIR/)

        const custom = { ...plain, configDir: '/srv/mf state/<cfg>' }
        assert.match(
            buildPlist(custom),
            /<key>MF_CONFIG_DIR<\/key><string>\/srv\/mf state\/&lt;cfg&gt;<\/string>/
        )
        assert.match(
            buildUnit(custom),
            /^Environment="MF_CONFIG_DIR=\/srv\/mf state\/<cfg>"$/m
        )
        assert.deepEqual(
            parsePlistProgramArgs(buildPlist(custom)),
            plain.programArgs
        )
    }
})
