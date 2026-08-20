import assert from 'node:assert/strict'
import test from 'node:test'
import {
    compareSemverPrecedence,
    isPrereleaseVersion,
    isSemverVersionTag,
    parseSemver,
    SEMVER_TAG_RE
} from '../src/semver'
import {
    compareCliSemver,
    isCliVersionTooOld,
    parseCliSemver
} from '../src/cliVersion'

// The chain published in semver 2.0.0 §11, in order.
const SPEC_CHAIN = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0'
]

test('precedence follows the semver spec chain', () => {
    for (let i = 0; i < SPEC_CHAIN.length - 1; i += 1) {
        const lower = SPEC_CHAIN[i]
        const higher = SPEC_CHAIN[i + 1]
        assert.equal(
            compareSemverPrecedence(lower, higher),
            -1,
            `${lower} should precede ${higher}`
        )
        assert.equal(
            compareSemverPrecedence(higher, lower),
            1,
            `${higher} should follow ${lower}`
        )
    }
})

// The whole point of the feature: an rc must not read as its own release, or
// every equality-based gate (install needed? verification matched?) misfires.
test('a release candidate sits below the release it precedes', () => {
    assert.equal(compareSemverPrecedence('1.15.1-rc.1', '1.15.1'), -1)
    assert.equal(compareSemverPrecedence('1.15.1', '1.15.1-rc.1'), 1)
    assert.equal(compareSemverPrecedence('1.15.1-rc.1', '1.15.1-rc.2'), -1)
    assert.equal(compareSemverPrecedence('1.15.1-rc.1', '1.15.1-rc.1'), 0)
    // and still above the release below it
    assert.equal(compareSemverPrecedence('1.15.1-rc.1', '1.15.0'), 1)
})

test('build metadata is ignored, a leading v is not significant', () => {
    assert.equal(compareSemverPrecedence('1.2.3+build.5', '1.2.3+build.9'), 0)
    assert.equal(compareSemverPrecedence('v1.2.3', '1.2.3'), 0)
    assert.equal(compareSemverPrecedence('V1.2.3-rc.1', 'v1.2.3'), -1)
})

test('either side unparseable compares as null, like compareCliSemver', () => {
    assert.equal(compareSemverPrecedence('main', '1.2.3'), null)
    assert.equal(compareSemverPrecedence('1.2.3', null), null)
    assert.equal(compareSemverPrecedence(undefined, undefined), null)
})

test('parseSemver splits core, prerelease identifiers and build', () => {
    assert.deepEqual(parseSemver('v1.15.1-rc.1+sha.abc'), {
        major: 1,
        minor: 15,
        patch: 1,
        prerelease: ['rc', '1'],
        build: 'sha.abc'
    })
    assert.deepEqual(parseSemver('2.0.0')?.prerelease, [])
    // stays at least as permissive as parseCliSemver, which pads short cores
    assert.deepEqual(parseSemver('1.2')?.patch, 0)
    assert.deepEqual(parseCliSemver('1.2'), [1, 2, 0])
})

test('isPrereleaseVersion only fires on a prerelease', () => {
    assert.equal(isPrereleaseVersion('1.15.1-rc.1'), true)
    assert.equal(isPrereleaseVersion('2026.7.1-2'), true)
    assert.equal(isPrereleaseVersion('v0.1.0-alpha.1'), true)
    assert.equal(isPrereleaseVersion('v1.15.0'), false)
    assert.equal(isPrereleaseVersion('1.2.3+build.5'), false)
    assert.equal(isPrereleaseVersion('main'), false)
})

// isSemverVersionTag is the guard on every string that reaches a shell: both
// clone builders interpolate it into `git clone --branch "<tag>"` and the npm
// install shell into `npm install <pkg>@<spec>`.
test('the version tag guard admits real prerelease tags', () => {
    for (const good of [
        '1.15.1-rc.1',
        'v1.15.1-rc.1',
        'v1.7.13-oss',
        '1.2.3-test.2',
        '1.2.3-dev',
        '1.2.3-alpha.1+build.5',
        '2026.7.1-2',
        'v1.15.0',
        '0.0.0'
    ])
        assert.equal(isSemverVersionTag(good), true, good)
})

test('the version tag guard rejects anything that could reach the shell', () => {
    for (const bad of [
        '1.2.3-;rm -rf /tmp/pwned',
        '1.2.3+$(id)',
        '1.2.3 && id',
        '1.2.3`id`',
        '1.2.3-rc.1|id',
        '1.2.3\nid',
        '1.2.3-"rc"',
        "1.2.3-'rc'",
        'main',
        'HEAD',
        // three core components are required: a two-part tag could never be
        // installed, since every install site demands three
        '1.2',
        '1.2.3-',
        '1.2.3+',
        '1.2.3-rc..1',
        ''
    ])
        assert.equal(isSemverVersionTag(bad), false, JSON.stringify(bad))
    assert.equal(isSemverVersionTag(undefined), false)
    assert.equal(isSemverVersionTag(123), false)
})

// The guard trims before matching, so every caller that goes on to interpolate
// the value must use the trimmed form — which is why the three install-site
// guards (assertNarraNexusVersion, assertHermesVersion, buildNpmUpgradeShell)
// return `version.trim()` rather than their raw input.
test('the guard trims, and the pattern it exports agrees with it', () => {
    assert.equal(isSemverVersionTag(' 1.15.1-rc.1 '), true)
    assert.equal(' 1.15.1-rc.1 '.trim(), '1.15.1-rc.1')
    assert.equal(SEMVER_TAG_RE.test('1.15.1-rc.1'), true)
    assert.equal(SEMVER_TAG_RE.test(' 1.15.1-rc.1 '), false)
    assert.equal(SEMVER_TAG_RE.test('1.2.3 && id'), false)
})

// REGRESSION GUARD. The mf CLI family must stay core-only. Staging CLI builds
// are `x.y.z-staging.<stamp>.<sha>` and are compared against a bare-semver floor
// by isCliVersionTooOld, which gates the sprite runner and the daemon upgrade
// banner. Under precedence every staging build sits below its own release, so a
// "fix" that unified the two comparison families would put the entire staging
// daemon fleet below every minimum version at once.
const STAGING_CLI = '0.22.5-staging.202608101552.11b3983'

test('the mf CLI comparison stays blind to prerelease suffixes', () => {
    assert.equal(compareCliSemver(STAGING_CLI, '0.22.5'), 0)
    assert.equal(isCliVersionTooOld(STAGING_CLI, '0.22.5'), false)
    assert.equal(isCliVersionTooOld(STAGING_CLI, '0.22.4'), false)
    assert.equal(isCliVersionTooOld(STAGING_CLI, '0.22.6'), true)
    // ...while the framework family reads the same string as a prerelease
    assert.equal(compareSemverPrecedence(STAGING_CLI, '0.22.5'), -1)
})
