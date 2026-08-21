---
version: '0.11.1'
date: '2026-06-02'
---

## CLI 0.11.1 — Local Claude Code and Codex chat repaired

Claude Code and Codex turns running through a self-owned computer no longer
exit immediately when the prompt is delivered through daemon exec.

### Highlights

- **Prompt delivery works again.** Daemon exec now accepts and forwards stdin
  correctly.
- **Backward-compatible recovery.** The API-side fix restores existing daemon
  agents immediately; upgrading the CLI adopts the complete protocol fix.
- **No workspace migration.** Existing local agents and their files are
  unchanged.
