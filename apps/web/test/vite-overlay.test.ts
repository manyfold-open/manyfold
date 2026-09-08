import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { Plugin } from 'vite'
import {
    overlayCandidate,
    overlayResolver,
    packageSourceCandidates
} from '../vite-overlay'

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

// The plugin's only collaborator is Vite's own resolver, which for the
// absolute ids below answers with the path it was handed.
type OverlayContext = {
    resolve: (
        source: string,
        importer: string | undefined,
        options: unknown
    ) => Promise<{ id: string } | null>
}

const hookOf =
    (plugin: Plugin) =>
    (source: string, importer: string): Promise<string | null> =>
        (
            plugin.resolveId as unknown as (
                this: OverlayContext,
                source: string,
                importer: string | undefined,
                options: Record<string, unknown>
            ) => Promise<string | null>
        ).call(
            { resolve: async (id: string) => ({ id }) },
            source,
            importer,
            {}
        )

// Seen on the cloud admin dev server [2026-09-08]: handing the overlay its
// base counterpart is not enough on its own. The dev server fetches that base
// back by its own URL, a request that names the HTML entry as its importer,
// so the mapping ran a second time and answered with the overlay — which
// imported itself and re-exported nothing ('does not provide an export named
// encodePathSegment', white screen). The base needs an id of its own.
test('the base a wrap-and-extend overlay imports stays addressable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-overlay-'))
    const baseSrc = join(root, 'admin', 'src')
    const overlaySrc = join(root, 'admin-cloud', 'src')
    mkdirSync(baseSrc, { recursive: true })
    mkdirSync(overlaySrc, { recursive: true })
    writeFileSync(join(baseSrc, 'routes.ts'), 'export const routes = {}\n')
    writeFileSync(
        join(overlaySrc, 'routes.ts'),
        'export * from "../../admin/src/routes"\n'
    )

    const resolveId = hookOf(overlayResolver(baseSrc, overlaySrc))
    const basePath = join(baseSrc, 'routes.ts')

    // Every other importer still reads the route table through the overlay.
    assert.equal(
        await resolveId(basePath, join(baseSrc, 'main.tsx')),
        join(overlaySrc, 'routes.ts')
    )
    // The overlay reads the base, under an id the mapping leaves alone...
    assert.equal(
        await resolveId(basePath, join(overlaySrc, 'routes.ts')),
        `${basePath}?mf-overlay-base`
    )
    // ...so fetching it back cannot land on the overlay again.
    assert.equal(
        await resolveId(
            `${basePath}?mf-overlay-base`,
            join(baseSrc, 'index.html')
        ),
        null
    )

    rmSync(root, { recursive: true, force: true })
})
