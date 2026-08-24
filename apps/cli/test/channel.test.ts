import test from 'node:test'
import assert from 'node:assert/strict'
import {
    channelDefaults,
    CLI_CHANNEL,
    hasDevChannel,
    normalizeUpdateChannelFlag,
    requireChannelCdn,
    resolveEffectiveUpdateChannel
} from '../src/channel'
import { resolveUpdateStatus } from '../src/commands/update'

// The dev-channel endpoints ride build-time defines; under tsx they resolve
// through globalThis, so tests inject example endpoints the same way the
// release workflows inject the real ones.
const injectDevChannel = (): void => {
    ;(globalThis as Record<string, unknown>).__MF_CLI_STAGING_API_URL__ =
        'https://api.dev.example/api'
    ;(globalThis as Record<string, unknown>).__MF_CLI_STAGING_CDN_BASE__ =
        'https://cdn.dev.example/cli/dev'
}
const clearDevChannel = (): void => {
    delete (globalThis as Record<string, unknown>).__MF_CLI_STAGING_API_URL__
    delete (globalThis as Record<string, unknown>).__MF_CLI_STAGING_CDN_BASE__
}

test('channelDefaults bakes stable and leaves an uninjected dev channel empty', () => {
    clearDevChannel()
    assert.deepEqual(channelDefaults('stable'), {
        apiUrl: 'https://api.manyfold.ai/api',
        cdnBase: 'https://cdn1.manyfold.ai/cli'
    })
    assert.deepEqual(channelDefaults('dev'), { apiUrl: '', cdnBase: '' })
    assert.equal(hasDevChannel(), false)
})

test('channelDefaults serves the workflow-baked dev endpoints when present', (t) => {
    injectDevChannel()
    t.after(clearDevChannel)
    assert.deepEqual(channelDefaults('dev'), {
        apiUrl: 'https://api.dev.example/api',
        cdnBase: 'https://cdn.dev.example/cli/dev'
    })
    assert.equal(hasDevChannel(), true)
    assert.equal(
        requireChannelCdn('dev'),
        'https://cdn.dev.example/cli/dev'
    )
})

test('requireChannelCdn refuses a dev channel this build does not carry', () => {
    clearDevChannel()
    assert.throws(
        () => requireChannelCdn('dev'),
        /not produced with a dev channel/
    )
    assert.equal(requireChannelCdn('stable'), 'https://cdn1.manyfold.ai/cli')
})

test('CLI_CHANNEL falls back to stable without the build-time define', () => {
    assert.equal(CLI_CHANNEL, 'stable')
})

test('resolveUpdateStatus orders stable releases by semver', () => {
    assert.equal(
        resolveUpdateStatus('stable', '0.11.1', '0.11.1'),
        'up-to-date'
    )
    assert.equal(resolveUpdateStatus('stable', '0.11.0', '0.11.1'), 'update')
    assert.equal(resolveUpdateStatus('stable', '0.12.0', '0.11.1'), 'ahead')
})

test('resolveUpdateStatus treats any dev difference as an update', () => {
    // Two dev builds of the same base both parse as 0.11.1 under the
    // stable comparator, which would report "up to date" forever.
    assert.equal(
        resolveUpdateStatus(
            'dev',
            '0.11.1-dev.202606120900.aaaaaaa',
            '0.11.1-dev.202606121400.bbbbbbb'
        ),
        'update'
    )
    assert.equal(
        resolveUpdateStatus(
            'dev',
            '0.11.1-dev.202606121400.bbbbbbb',
            '0.11.1-dev.202606121400.bbbbbbb'
        ),
        'up-to-date'
    )
    // The dev channel never reports "ahead" — latest is authoritative.
    assert.equal(
        resolveUpdateStatus(
            'dev',
            '0.12.0-dev.202607010000.ccccccc',
            '0.11.1-dev.202606121400.bbbbbbb'
        ),
        'update'
    )
})

// Pre-rename dev builds carry `-staging.` and are still installed in the field.
test('resolveUpdateStatus still reads pre-rename dev versions as dev', () => {
    assert.equal(
        resolveUpdateStatus(
            'dev',
            '0.11.1-staging.202606120900.aaaaaaa',
            '0.11.1-dev.202606121400.bbbbbbb'
        ),
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
    // A dev build only exists under cli/staging, so its version pin must
    // beat a saved stable preference — otherwise the download 404s.
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
