---
'@manyfold/api': minor
---

Per-framework API behaviour — agent and chat adapters, sprite and k8s bootstraps, version descriptors, framework-served files, the control UI link, channel hooks and keep-alive supervision — now resolves through one extension registry that a framework's own module registers into, instead of being wired into the core by name. A chat turn for a framework with no adapter now fails with `framework_unavailable` rather than being answered by the development echo adapter, and turning on agent-managed replies for an agent whose framework cannot deliver them now says that its framework does not support them.
