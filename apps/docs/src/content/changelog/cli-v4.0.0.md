---
version: '4.0.0'
date: '2026-09-17'
---

Sandbox storage reporting now uses explicit scopes and byte units. `mf sandbox
storage-usage` reports the current sandbox by default and accepts `--account`
for an authorized account-wide report. Agent JSON replaces the ambiguous
`storageBytes` fields with nullable workspace measurements and returns an
explicit `{ scope, agents }` envelope. Upgrade the API and CLI together.
