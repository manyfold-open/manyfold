---
version: "0.31.0"
date: "2026-09-08"
---

No command, flag or output changed in this release.

Internally, when the platform enables it, the daemon can now run an OpenClaw
chat turn over the Agent Client Protocol against the OpenClaw gateway already
running on your machine — the daemon discovers that gateway from your own
OpenClaw config, never starts one, and never sends its token off the box.
Approval prompts and per-message model choices flow through the same gateway,
and a turn interrupted by a reconnect is recovered rather than lost. The
previous local path is unchanged and still used when the feature is off.
