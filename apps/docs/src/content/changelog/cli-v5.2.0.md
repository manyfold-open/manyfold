---
version: '5.2.0'
date: '2026-09-27'
---

The daemon account inspector now reads Antigravity CLI subscription quotas
from Cloud Code and returns sanitized model-level usage windows, including
reset times, alongside the existing Codex and Claude Code subscription
usage. Credentials remain on the host and are never included in the report.
