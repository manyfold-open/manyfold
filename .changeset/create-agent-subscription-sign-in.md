---
'@manyfold/web': minor
---

The create-agent form gains a third model-provider choice for Claude Code, Codex and Gemini CLI: **Use your own subscription** — the agent runs on the sign-in the coding CLI holds inside its sandbox/computer (a Claude Pro/Max plan, a ChatGPT plan, a Google account), and Manyfold stores no API key for it. Picking it sends `modelConfigSource: 'runtime-local'` with no credential block. On self-hosted builds this mode is the default for those frameworks via a new editions slot (`lib/agentCreate/providerDefaultMode`); the cloud overlay keeps the saved-provider default (protagolabs/manyfold#1112 pairs with this and must merge there before the pin bump that carries it).

After creating, the chat page shows a sign-in card while the runtime has no usable credentials: per-CLI instructions (run `claude` then `/login`; `codex login --device-auth`, since the standard flow needs a localhost callback the runtime cannot offer; gemini's `NO_BROWSER` flow), an **Open terminal** button, and a **Refresh status** action that re-runs the existing runtime-local credential probe. The card probes once on mount, so a target that is already signed in — an existing sandbox or a self-owned computer — resolves to ready without a click. Docs cover the option in model providers, the self-owned computer FAQ, and choose-a-runtime, in both languages.
