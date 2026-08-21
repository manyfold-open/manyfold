---
version: '0.7.0'
date: '2026-05-14'
---

## CLI 0.7.0 — One-step daemon onboarding

`nca daemon register` now offers to start the daemon immediately after registration, so connecting a new local machine takes one extra keystroke instead of a second manual command.

### Highlights

- After `nca daemon register --token <TOKEN>` succeeds in an interactive shell, the CLI prompts `Start the daemon now? [Y/n]`. Pressing `Enter` or `y` starts the daemon detached; pressing `n` keeps the existing register-only behaviour.
- Added `-y` / `--yes` flag for non-interactive setups (CI, unattended provisioning): `nca daemon register --token <TOKEN> -y` registers and starts the daemon in one shot, no prompt.
- Behaviour in non-TTY shells without `-y` is unchanged: the command only registers and prints the existing `Next: run nca daemon start` hint.

### Notes

- The web app's **Settings → Local daemons** now renders the full `nca daemon register --token <TOKEN>` command in a copy-ready block so it can be pasted straight into a terminal — see the new [Register a local machine](/docs/local-daemons/) doc for the end-to-end flow.
- Use `nca update --force --yes` to reinstall the latest standalone binary.
