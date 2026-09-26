---
'@manyfold/cli': minor
---

The ask permission mode works again for OpenClaw turns on openclaw 2026.8.1 and later. Those releases reject the session's `execAsk` field, and the daemon used to drop that failure silently, so ask-mode turns ran with no command approvals and also lost the model picked for the message. For each ask-mode turn, the daemon now puts the OpenClaw session into openclaw's `guarded` permission mode: commands outside the allowlist need your approval, and file tools stay inside the session root. It clears that mode before the turn ends, so the next turn without ask mode runs as before. If the gateway rejects the session update (openclaw before 2026.8.1 does not know `permissionMode`), the turn now fails with the gateway's message instead of running without approvals or with a different model.
