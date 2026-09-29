---
'@manyfold/api': minor
---

Everything the API does on a sandbox or a cloud computer now goes through that provider's adapter or through the machine's daemon. Skills are written through the daemon on every kind of machine, and the Hermes skill list on a cloud computer is read the same way. A sandbox or cloud computer still provisioning 30 minutes after it was created is marked failed so it can be deleted; before, only cloud computers were. A host whose machine is gone from its provider fails with "the machine is gone from its provider". With the Hermes dashboard on, a cloud computer routes its hostname through the dashboard proxy, the way a sandbox does. The sandbox stop audit records the machine under `machine`.
