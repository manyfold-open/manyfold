---
version: '0.10.0'
date: '2026-05-16'
---

## CLI 0.10.0 — Cloud Agents is now Manyfold

The product has been renamed from **Cloud Agents** to **Manyfold**, with new primary domains across the web app, API, admin, docs, and CDN. Existing CLIs, daemons, scripts, and bookmarks keep working during a grace period — old hostnames continue to respond, and the `nca` binary name is unchanged.

### Highlights

- Product name in CLI help text, prompts, and output is now **Manyfold** everywhere it used to say "Cloud Agents" or "Netmind Cloud Agents".
- New primary domains:
    - Web app: `manyfold.ai` (was `agents.netmind.xyz`)
    - API: `api.manyfold.ai` (was `nca-api.netmind.xyz`)
    - Admin: `admin.manyfold.ai` (was `nca-admin.netmind.xyz`)
    - Docs: `docs.manyfold.ai` (was `docs.netmind.xyz`)
    - CDN: `cdn1.manyfold.ai` (was `cdn1.netmind.xyz`)
- All old domains continue to serve during the grace period — web/docs apex 301-redirect to the new domain, API/admin/CDN respond on both hostnames — so existing CLI installs and integrations don't need to change immediately.

### Notes

- The CLI binary name remains `nca` for backwards compatibility. Existing shell aliases, scripts, daemon init units, and CI configs keep working unchanged.
- Sign-in: Clerk's primary domain switched to `manyfold.ai`, so you may be asked to sign in again the first time you visit the new web app.
- To pick up the new binary, run `nca update --force --yes`. Existing daemons continue to run against the old API hostname until restarted.
- The GitHub repository moved from `protagolabs/netmind-cloud-agents` to `protagolabs/manyfold`. Old URLs are forwarded automatically by GitHub.
