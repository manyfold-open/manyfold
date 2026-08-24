import test from 'node:test'
import assert from 'node:assert/strict'
import {
    channelManifestUrl,
    CLI_CHANNEL,
    normalizeUpdateChannelFlag,
    normalizeWireChannel,
    resolveEffectiveUpdateChannel,
    versionManifestUrl
} from '../src/channel'
import { resolveUpdateStatus } from '../src/commands/update'

const DOWNLOAD = 'https://github.com/manyfold-open/manyfold/releases/download'

test('CLI_CHANNEL falls back to stable without the build-time define', () => {
    assert.equal(CLI_CHANNEL, 'stable')
})

test('channelManifestUrl points at the fixed channel-manifest release', () => {
    assert.equal(
        channelManifestUrl('stable'),
        `${DOWNLOAD}/cli-channels/stable.json`
    )
    assert.equal(channelManifestUrl('dev'), `${DOWNLOAD}/cli-channels/dev.json`)
})

test('versionManifestUrl resolves a pinned build to its own release', () => {
    assert.equal(
        versionManifestUrl('0.24.0'),
        `${DOWNLOAD}/cli-v0.24.0/manifest.json`
    )
    // A leading v is tolerated so `--to v0.24.0` does not ask for cli-vv0.24.0.
    assert.equal(
        versionManifestUrl('v0.24.0'),
        `${DOWNLOAD}/cli-v0.24.0/manifest.json`
    )
    // Dev builds live in the rolling release, keyed by their full version.
    assert.equal(
        versionManifestUrl('0.24.0-dev.202608240920.a72f4de'),
        `${DOWNLOAD}/cli-dev/manifest-0.24.0-dev.202608240920.a72f4de.json`
    )
    assert.equal(
        versionManifestUrl('0.23.3-staging.202608211430.a1b2c3d'),
        `${DOWNLOAD}/cli-dev/manifest-0.23.3-staging.202608211430.a1b2c3d.json`
    )
})

test('resolveUpdateStatus orders stable releases by semver', () => {
    const stable = (currentVersion: string, targetVersion: string) =>
        resolveUpdateStatus({
            channel: 'stable',
            currentVersion,
            targetVersion
        })
    assert.equal(stable('0.11.1', '0.11.1'), 'up-to-date')
    assert.equal(stable('0.11.0', '0.11.1'), 'update')
    assert.equal(stable('0.12.0', '0.11.1'), 'ahead')
})

// The whole point of commit-as-identity: consecutive dev builds share a base
// version, so semver reports them equal forever.
test('resolveUpdateStatus orders the dev channel by commit', () => {
    const dev = (currentCommit: string | null, targetCommit: string) =>
        resolveUpdateStatus({
            channel: 'dev',
            currentVersion: '0.24.0-dev.202608240920.a72f4de',
            currentCommit,
            targetVersion: '0.24.0-dev.202608241400.b981ca2',
            targetCommit
        })
    assert.equal(dev('a72f4de', 'b981ca2'), 'update')
    assert.equal(dev('b981ca2', 'b981ca2'), 'up-to-date')
    // No commit baked (a source build): fall back to the version string.
    assert.equal(dev(null, 'b981ca2'), 'update')
})

test('resolveUpdateStatus never reports the dev channel as ahead', () => {
    assert.equal(
        resolveUpdateStatus({
            channel: 'dev',
            currentVersion: '0.25.0-dev.202607010000.ccccccc',
            currentCommit: 'ccccccc',
            targetVersion: '0.24.0-dev.202606121400.bbbbbbb',
            targetCommit: 'bbbbbbb'
        }),
        'update'
    )
})

test('resolveUpdateStatus treats a cross-channel move as an update', () => {
    // `0.24.0-dev.…` and `0.24.0` both parse to 0.24.0, so semver alone would
    // call a channel switch "up to date" and refuse to install.
    assert.equal(
        resolveUpdateStatus({
            channel: 'stable',
            currentVersion: '0.24.0-dev.202608240920.a72f4de',
            currentCommit: 'a72f4de',
            targetVersion: '0.24.0',
            targetCommit: 'a72f4de'
        }),
        'update'
    )
    assert.equal(
        resolveUpdateStatus({
            channel: 'dev',
            currentVersion: '0.24.0',
            targetVersion: '0.24.0-dev.202608240920.a72f4de',
            targetCommit: 'a72f4de'
        }),
        'update'
    )
})

test('normalizeUpdateChannelFlag maps dev and the staging alias to dev', () => {
    assert.equal(normalizeUpdateChannelFlag('dev'), 'dev')
    assert.equal(normalizeUpdateChannelFlag('staging'), 'dev')
    assert.equal(normalizeUpdateChannelFlag('stable'), 'stable')
    assert.equal(normalizeUpdateChannelFlag('  DEV '), 'dev')
    assert.equal(normalizeUpdateChannelFlag('Stable'), 'stable')
})

test('normalizeUpdateChannelFlag rejects unknown channels', () => {
    assert.throws(
        () => normalizeUpdateChannelFlag('beta'),
        /unknown channel 'beta' \(expected dev or stable\)/
    )
})

// An API deployed before the rename still sends 'staging' in daemon.update.
test('normalizeWireChannel accepts both spellings and drops junk', () => {
    assert.equal(normalizeWireChannel('staging'), 'dev')
    assert.equal(normalizeWireChannel('dev'), 'dev')
    assert.equal(normalizeWireChannel('stable'), 'stable')
    assert.equal(normalizeWireChannel('beta'), undefined)
    assert.equal(normalizeWireChannel(undefined), undefined)
    assert.equal(normalizeWireChannel(7), undefined)
})

test('resolveEffectiveUpdateChannel: explicit flag wins', () => {
    assert.equal(
        resolveEffectiveUpdateChannel({
            flagChannel: 'stable',
            savedPref: 'dev',
            baked: 'dev'
        }),
        'stable'
    )
})

test('resolveEffectiveUpdateChannel: a pinned --to version dictates its channel', () => {
    // A dev build only has a manifest under cli-dev, so its version pin must
    // beat a saved stable preference — otherwise the manifest fetch 404s.
    assert.equal(
        resolveEffectiveUpdateChannel({
            savedPref: 'stable',
            toVersion: '0.11.1-dev.202606121400.bbbbbbb',
            baked: 'stable'
        }),
        'dev'
    )
    assert.equal(
        resolveEffectiveUpdateChannel({
            savedPref: 'dev',
            toVersion: '0.12.0',
            baked: 'dev'
        }),
        'stable'
    )
})

test('resolveEffectiveUpdateChannel: saved preference beats the baked channel', () => {
    assert.equal(
        resolveEffectiveUpdateChannel({
            savedPref: 'dev',
            baked: 'stable'
        }),
        'dev'
    )
})

test('resolveEffectiveUpdateChannel: falls back to the baked channel', () => {
    assert.equal(resolveEffectiveUpdateChannel({ baked: 'stable' }), 'stable')
})
