---
version: '0.22.1'
date: '2026-07-31'
---

## CLI 0.22.1 — A complete, drift-checked command reference

The public CLI documentation now covers every command the binary registers, and
a check keeps it that way.

### Highlights

- **Full command reference.** A searchable reference generated from the same
  Commander tree as the `mf` binary, covering all 141 command paths in English
  and Chinese.
- **New bilingual guides.** Agents, runtimes, automations, backups, skills,
  usage, and outbound A2A each have their own page.
- **Corrected help text.** Profile-state and destructive-confirmation help
  matched neither the flags nor the paths the CLI actually uses; install,
  profile, daemon, scripting, and built-in agent guidance are accurate for
  0.22 again.
- **Complete release history.** Every missing public CLI changelog entry
  through 0.22.0 is backfilled.
- **Guarded against drift.** Command syntax, required options, destructive
  confirmations, identifier prefixes, profile paths, bilingual coverage,
  reference drift, and release-history drift are now checked in CI, so the docs
  cannot silently fall behind the binary.
