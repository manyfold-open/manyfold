---
'@manyfold/web': patch
---

Settings -> Plan & billing no longer appears in the self-hosted sidebar.

Billing is a cloud surface — the open-source API has no billing routes, and the
open-source Plan & billing page is an editions slot that redirects to
`/settings`. The rail listed it anyway, so a self-hosted user saw an eighth
entry that bounced straight back the moment they clicked it.

The entry moves into a `settings-nav-extra` slot, the same mechanism the admin
app already uses for its commercial nav: empty in the open-source build, filled
by the cloud overlay. The cloud sidebar is unchanged, billing included and in
the same position.
