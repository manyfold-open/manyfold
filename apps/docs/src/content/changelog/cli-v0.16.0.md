---
version: '0.16.0'
date: '2026-07-01'
---

## CLI 0.16.0 — Machine-readable --json across every command

Every `mf` data and mutation command now supports `--json`, so you can script Manyfold end to end and parse both success and failure reliably.

### Highlights

- **`--json` everywhere.** All data and mutation commands accept `--json` for machine-readable output; deletes emit `{ "ok": true, "id": ... }`.
- **Parseable errors.** In `--json` mode, failures print `{ "error": { "message": ... } }` on stderr with a non-zero exit, so scripts can branch on both outcomes.
- **Secrets stay redacted.** Channel output remains secret-redacted in JSON mode, and `login --json` reports the result without ever printing your token.

### Notes

- Raw-stream and interactive commands (`files read`, `daemon logs`, `daemon start/register/stop`, `update`) keep their existing behavior.
