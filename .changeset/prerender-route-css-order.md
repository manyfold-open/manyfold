---
'@manyfold/web': patch
---

A prerendered marketing page now links a lazy route's own stylesheets after the app's, where the browser puts them when the route loads from another page, so the page looks the same opened by URL as reached by a link. Linked first, the route's rules lost every tie with the shared landing styles: a composition page whose header makes room for the floating nav lost that room when opened directly, and sat under the nav.
