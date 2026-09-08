---
'@manyfold/web': patch
---

Fix the editions overlay resolver serving a wrap-and-extend overlay to itself instead of its base module. The plugin already declined to map a base file back onto the overlay importing it, but it recognised that case by the importer alone — and the dev server then fetches the base by its own URL (`/src/routes.ts`), a request whose importer is the HTML entry. The mapping ran a second time, answered the base URL with the overlay, and the overlay's own `import { encodePathSegment } from '<base>/routes'` pointed at itself: `SyntaxError: The requested module '/src/routes.ts' does not provide an export named 'encodePathSegment'`, and a blank admin console. Base resolutions now carry an `?mf-overlay-base` id the mapping leaves alone, so the overlay and its base stay two distinct modules. Seen on a cloud dev server whose `MF_ADMIN_OVERLAY_DIR` overlays the core admin route table; production builds resolve by path and were never affected.
