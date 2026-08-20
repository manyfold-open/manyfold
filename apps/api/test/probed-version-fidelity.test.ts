import {
    frameworkUpgradeAvailable,
    isCliUpdateAvailable,
    isCliVersionTooOld
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSpriteFrameworkProbe } from '../src/modules/sandboxes/sandboxes.service'

// #777. A sandbox running the EXACT latest staging mf CLI was told to update,
// forever. The probe stored `0.22.5` for a `0.22.5-staging.<stamp>.<sha>` build,
// and the staging channel compares by string equality — deliberately, because
// build stamps are not semver-comparable — so current never equalled latest.
//
// The parser choice was made inside a private method behind a live sprite exec,
// which is why nothing could pin it. parseSpriteFrameworkProbe exists so it can
// be.

const STAGING_CLI = '0.22.5-staging.202608101552.11b3983'

const probeOutput = (lines: Record<string, string>): string =>
    Object.entries(lines)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')

test('the sandbox probe keeps the full staging mf CLI build string', () => {
    const { cliVersion } = parseSpriteFrameworkProbe(
        probeOutput({ mf: STAGING_CLI })
    )

    assert.equal(cliVersion, STAGING_CLI)
})

// The symptom, end to end: what the probe stores is what the update check reads.
test('a sandbox on the exact latest staging CLI is not told to update', () => {
    const { cliVersion } = parseSpriteFrameworkProbe(
        probeOutput({ mf: STAGING_CLI })
    )

    assert.equal(
        isCliUpdateAvailable('staging', cliVersion, STAGING_CLI),
        false
    )
    // ...and a genuinely newer staging build still is
    assert.equal(
        isCliUpdateAvailable(
            'staging',
            cliVersion,
            '0.22.5-staging.202608121200.abcdef0'
        ),
        true
    )
})

// The floor must not move. Under semver precedence every staging build sits
// BELOW its own release, so if the CLI comparison family were ever unified with
// the framework one this would flip and strand the whole staging fleet. The
// stored value is now the full string, which makes that a live risk rather than
// a theoretical one — hence pinning it here as well as at the primitive.
test('a staging build is not below a floor at or under its core version', () => {
    const { cliVersion } = parseSpriteFrameworkProbe(
        probeOutput({ mf: STAGING_CLI })
    )

    assert.equal(isCliVersionTooOld(cliVersion, '0.22.5'), false)
    assert.equal(isCliVersionTooOld(cliVersion, '0.22.4'), false)
    assert.equal(isCliVersionTooOld(cliVersion, '0.22.6'), true)
})

test('stable-channel behaviour is unchanged', () => {
    const { cliVersion } = parseSpriteFrameworkProbe(
        probeOutput({ mf: '0.22.5' })
    )

    assert.equal(cliVersion, '0.22.5')
    assert.equal(isCliUpdateAvailable('stable', cliVersion, '0.22.5'), false)
    assert.equal(isCliUpdateAvailable('stable', cliVersion, '0.22.6'), true)
})

// The same probe writes agent_runtimes.framework_version. After the pre-release
// opt-in a sprite can legitimately be running an rc, and truncating it here
// would record a version that exists in no repository.
test('the probe keeps a pre-release framework version intact', () => {
    const { frameworks } = parseSpriteFrameworkProbe(
        probeOutput({
            'claude-code': '2.1.220-rc.1 (Claude Code)',
            codex: '1.0.0',
            mf: STAGING_CLI
        })
    )
    const byName = new Map(frameworks.map((f) => [f.framework, f.version]))

    assert.equal(byName.get('claude-code'), '2.1.220-rc.1')
    assert.equal(byName.get('codex'), '1.0.0')
    // an rc is a strict downgrade from its release, so the release is offered
    assert.equal(frameworkUpgradeAvailable('2.1.220-rc.1', '2.1.220'), true)
    assert.equal(frameworkUpgradeAvailable('2.1.220', '2.1.220-rc.1'), false)
})

// Unchanged contract: an absent or unparseable line is omitted rather than
// stored as a bogus value, so a transient probe miss cannot wipe a known one.
test('missing and unparseable probe lines yield nothing', () => {
    const { frameworks, cliVersion } = parseSpriteFrameworkProbe(
        probeOutput({ 'claude-code': '', codex: 'command not found', mf: '' })
    )

    assert.deepEqual(frameworks, [])
    assert.equal(cliVersion, null)
})
