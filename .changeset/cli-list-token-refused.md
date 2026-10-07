---
'@manyfold/api': minor
---

The mf CLI version list ("Change version…" on a sandbox, and the versions the update flows offer) lists every stable release again. When GitHub refuses the platform's token for the public releases repository, through an organization token policy or an invalid token, the API now reads the list without the token instead of falling back to the latest version alone.
