---
'@manyfold/cli': minor
---

A mistake on the command line now exits `5` with `invalid_usage` wherever the command notices it, as the exit-code table already promised. That covers a missing or conflicting flag, `nothing to update`, a `--config` / `--credentials` / `--body` that is not a JSON object, a missing agent id, and the checks in `mf channels`, `skills`, `files`, `auth`, `a2a`, `backups`, `profile` and `sandbox` that exited `1` before. An `@file` that cannot be read now names its flag (`--config: cannot read ./x.json (ENOENT)`) instead of printing Node's raw error.
