---
'@manyfold/web': patch
---

Serve `/updates` and `/account` as SPA routes. Caddy serves the app shell only
for an explicit list of route families and 404s everything else, so both were
registered in the router but unreachable once deployed: the Update Center
returned the 404 page, as did the account-deletion confirm and restore pages
that people reach from an emailed link.
