---
'@manyfold/api': minor
---

OpenClaw and Hermes turns are no longer priced from the provider the Agent happens to be bound to. Their runtime picks the provider from its own config, so the API now sends each turn a fresh challenge and prices the turn by the provider row the daemon proves served it, including that row's managed brand and any price an operator set on it. A turn whose daemon cannot prove its route — an older CLI, a runtime config Manyfold did not write, a provider switched mid-turn — is recorded with no provider and priced from the public tables, and the API logs why. What the API expected is stored with the turn, so a turn recovered after an API restart is checked against the binding it was dispatched with.
