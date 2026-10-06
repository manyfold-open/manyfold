---
'@manyfold/web': minor
---

Marketing pages are prerendered at build time from the app's own React tree and hydrated in the browser, replacing the hand-written crawler snapshots. The hero paints from the HTML before the app starts, so Largest Contentful Paint no longer waits for the app bundle. The landing's decorative world draws once the page has hydrated. The analytics consent banner now appears after the page hydrates, and the nav's theme icon is chosen by the stylesheet, so neither depends on the visitor's stored choices in the first render.
