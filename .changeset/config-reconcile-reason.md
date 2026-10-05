---
'@manyfold/api': patch
---

`daemon_config_reconcile` now says which host it ran for (`hostId`), how many agents failed (`failed`) and why the first one failed (`reason`, the delivery's own wording or the error's class). Before, a run that kept failing recorded only `outcome: failed`. All three names already exist in the log store.
