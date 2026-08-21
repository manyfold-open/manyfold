---
version: '0.12.0'
date: '2026-06-15'
---

## CLI 0.12.0 — The CLI is now `mf`

The command-line tool is renamed from `nca` to `mf`, with an agent-facing help guide built in, more resilient logins, and safer channel output. Existing installs keep working — the legacy `nca` binary still self-updates onto the renamed CLI, and your config is read from the old location as a fallback.

### Highlights

- **Renamed to `mf`.** The binary, commands, and docs now use `mf` (was `nca`). Config moves to `~/.manyfold` (with read-only fallback to `~/.config/nca`), and the local daemon migrates to `~/.manyfold/daemon` on first run. Your API tokens and existing agents are unaffected.
- **`mf help --agent`.** A built-in agent operations guide that works offline and without login. `mf help <topic> --agent` covers 13 focused topics — auth, safety, channels, automations, files, model-config, skills, runtime, agent, backups, usage — with exact scopes and copy-pasteable commands; `--json` returns a stable envelope.
- **Resilient poll-mode login.** `mf login --poll` now persists the pending request, so an approval is no longer lost if the polling process exits before you approve (the common case in chat). The next `mf` command redeems the approved session automatically, and `mf login --resume` checks or completes it. Consent links now stay valid for 15 minutes.
- **Channel secrets masked everywhere.** `mf channels get/create/update/list` redact secrets at every nesting level, including Lark webhook `verificationToken` / `encryptKey`. Note: `mf channels list --json` now returns `[redacted]` for secret fields — read secrets from your own records, not CLI output.

### Notes

- A new **staging release channel** lets you install pre-release builds: `install.sh` gains an `MF_CHANNEL` switch (staging builds point at the staging API and self-update independently of stable). Production install/update behavior is unchanged.
- Update with `mf update --force --yes` (or `nca update` from an older install); existing daemons keep working.
