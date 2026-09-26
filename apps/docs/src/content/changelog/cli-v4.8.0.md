---
version: '4.8.0'
date: '2026-09-26'
---

The Manyfold operator guide now supports both platform-managed agents and
external Claude Code or Codex sessions. The shared `manyfold-cli-usage` skill
includes identity-aware authentication, workbench links, and result verification.
External coding agents can install it through the Manyfold plugin.

OpenClaw turns wait for a booting gateway before starting. Ask mode uses
OpenClaw's guarded permission mode, preserving command approvals and the
selected model; an unsupported gateway configuration fails explicitly.

A daemon can start even when a discovered coding CLI or herdr binary cannot
be executed, such as after an interrupted installation. Such binaries are
reported without a version, and herdr update failures are reported directly.

A2A send deadlines now include discovery and streaming. Remote cancellation,
input and authentication prompts, and HTTP error details are preserved.
