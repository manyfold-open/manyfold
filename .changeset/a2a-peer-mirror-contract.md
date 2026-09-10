---
'@manyfold/api': minor
---

Retire the remaining internal peer credential mirrors and their shared hash
records after every API instance uses the canonical policy writer. Remove the
temporary revocation bridge. External A2A credentials, personal API tokens and
runtime identities are preserved; peer policy and public grant IDs remain.

The migration refuses unmigrated or recently used caller-bound credentials.
Rollback after this contract must use the canonical writer, not the older
mirror-writing preparation release.
