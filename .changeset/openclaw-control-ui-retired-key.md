---
'@manyfold/api': minor
---

OpenClaw agents start again on OpenClaw 2026.9.8 and later. The gateway config Manyfold writes no longer sets `gateway.controlUi.allowInsecureAuth`, a key OpenClaw retired in 2026.8 and that 2026.9.8 refuses at startup ("Unrecognized key", exit 78), which made every new OpenClaw agent on the latest release fail while starting its service and would have broken an existing one upgraded to it. A restart rewrites an existing agent's config without the key. The Control UI is unaffected: it is let in by `dangerouslyDisableDeviceAuth`, which stays.
