---
'@manyfold/api': minor
---

A sandbox runtime's framework version is stored as the version itself ("2.1.251"), not the line the CLI printed ("2.1.251 (Claude Code)", "codex-cli 0.151.0"), so it compares with the catalog and an update is offered when one is out. A version the platform just installed or upgraded in place no longer reverts to the old one while the sandbox's daemon still reports its cached inventory.
