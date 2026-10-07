---
version: '5.11.0'
date: '2026-10-07'
---

The daemon now proves which model provider served an OpenClaw or Hermes
turn, so those turns are priced on the route that actually answered them.

For each turn the platform sends a one-time challenge. The daemon follows the
route the runtime used: for OpenClaw, the provider the gateway's transcript
names and its entry in openclaw.json; for Hermes, the model section of the
config.yaml the ACP child loads and the provider key in its environment. It
answers with an HMAC keyed by that provider's key, so the key never leaves
your machine. A route it cannot resolve the way the runtime would gets no
proof and a reason instead: profiles, credential pools, secret-manager
sources, a config edited during the turn, or a resumed Hermes session the
daemon did not see created.
