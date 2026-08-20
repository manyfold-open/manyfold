import assert from 'node:assert/strict'
import test from 'node:test'
import {
    blockedVersionMessage,
    findBlockedVersionRange,
    safeNpmVersionSpec,
    selectFrameworkInstallVersion,
    type FrameworkBlockedVersionRange
} from '../src/framework-versions'
import { blockedVersionRangesFor } from '../src/frameworkDefaultVersions'

// #594: gemini-cli 0.53.0 dropped the thought signature from completed
// tool-call history, so every later turn of a tool-using session 400s. The bad
// window is CLOSED — 0.52.0 below it and a patched release above it are both
// fine — which is why a raised minimum version cannot express it.
const GEMINI: FrameworkBlockedVersionRange[] = [
    { min: '0.53.0', max: '0.54.0', reason: 'unsigned tool-call history' }
]

test('the whole broken window is blocked, both bounds included', () => {
    for (const version of ['0.53.0', '0.53.1', '0.53.9', '0.54.0'])
        assert.ok(
            findBlockedVersionRange(version, GEMINI),
            `${version} is inside the window`
        )
})

// The point of a closed interval: the release the incident tells people to fall
// back to, and the one that will carry the upstream fix, must both stay
// installable. A minimum-version floor would have barred 0.52.0 too.
test('releases either side of the window stay installable', () => {
    for (const version of ['0.52.0', '0.52.9', '0.54.1', '0.55.0', '1.0.0'])
        assert.equal(findBlockedVersionRange(version, GEMINI), null)
})

// A version we cannot compare can't be proven unsafe either. Blocking it would
// take out git-tag frameworks (hermes reports a sha) for no evidence.
test('an unparseable or absent version is not blocked', () => {
    assert.equal(findBlockedVersionRange('main', GEMINI), null)
    assert.equal(findBlockedVersionRange(null, GEMINI), null)
    assert.equal(findBlockedVersionRange('0.53.1', undefined), null)
    assert.equal(findBlockedVersionRange('0.53.1', []), null)
})

// Whoever hits the refusal has to be able to act on it: which window, and what
// breaks. "version not available" would send them looking for a catalog bug.
test('the rejection message names the window and the reason', () => {
    const message = blockedVersionMessage('gemini-cli', '0.53.1', GEMINI[0])
    assert.match(message, /gemini-cli 0\.53\.1/)
    assert.match(message, /0\.53\.0–0\.54\.0/)
    assert.match(message, /unsigned tool-call history/)
})

// The incident itself: npm's `latest` WAS 0.54.0, so every unpinned create
// installed the broken CLI. Skipping to the next tier is what stops that
// without stranding the create.
test('a blocked catalog latest is skipped instead of installed', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            catalogLatest: '0.54.0',
            blocked: GEMINI
        }),
        { version: null, source: 'none' }
    )
    assert.deepEqual(
        selectFrameworkInstallVersion({
            adminDefault: '0.53.1',
            catalogLatest: '0.54.0',
            blocked: GEMINI
        }),
        { version: null, source: 'none' }
    )
})

// The regression guard for the day the window is lifted: a patched release must
// resolve exactly as it did before the denylist existed.
test('a patched release above the window still resolves normally', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            catalogLatest: '0.55.0',
            blocked: GEMINI
        }),
        { version: '0.55.0', source: 'latest' }
    )
    assert.deepEqual(
        selectFrameworkInstallVersion({
            adminDefault: '0.52.0',
            catalogLatest: '0.55.0',
            blocked: GEMINI
        }),
        { version: '0.52.0', source: 'admin' }
    )
})

// A caller naming a blocked version must be TOLD. Silently substituting a
// different version would break per-agent reproduction, and silently accepting
// it would reproduce the incident.
test('an explicitly requested blocked version comes back flagged, not swapped', () => {
    const selection = selectFrameworkInstallVersion({
        requested: '0.53.1',
        catalogLatest: '0.55.0',
        blocked: GEMINI
    })
    assert.equal(selection.version, '0.53.1')
    assert.equal(selection.source, 'explicit')
    assert.equal(
        selection.source === 'explicit' ? selection.blockedBy : null,
        GEMINI[0]
    )
})

test('an unblocked request carries no flag', () => {
    assert.deepEqual(
        selectFrameworkInstallVersion({
            requested: '0.52.0',
            blocked: GEMINI
        }),
        { version: '0.52.0', source: 'explicit' }
    )
})

// The blind-latest install has no catalog to filter, so the exclusion has to
// travel inside the npm spec itself.
test('the npm spec excludes the window and still asks for the newest release', () => {
    assert.equal(safeNpmVersionSpec(GEMINI), '<0.53.0 || >0.54.0')
    assert.equal(safeNpmVersionSpec(undefined), 'latest')
    assert.equal(safeNpmVersionSpec([]), 'latest')
})

// Two windows must not collapse into a range that re-admits the gap between
// them, and their order in the settings map must not matter.
test('multiple windows compile to one complement range, in any input order', () => {
    const ranges: FrameworkBlockedVersionRange[] = [
        { min: '1.2.0', max: '1.2.5', reason: 'b' },
        { min: '0.53.0', max: '0.54.0', reason: 'a' }
    ]
    assert.equal(
        safeNpmVersionSpec(ranges),
        '<0.53.0 || >0.54.0 <1.2.0 || >1.2.5'
    )
})

test('overlapping windows merge instead of producing an empty range', () => {
    assert.equal(
        safeNpmVersionSpec([
            { min: '0.53.0', max: '0.54.0', reason: 'a' },
            { min: '0.53.5', max: '0.56.0', reason: 'b' }
        ]),
        '<0.53.0 || >0.56.0'
    )
})

// A window whose bounds don't parse cannot be turned into a semver clause; it
// must drop out rather than corrupt the spec for the ranges that do parse.
test('an unparseable window is dropped from the npm spec', () => {
    assert.equal(
        safeNpmVersionSpec([{ min: 'main', max: 'HEAD', reason: 'x' }]),
        'latest'
    )
})

// Built-in protection cannot depend on an operator having configured anything:
// deployments that never touch the settings row must still refuse the release.
test('the built-in list blocks the incident release with no settings at all', () => {
    assert.ok(
        findBlockedVersionRange('0.53.1', blockedVersionRangesFor('gemini-cli'))
    )
    assert.ok(
        findBlockedVersionRange(
            '0.54.0',
            blockedVersionRangesFor('gemini-cli', null)
        )
    )
    assert.equal(
        findBlockedVersionRange(
            '0.52.0',
            blockedVersionRangesFor('gemini-cli', {
                blockedVersions: {}
            })
        ),
        null
    )
})

// An operator containing a new incident must not have to wait for a deploy —
// and must not be able to drop the built-in window by saving an empty map.
test('operator windows union with the built-in list', () => {
    const ranges = blockedVersionRangesFor('codex', {
        blockedVersions: {
            codex: [{ min: '1.0.0', max: '1.0.9', reason: 'operator' }]
        }
    })
    assert.ok(findBlockedVersionRange('1.0.4', ranges))
    assert.equal(findBlockedVersionRange('1.1.0', ranges), null)
    assert.ok(
        findBlockedVersionRange(
            '0.53.1',
            blockedVersionRangesFor('gemini-cli', {
                blockedVersions: {
                    codex: [{ min: '1.0.0', max: '1.0.9', reason: 'operator' }]
                }
            })
        )
    )
})
