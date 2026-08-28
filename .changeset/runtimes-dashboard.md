---
'@manyfold/web': patch
---

The runtimes page opens on a dashboard instead of silently picking a host.

Landing on Settings -> Runtimes used to auto-select the first VM in the list
and render its detail panel — which also fired a framework-detection round
trip into that sandbox as a side effect of merely opening the page. There was
no place to see all runtimes at once: connected machines, sandbox usage and
external providers each lived on their own sub-page.

The bare URL now shows a dashboard summarizing every runtime kind in one
place, with a grid/list toggle (persisted per device). Sandboxes show their
sprite status, storage, active time this period and agents; self-owned
computers show online state, platform, mf CLI version and detected
frameworks; external runtimes show their endpoint and the last connection
test of the matching provider, and providers not yet bound to any runtime are
listed alongside. Each section carries a direct create entry for its kind, so
adding a runtime no longer requires the chooser dialog (which stays on the
rail button). Cards click through to the existing host detail; the kind
breadcrumb links back to the dashboard. The dashboard also has an explicit
address — /settings/runtimes/dashboard, reachable from a new rail entry — so
on narrow screens, where the bare URL still opens the rail, it remains one
tap away.

Framework detection now runs only when a sandbox is explicitly selected, so
opening the page no longer pokes the alphabetically-first sandbox. If sandbox
usage or the provider list fails to load, the affected columns degrade to
placeholders instead of failing the page.

The rail itself gets simpler: grouping gains a None option (a plain host
tree, no group headers) and None becomes the default — the cascade store
moves to a fresh key (`mf.runtimes.cascade.v2`) because the old one had
auto-persisted "Kind" for every returning browser, so a fallback change
alone would never land. The search box and the All/Ready/Issues filter
chips are gone — the dashboard is now the place to survey and triage.
