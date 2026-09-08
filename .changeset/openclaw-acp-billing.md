---
'@manyfold/api': patch
---

Bill openclaw ACP turns. The `openclaw acp` stream carries no token usage, so a turn that completes now reads its usage back from the gateway transcript with one in-box `sessions.get` on the session key and sums every model call after the turn's own user message — the same figure the gateway-http path bills, tool loops included. A read-back that fails or cannot be attributed is logged and counted (`openclaw_acp_usage`), never fatal. The bridge is also exec'd behind a wrapper that terminates it on stdin EOF: `openclaw acp` ignores EOF, which cost every turn the ACP client's full close grace and, on k8s, left the bridge running in the pod. Still behind `MF_OPENCLAW_ACP`.
