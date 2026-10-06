import type { SeoPageDefinition } from '@/seo/pages'

// Editions slot (§3.3): indexable marketing pages a composition adds to the
// manifest. Empty here, because an open-source install has no commercial
// marketing page to index — the cloud overlay shadows this file with its
// own definitions.
//
// The client build and the prerender (`vite build --ssr src/entry-server.tsx`)
// both get it through the vite overlay resolver, so an edition's page is
// prerendered from its own route like any core page. SEO_PAGES spreads it,
// so the language pin, the tab title, the canonical URL, the sitemap and the
// nav's current-page state all know the page exists.
export const EDITION_SEO_PAGES: SeoPageDefinition[] = []
