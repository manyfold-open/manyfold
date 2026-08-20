import assert from 'node:assert/strict'
import test from 'node:test'
import {
    selectFrameworkInstallVersion,
    shouldInstallFrameworkVersion
} from '../src/framework-versions'

// The whole point of the `latest` tier: an unpinned agent used to freeze on the
// sprite image's baked-in CLI (claude-code 2.1.92 while npm was months ahead).
// Resolving to the catalog's latest is what makes a fresh agent current.
test('an unpinned create resolves to the catalog latest', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({ catalogLatest: '2.1.197' }),
        { version: '2.1.197', source: 'latest' }
    )
})

// An admin pinning a version is a deliberate platform-wide choice; it must beat
// "newest upstream", otherwise the pin setting does nothing.
test('an admin pin beats the catalog latest', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            adminDefault: '2.1.100',
            catalogLatest: '2.1.197'
        }),
        { version: '2.1.100', source: 'admin' }
    )
})

// A caller naming a version (dto.frameworkVersion) is the most specific intent —
// it must beat both the admin pin and latest, so per-agent reproduction works.
test('an explicitly requested version beats both admin pin and latest', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            requested: '2.0.5',
            adminDefault: '2.1.100',
            catalogLatest: '2.1.197'
        }),
        { version: '2.0.5', source: 'explicit' }
    )
})

// An unreachable catalog (or a framework with no versioned CLI) must not invent
// a target: `none` is what preserves each framework's built-in default instead
// of failing the create.
test('nothing resolvable yields none so the built-in default survives', () => {
    assert.deepEqual(selectFrameworkInstallVersion({}), {
        version: null,
        source: 'none'
    })
    assert.deepEqual(
        selectFrameworkInstallVersion({
            requested: '   ',
            adminDefault: '',
            catalogLatest: null
        }),
        { version: null, source: 'none' }
    )
})

// Skipping the install is purely a latency optimisation on an already-current
// sprite; it must never skip when the versions differ in EITHER direction, or an
// admin downgrade would silently no-op.
test('install is skipped only when the installed version already matches', () => {
    assert.equal(shouldInstallFrameworkVersion('2.1.197', '2.1.197'), false)
    assert.equal(shouldInstallFrameworkVersion('v2.1.197', '2.1.197'), false)
    assert.equal(shouldInstallFrameworkVersion('2.1.92', '2.1.197'), true)
    assert.equal(shouldInstallFrameworkVersion('2.2.0', '2.1.197'), true)
})

// A probe that returned nothing (or something like hermes' `main`) means we do
// not know what is on the sprite. Installing is the only safe read — assuming
// "current" is how an agent silently keeps a stale binary.
test('an unknown or unparseable installed version still installs', () => {
    assert.equal(shouldInstallFrameworkVersion(null, '2.1.197'), true)
    assert.equal(shouldInstallFrameworkVersion('', '2.1.197'), true)
    assert.equal(shouldInstallFrameworkVersion('main', '2.1.197'), true)
})

// The prerelease opt-in has to be enforced here, not only in the catalog: an
// explicit request and an admin pin never pass through the catalog, so filtering
// there alone would leave both routes open.
test('a prerelease request is flagged rather than silently substituted', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({ requested: '1.15.1-rc.1' }),
        {
            version: '1.15.1-rc.1',
            source: 'explicit',
            prereleaseNotAllowed: true
        }
    )
    assert.deepEqual(
        selectFrameworkInstallVersion({
            requested: '1.15.1-rc.1',
            allowPrerelease: true
        }),
        { version: '1.15.1-rc.1', source: 'explicit' }
    )
})

// A pin degrades to the next tier instead of throwing, exactly like a blocked
// pin: provisioning must not become impossible because a policy changed under a
// stored setting.
test('a prerelease pin is skipped while the opt-in is off', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            adminDefault: '1.15.1-rc.1',
            catalogLatest: 'v1.15.0'
        }),
        { version: 'v1.15.0', source: 'latest' }
    )
    assert.deepEqual(
        selectFrameworkInstallVersion({
            adminDefault: '1.15.1-rc.1',
            catalogLatest: 'v1.15.0',
            allowPrerelease: true
        }),
        { version: '1.15.1-rc.1', source: 'admin' }
    )
    // no tier survives — the framework's built-in default has to take over
    assert.deepEqual(
        selectFrameworkInstallVersion({ adminDefault: '1.15.1-rc.1' }),
        { version: null, source: 'none' }
    )
})

// A blocked prerelease is reported as blocked, not as a prerelease: the denylist
// is the stronger refusal and its reason is the one worth showing.
test('blocked beats prerelease when a request trips both', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            requested: '0.53.5-rc.1',
            blocked: [
                { min: '0.53.0', max: '0.54.0', reason: 'unsigned history' }
            ]
        }),
        {
            version: '0.53.5-rc.1',
            source: 'explicit',
            blockedBy: {
                min: '0.53.0',
                max: '0.54.0',
                reason: 'unsigned history'
            }
        }
    )
})

// The bug the opt-in would otherwise introduce: under core-only comparison
// `1.15.1` and `1.15.1-rc.1` read as equal, so targeting the rc from the release
// would skip the install and leave the wrong build on the sprite while
// reporting success.
test('a prerelease target of an installed release still installs', () => {
    assert.equal(shouldInstallFrameworkVersion('1.15.1', '1.15.1-rc.1'), true)
    assert.equal(shouldInstallFrameworkVersion('1.15.1-rc.1', '1.15.1'), true)
    assert.equal(
        shouldInstallFrameworkVersion('1.15.1-rc.1', '1.15.1-rc.2'),
        true
    )
    assert.equal(
        shouldInstallFrameworkVersion('1.15.1-rc.1', 'v1.15.1-rc.1'),
        false
    )
})
