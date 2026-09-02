import { existsSync } from 'node:fs'
import path from 'node:path'

export const ogDir = import.meta.dirname
export const repoRoot = path.resolve(ogDir, '../../../..')

// Resolves a file inside an installed package without assuming where the
// package manager hoisted it: node_modules sits at this repository's root in
// a plain checkout, and one level higher when the repo is mounted as the
// oss/ submodule of the cloud superproject (editions Stage 2).
export const installedFile = (rel: string): string =>
    [repoRoot, path.resolve(repoRoot, '..')]
        .map((root) => path.join(root, 'node_modules', rel))
        .find((candidate) => existsSync(candidate)) ??
    path.join(repoRoot, 'node_modules', rel)

export const POSTER_CSS = path.join(ogDir, 'poster.css')
export const POSTER_TEMPLATE = path.join(ogDir, 'poster.template.html')
export const LOCK_REL = 'apps/web/scripts/og/poster.lock.json'
export const LOCK_FILE = path.join(repoRoot, LOCK_REL)

// These files are the executable part of the raster input. Template, CSS,
// fonts and runtime values are checked separately, but changing the code that
// composes them or launches Chromium can still change pixels while leaving all
// of those values intact. The lock fingerprints this exact allowlist.
export const GENERATOR_RELS = [
    'apps/web/scripts/og/canonical.ts',
    'apps/web/scripts/og/contract.ts',
    'apps/web/scripts/og/fonts.ts',
    'apps/web/scripts/og/paths.ts',
    'apps/web/scripts/og/poster.ts',
    'apps/web/scripts/og/render.ts',
    'apps/web/scripts/og/runtime.ts'
] as const

export const generatorSource = (rel: (typeof GENERATOR_RELS)[number]): string =>
    path.join(repoRoot, rel)

// The browser executable and OS come from the pinned image; these are the two
// JavaScript tools that execute the generator and speak the screenshot
// protocol inside it. Font package versions are deliberately absent because
// the exact face bytes, rather than their package labels, are pinned in
// fonts.ts.
export const GENERATOR_PACKAGE_RELS = {
    playwright: 'playwright/package.json',
    tsx: 'tsx/package.json'
} as const

export const generatorPackage = (
    name: keyof typeof GENERATOR_PACKAGE_RELS
): string => installedFile(GENERATOR_PACKAGE_RELS[name])

export const WEB_HEAD = path.join(repoRoot, 'apps/web/src/seo/head.ts')
// The card is a still of the hero, and the hero lives in the scrolly stage
// rather than in the page shell that mounts it.
export const LANDING_PAGE = path.join(
    repoRoot,
    'apps/web/src/components/landing/ScrollyStage.tsx'
)
export const DOCS_LAYOUT = path.join(
    repoRoot,
    'apps/docs/src/layouts/BaseLayout.astro'
)

// Both apps serve the card from their own public/ tree, so every asset exists
// twice and the two copies have to stay byte-identical.
export const SOCIAL_RELS = {
    web: 'apps/web/public/social',
    docs: 'apps/docs/public/social'
} as const

export type AppName = keyof typeof SOCIAL_RELS

// The one list of apps that ship the card. The contract checker walks this
// rather than the list inside poster.lock.json, so a lock that quietly forgot
// an app cannot make that app's copies stop being checked.
export const APPS = Object.keys(SOCIAL_RELS) as AppName[]

export const socialAssetRel = (app: AppName, file: string): string =>
    `${SOCIAL_RELS[app]}/${file}`

export const socialAsset = (app: AppName, file: string): string =>
    path.join(repoRoot, socialAssetRel(app, file))

export const socialDir = (app: AppName): string =>
    path.join(repoRoot, SOCIAL_RELS[app])
