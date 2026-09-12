---
'@manyfold/cli': major
'@manyfold/web': patch
---

Use `mf a2a send` to invoke a peer or URL and `mf a2a status` to list callable peers and in-flight tasks. The deprecated `call`, `stream`, and `peers` aliases have been removed. Replace `stream <url> <prompt>` with `send <url> <prompt> --stream`; replace scripts reading the `peers --json` array with `status --json` and read its `peers` field. Update saved scripts and Agent instructions before upgrading the CLI.

The Web A2A exposure dialog now points to the supported status command in every language.
