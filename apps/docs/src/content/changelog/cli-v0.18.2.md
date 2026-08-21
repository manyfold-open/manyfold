---
version: '0.18.2'
date: '2026-07-19'
---

## CLI 0.18.2 — Skill installation reports real readiness

Installing or re-enabling a skill no longer reports success before the skill
has materialized in the agent workspace.

### Highlights

- **Explicit state.** Installed skills report `installing`, `installed`, or
  `failed` independently from enabled/disabled state.
- **Actionable failures.** `mf skills installed` and `mf skills install` show a
  sanitized materialization reason.
- **Background completion.** Slow installs can continue after the initial
  request returns.
- **Independent batch results.** One failed agent does not abort other skill
  installs.
