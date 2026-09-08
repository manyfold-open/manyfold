import type { SeoPageDefinition } from '@/seo/pages'

// Editions slot (§3.3): indexable marketing pages a composition adds to the
// manifest. Empty here, because an open-source install has no commercial
// marketing page to index — the cloud overlay shadows this file with its
// own definitions.
//
// Two consumers, two paths to the same file. The browser build gets it
// through the vite overlay resolver (SEO_PAGES spreads it, so the language
// pin, the tab title, the canonical URL and the nav's current-page state all
// know the page exists). The post-build renderer runs under tsx, where the
// overlay plugin does not apply, so scripts/render-static.ts imports the
// overlay's copy of this file by path and hands the definitions in.
//
// Which means an edition's page module has to be importable by plain node.
// Two rules follow, both from tsx not being vite: core modules are fine
// through `@/` (tsx applies apps/web's tsconfig paths process-wide) but an
// overlay-local import must be relative, because `@/` resolves into
// apps/web/src where it is not; and the module must be free of JSX, since a
// .tsx outside this app is transformed with the classic runtime whatever it
// declares. Crawler bodies therefore cross as data — see seo/snapshots.tsx.
export const EDITION_SEO_PAGES: SeoPageDefinition[] = []
