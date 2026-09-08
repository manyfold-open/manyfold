---
version: "0.31.2"
date: "2026-09-08"
---

An upgrade on a sprite no longer risks losing an agent's stored identity.

- **Legacy identities are migrated before anything cleans up.** Older sprites
  kept per-agent identity in the shared shell profile. Upgrading the CLI or a
  framework rewrites that profile, so anything still living there was lost.
  Both upgrade paths now move a legacy identity into encrypted storage first
  and only then clean the profile, which makes the upgrade safe to run on a
  sprite that has never been migrated.

No command, flag or output changed in this release.
