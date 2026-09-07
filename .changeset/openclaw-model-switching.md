---
'@manyfold/api': minor
'@manyfold/web': minor
---

Add per-message model switching for openclaw agents in the chat composer, matching hermes. The model list comes from the agent's provider-models cache (openclaw joins the model-config provider-detail allowlist), and the pick is applied to the openclaw ACP turn via an in-box `openclaw gateway call sessions.patch {model}` in the exec wrapper — probe-verified to change a live session's model from the next prompt, stick to the gateway session key, and route through to the provider even for models not pre-registered in the gateway config (so no catalog registration is needed). Behind `MF_OPENCLAW_ACP`; narranexus is unaffected.
