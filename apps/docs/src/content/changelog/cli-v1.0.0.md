---
version: "1.0.0"
date: "2026-09-11"
---

The CLI retires legacy turn-timeout and update-channel aliases. Update channels
are now `stable` and `dev`; scripts using `--channel staging` must switch to
`--channel dev`. Daemon turns use separate execution and first-response budgets.

Existing daemon registrations, profiles and workspaces remain valid. API 5.0.0
requires every daemon to run CLI 0.34.0 or newer. Self-hosted API upgrades must
first run API 4.0.0 and complete the configuration and data migration preflight
described in the self-hosting guide.
