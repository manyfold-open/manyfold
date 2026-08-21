---
version: '0.19.0'
date: '2026-07-23'
---

## CLI 0.19.0 — Switch between dev and stable release channels

`mf update` can change the installed binary's release channel and remember the
choice for future checks and updates.

### Highlights

- **Explicit channels.** Use `mf update --channel dev` for pre-release builds
  or `--channel stable` for production builds.
- **Remembered selection.** The machine stores its choice in
  `~/.manyfold/update-channel.json`.
- **Safe preview.** `mf update --check` reports the selected channel without
  changing the saved preference.
- **Consistent naming.** Installer and daemon status use `dev` and `stable`;
  `staging` remains an accepted legacy alias.
