import test from 'node:test'
import assert from 'node:assert/strict'
import {
    channelDefaults,
    channelFlagLabel,
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
    assert.deepEqual(channelDefaults('staging'), { apiUrl: '', cdnBase: '' })
    assert.equal(hasDevChannel(), false)
})

test('channelDefaults serves the workflow-baked dev endpoints when present', (t) => {
    injectDevChannel()
    t.after(clearDevChannel)
    assert.deepEqual(channelDefaults('staging'), {
        apiUrl: 'https://api.dev.example/api',
        cdnBase: 'https://cdn.dev.example/cli/dev'
    })
    assert.equal(hasDevChannel(), true)
    assert.equal(
        requireChannelCdn('staging'),
        'https://cdn.dev.example/cli/dev'
    )
})

test('requireChannelCdn refuses a dev channel this build does not carry', () => {
    clearDevChannel()
    assert.throws(
        () => requireChannelCdn('staging'),
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

test('resolveUpdateStatus treats any staging difference as an update', () => {
    // Two staging builds of the same base both parse as 0.11.1 under the
    // stable comparator, which would report "up to date" forever.
    assert.equal(
        resolveUpdateStatus(
            'staging',
            '0.11.1-staging.202606120900.aaaaaaa',
            '0.11.1-staging.202606121400.bbbbbbb'
        ),
        'update'
    )
    assert.equal(
        resolveUpdateStatus(
            'staging',
            '0.11.1-staging.202606121400.bbbbbbb',
            '0.11.1-staging.202606121400.bbbbbbb'
        ),
        'up-to-date'
    )
    // The staging channel never reports "ahead" — latest is authoritative.
    assert.equal(
        resolveUpdateStatus(
            'staging',
            '0.12.0-staging.202607010000.ccccccc',
            '0.11.1-staging.202606121400.bbbbbbb'
        ),
        'update'
    )
})

test('normalizeUpdateChannelFlag maps dev/staging aliases to staging', () => {
    assert.equal(normalizeUpdateChannelFlag('dev'), 'staging')
    assert.equal(normalizeUpdateChannelFlag('staging'), 'staging')
    assert.equal(normalizeUpdateChannelFlag('stable'), 'stable')
    assert.equal(normalizeUpdateChannelFlag('  DEV '), 'staging')
    assert.equal(normalizeUpdateChannelFlag('Stable'), 'stable')
})

test('normalizeUpdateChannelFlag rejects unknown channels', () => {
    assert.throws(
        () => normalizeUpdateChannelFlag('beta'),
        /unknown channel 'beta' \(expected dev or stable\)/
    )
})

test('channelFlagLabel renders the openclaw-facing channel name', () => {
    assert.equal(channelFlagLabel('staging'), 'dev')
    assert.equal(channelFlagLabel('stable'), 'stable')
})

test('resolveEffectiveUpdateChannel: explicit flag wins', () => {
    assert.equal(
        resolveEffectiveUpdateChannel({
            flagChannel: 'stable',
            savedPref: 'staging',
            baked: 'staging'
        }),
        'stable'
    )
})

test('resolveEffectiveUpdateChannel: a pinned --to version dictates its channel', () => {
    // A staging build only exists under cli/staging, so its version pin must
    // beat a saved stable preference — otherwise the download 404s.
    assert.equal(
        resolveEffectiveUpdateChannel({
            savedPref: 'stable',
            toVersion: '0.11.1-staging.202606121400.bbbbbbb',
            baked: 'stable'
        }),
        'staging'
    )
    assert.equal(
        resolveEffectiveUpdateChannel({
            savedPref: 'staging',
            toVersion: '0.12.0',
            baked: 'staging'
        }),
        'stable'
    )
})

test('resolveEffectiveUpdateChannel: saved preference beats the baked channel', () => {
    assert.equal(
        resolveEffectiveUpdateChannel({
            savedPref: 'staging',
            baked: 'stable'
        }),
        'staging'
    )
})

test('resolveEffectiveUpdateChannel: falls back to the baked channel', () => {
    assert.equal(resolveEffectiveUpdateChannel({ baked: 'stable' }), 'stable')
})
