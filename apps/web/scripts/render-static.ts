import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    renderStaticPages,
    type EditionSeoPages
} from '../src/seo/renderStatic'
import type { SeoPageDefinition } from '../src/seo/pages'
import type { SeoSnapshotBodies } from '../src/seo/snapshots'

const appDir = resolve(import.meta.dirname, '..')

/* The composition's indexable pages, if this is a composition build. The
   vite overlay resolver (vite-overlay.ts) is a vite plugin, and this step
   runs under tsx after the bundle is written, so the overlay's modules are
   loaded by path here instead. MF_WEB_OVERLAY_DIR is the same knob, read the
   same way: relative to this app's directory.

   Two rules for an overlay module reached from here, both because tsx is
   not vite: import core modules through `@/` but never overlay-local ones
   (`@/` resolves into apps/web/src, where they are not), and keep the module
   free of JSX — a .tsx outside this app is transformed with the classic
   runtime whatever it declares, and throws on its first element. */
const loadEditionSeo = async (): Promise<EditionSeoPages> => {
    const empty: EditionSeoPages = { pages: [], snapshots: {} }
    const overlay = process.env.MF_WEB_OVERLAY_DIR
    if (!overlay) return empty
    const overlayDir = resolve(appDir, overlay)
    const pagesFile = resolve(overlayDir, 'seo/editionPages.ts')
    if (!existsSync(pagesFile)) return empty
    const { EDITION_SEO_PAGES } = (await import(
        pathToFileURL(pagesFile).href
    )) as { EDITION_SEO_PAGES: SeoPageDefinition[] }
    if (EDITION_SEO_PAGES.length === 0) return empty
    /* Snapshots are required, not optional: snapshotFor throws on a page
       without one rather than letting it ship somebody else's body. They are
       data, not components — see seo/snapshots.tsx for why JSX cannot cross
       this boundary. */
    const snapshotsFile = resolve(overlayDir, 'seo/editionSnapshots.ts')
    const { EDITION_SNAPSHOTS } = (await import(
        pathToFileURL(snapshotsFile).href
    )) as { EDITION_SNAPSHOTS: SeoSnapshotBodies }
    return { pages: EDITION_SEO_PAGES, snapshots: EDITION_SNAPSHOTS }
}

await renderStaticPages(resolve(appDir, 'dist'), await loadEditionSeo())
