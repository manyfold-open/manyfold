---
'@manyfold/api': patch
---

Retire two legacy paths whose removal gates were verified against production and staging (zero live rows in both): the `a2a-ephemeral` token kind is fully mint-retired — the mint parameter and auth-principal unions drop it, bearer verification fails loud on the (impossible-by-TTL) residue row, the hourly ephemeral-token reaper now also drains expired `a2a-ephemeral` rows left by deploys predating the stateless-ticket switch, and the column enum keeps the value only so pre-switch rows stay readable — and the pre-rename `nca_dashboard` cookie fallback in k8s dashboard auth is gone (the cookie's Max-Age is one hour, so none planted before the rename can exist).
