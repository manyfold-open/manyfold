import assert from 'node:assert/strict'
import test from 'node:test'
import { sep } from 'node:path'
import { overlayCandidate, packageSourceCandidates } from '../vite-overlay'

// The mapping rule the whole editions web overlay rides on: base-tree files
// map to the same relative path inside the overlay dir, everything else stays
// untouched. A mapping that leaked outside src/ would let an overlay shadow
// arbitrary files; one that missed nested paths would silently ship the
// open-source page in a cloud build.
const base = ['', 'repo', 'apps', 'web', 'src'].join(sep)
const overlay = ['', 'repo', 'apps', 'web-cloud', 'src'].join(sep)

test('a base-tree module maps to the same relative overlay path', () => {
    assert.equal(
        overlayCandidate(
            [base, 'pages', 'Settings', 'Pricing.tsx'].join(sep),
            base,
            overlay
        ),
        [overlay, 'pages', 'Settings', 'Pricing.tsx'].join(sep)
    )
})

test('modules outside the base tree never map', () => {
    for (const outside of [
        ['', 'repo', 'apps', 'web', 'vite.config.ts'].join(sep),
        ['', 'repo', 'packages', 'shared', 'src', 'dtos.ts'].join(sep),
        ['', 'repo', 'apps', 'web-srcish', 'file.ts'].join(sep)
    ])
        assert.equal(overlayCandidate(outside, base, overlay), null)
})

test('the base root itself does not map', () => {
    assert.equal(overlayCandidate(base, base, overlay), null)
})

// The second resolution leg (found by the challenge migration): a module that
// exists ONLY in the overlay — a cloud page's private helper, style or asset
// with no open-source counterpart. Vite's '@/' alias still points it at the
// base tree, so the plugin probes the mapped overlay path with the same
// extension ladder the import would use.
test('an overlay-only module maps from its would-be base path', () => {
    assert.equal(
        overlayCandidate(
            [base, 'lib', 'challengeStage'].join(sep),
            base,
            overlay
        ),
        [overlay, 'lib', 'challengeStage'].join(sep)
    )
})

// The bare-id branch resolves @manyfold/<name> composition packages to
// source. Two candidate roots, probed in order: packages/ beside apps/
// (this repository), then one level higher for the superproject layout
// where the base app lives inside the oss/ submodule (editions Stage 2).
test('package source candidates cover both repository layouts in order', () => {
    const ossBase = ['', 'repo', 'oss', 'apps', 'web', 'src'].join(sep)
    assert.deepEqual(packageSourceCandidates(ossBase, 'shared-cloud'), [
        ['', 'repo', 'oss', 'packages', 'shared-cloud', 'src', 'index.ts'].join(
            sep
        ),
        ['', 'repo', 'packages', 'shared-cloud', 'src', 'index.ts'].join(sep)
    ])
})
