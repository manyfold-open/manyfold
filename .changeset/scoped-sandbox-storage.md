---
'@manyfold/api': major
'@manyfold/cli': major
'@manyfold/web': patch
---

Replace ambiguous agent `storageBytes`/`storageMeasuredAt` fields with nullable `workspaceBytes`/`workspaceMeasuredAt`. Add scoped cached sandbox storage reports, measurement freshness and conservative path attribution; runtime account reads require explicit account intent and `agents:read` consent.

`mf sandbox storage-usage` reports the current sandbox, while `--account` reports all account sandboxes. `mf agent list --json` now returns `{ scope, agents }`; agent path diagnostics keep sleeping measurements unknown and expose cached sandbox usage separately. Upgrade the API and CLI together: storage commands and agent list/get reject older ambiguous responses.
