---
'@manyfold/api': minor
---

The `/api/agent-setup.md` runbook starts with one read-only check of the agent's machine. That check finds an `mf` in `~/.local/bin` that is not on PATH, and ignores other programs named `mf`. It also flags `MF_TOKEN` and tells whether the user's browser is on this computer.
- A profile already signed in to the deployment is now reused on every deployment, so running the setup again, or on a machine with an existing staging login, needs no new approval. No command uses a saved token before its profile is matched to this API.
- SSH sessions and Linux machines without a display go straight to the one-time-code sign-in. If a stable `mf` has no `--print-auth-url`, the runbook checks for a newer release, and otherwise reports that remote sign-in is not available yet.
- The browser sign-in now waits for the login process to exit. The `"ok":true` it used to wait for never appears in the CLI's formatted output.
- Codex runs the sign-in in the foreground, because it stops background processes.
- The plugin step names the Codex desktop app's own CLI, and ends by listing what it installed.
