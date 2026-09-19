---
"@manyfold/api": major
"@manyfold/web": patch
"@manyfold/admin": patch
---

Require an mf daemon runner for all runtime-backed chat, including model inspection, history, cancellation and permission answers. Remove direct Sprite/Pod exec and API-owned ACP/gateway chat transports, runner rollout switches, and the Claude partial-stream toggle. Enable safe cursor recovery and managed Claude delta streaming unconditionally.

Existing environments without a compatible runner must update their daemon or Pod image before chatting. K8s service images must start a runner with persistent state; NarraNexus Pods additionally require MF_POD_RUNNER_IMAGE to name the runner image. External Dify, Langflow and A2A integrations retain their HTTP transport.
