---
version: "0.27.1"
date: "2026-08-29"
---

A maintenance release: the daemon reports one more capability, and nothing
else changes.

- **The daemon advertises `model.credential-facts`.** Model inspection
  responses have carried per-framework credential facts for a while; the
  daemon's hello and heartbeat now declare that capability explicitly, so the
  platform can tell which hosts report it without guessing from version
  numbers. Behavior is unchanged — no action needed.
