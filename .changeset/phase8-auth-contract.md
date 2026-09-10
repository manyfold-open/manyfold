---
'@manyfold/api': patch
---

Finish the Phase 8 database contract after the switch release is running: remove the retired agent-binding column, CLI grant session columns, and user-grant index. Drain retired A2A ephemeral credentials while retaining External A2A grants and their target/caller indexes. Deployments must run the switch release on every API instance before applying this contract.
