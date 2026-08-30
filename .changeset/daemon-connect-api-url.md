---
'@manyfold/web': patch
---

Connect-a-machine commands name the deployment they belong to.

The install line handed out by Connect a new computer, and the token pair in
Settings, were the hosted platform's commands verbatim. A fresh `mf` defaults
to the hosted API, so on any other deployment the copied command installed the
CLI and then registered the machine against manyfold.ai — a daemon that
connects, reports healthy, and belongs to a different platform than the page
that produced the command.

Every command now carries `--api-url` with the API base the page itself is
talking to, unless that base already is the CLI's default, which keeps the
hosted commands byte-identical to what they were. The flag also outranks a
profile's stored URL, so a machine that has signed in elsewhere still lands on
the right deployment.

The URL is resolved from the bundle's own API base: baked for a split-origin
build, the page's origin plus `/api` for a same-origin one — the same URL the
browser just used, and the only one it can vouch for.
