---
'@manyfold/cli': patch
---

The daemon's hello and heartbeat now advertise `model.credential-facts`, a retroactive capability flag for the credentialFacts field its model.inspect responses already carry. No behavior change — the flag makes fleet coverage queryable from `runtime_hosts.client_features`.
