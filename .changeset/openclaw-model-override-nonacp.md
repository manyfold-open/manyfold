---
'@manyfold/api': patch
---

Fix openclaw per-message model switching on the non-ACP transports. The web model switcher sends a per-message model override for openclaw agents, but the API applied it only on the ACP path (via `sessions.patch`). On the runner turn-rpc and gateway-http transports — which is where every sprite openclaw agent runs when `MF_SPRITE_RUNNER_AGENTS` routes it to a runner — the override was dropped and the turn ran on the agent's stored default. The override now rides the gateway-http request body as `primary/<pick>` on both transports, so switching the model takes effect regardless of whether `MF_OPENCLAW_ACP` is on. Seen on staging: an openclaw sprite switched to gpt-5.6-terra still answered on its default because the sprite-runner rollout (`*`) sends it through turn-rpc.
