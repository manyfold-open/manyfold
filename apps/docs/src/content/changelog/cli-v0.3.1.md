---
version: '0.3.1'
date: '2026-05-07'
---

## CLI 0.3.1 — Model configuration compatibility

This patch release keeps local daemon runtimes compatible with per-agent model configuration.

### Highlights

- Added daemon protocol support required by per-agent model configuration.
- Added model-aware chat session support across API, SDK, web, and local daemon integrations.
- Repaired managed credential handling used by managed model providers.

### Notes

- Users should update local CLI binaries when using agent-specific model settings with local daemon runtimes.
