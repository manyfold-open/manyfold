---
'@manyfold/cli': minor
---

The daemon answers a turn's route challenge (`turn.route-attestation.v1`): for an OpenClaw turn it follows the provider the gateway's transcript names to that provider's entry in openclaw.json, and for a Hermes turn it reads the model section of the config.yaml the ACP child loads and the provider key in its environment. It proves that route with an HMAC keyed by the provider key, so the key never leaves the machine. A route it cannot resolve the way the runtime would — profiles, credential pools, secret-manager sources, a config edited during the turn, a resumed Hermes session it did not see created — gets no proof, with a reason instead.
