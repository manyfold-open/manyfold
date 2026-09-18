---
'@manyfold/api': patch
---

Profile-bound sprites agents now probe and run through their sandbox runner. The runtime-local model refresh brings the runner up (same admission and awake hold as an account wake) instead of failing with `auth_context_unsupported`, and turn dispatch always attempts the runner for a turn that requires an auth profile — the rollout list only governs turns that could also run on the bare sprite exec. Codex profile turns also select the builtin OpenAI provider explicitly, so a sandbox whose shared config.toml still pins the platform gateway from a platform-source bootstrap no longer posts subscription credentials at that gateway (401 INVALID_API_KEY).
