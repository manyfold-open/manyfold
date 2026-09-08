---
'@manyfold/api': minor
---

Route openclaw chat over ACP by default. `MF_OPENCLAW_ACP` now defaults on, so sprite (no-runner) and k8s openclaw turns run the `openclaw acp` bridge — enabling per-message model switching and interactive permission approval — instead of the stateless gateway-http path. Set `MF_OPENCLAW_ACP=0` to fall back to gateway-http without a redeploy. NarraNexus is unaffected (it keeps the gateway-http path via the framework guard). The gateway-http chat branch is retained as that rollback for now and will be removed in a follow-up, once the NarraNexus/GatewayHttp adapter split lands.
