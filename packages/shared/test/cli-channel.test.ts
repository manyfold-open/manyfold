import test from 'node:test'
import assert from 'node:assert/strict'
import {
    cliChannelOfVersion,
    isCliUpdateAvailable,
    isDevCliVersion
} from '../src/cliVersion'

test('isDevCliVersion reads the dev prerelease marker', () => {
    assert.equal(isDevCliVersion('0.24.0-dev.202608240920.a72f4de'), true)
    assert.equal(isDevCliVersion('0.24.0'), false)
    assert.equal(isDevCliVersion(''), false)
    assert.equal(isDevCliVersion(null), false)
    assert.equal(isDevCliVersion(undefined), false)
})

// Builds published before the GitHub-Releases cutover used `-staging.` for the
// same channel and still heartbeat their version to the API.
test('isDevCliVersion still reads the pre-rename staging marker as dev', () => {
    assert.equal(isDevCliVersion('0.23.3-staging.202608211430.a1b2c3d'), true)
    assert.equal(
        cliChannelOfVersion('0.23.3-staging.202608211430.a1b2c3d'),
        'dev'
    )
})

// `0.0.0-dev` is version.ts's source-build fallback: no trailing dot, so it is
// not a published dev build and must not select the dev channel.
test('isDevCliVersion rejects markers without the trailing dot', () => {
    assert.equal(isDevCliVersion('0.0.0-dev'), false)
    assert.equal(cliChannelOfVersion('0.0.0-dev'), 'stable')
    assert.equal(isDevCliVersion('1.2.3-development'), false)
    assert.equal(isDevCliVersion('1.2.3-staging'), false)
})

test('cliChannelOfVersion maps bare semver to stable', () => {
    assert.equal(cliChannelOfVersion('0.24.0'), 'stable')
    assert.equal(cliChannelOfVersion('v0.24.0'), 'stable')
    assert.equal(cliChannelOfVersion(null), 'stable')
})

test('isCliUpdateAvailable compares dev by exact build, stable by semver', () => {
    assert.equal(
        isCliUpdateAvailable(
            'dev',
            '0.24.0-dev.202608240920.a72f4de',
            '0.24.0-dev.202608241400.b981ca2'
        ),
        true
    )
    assert.equal(
        isCliUpdateAvailable(
            'dev',
            '0.24.0-dev.202608241400.b981ca2',
            '0.24.0-dev.202608241400.b981ca2'
        ),
        false
    )
    assert.equal(isCliUpdateAvailable('stable', '0.24.0', '0.24.0'), false)
    assert.equal(isCliUpdateAvailable('stable', '0.23.3', '0.24.0'), true)
    assert.equal(isCliUpdateAvailable('stable', '0.25.0', '0.24.0'), false)
})
