---
version: '0.8.0'
date: '2026-05-14'
---

## CLI 0.8.0 — Daemon autostart on login and boot

`nca daemon start` now installs an OS init unit so the daemon auto-starts at login and is automatically restarted by the operating system if it crashes. The web app's **Settings → Local daemons** also shows each connected machine's CLI version and how its daemon was launched.

### Highlights

- `nca daemon start` installs a per-user init unit by default — macOS launchd LaunchAgent (`~/Library/LaunchAgents`) or Linux systemd user unit (`~/.config/systemd/user`). The daemon now auto-starts on login and is restarted on crash by the OS.
- `nca daemon start --system` installs a boot-time unit (requires sudo): `/Library/LaunchDaemons` on macOS or `/etc/systemd/system` on Linux. Use this on always-on machines that should run the daemon before any user logs in.
- `nca daemon start --foreground` runs the daemon inline without touching any init unit, useful for debugging and CI. `nca daemon stop` cleanly removes the init unit it installed, and `nca daemon status` / `nca daemon doctor` now report both user- and system-scope unit state.
- Each row in **Settings → Local daemons → Connected machines** now shows the daemon's CLI version and how it was started, e.g. `cli 0.8.0 · autostart · login (launchd)` or `cli 0.8.0 · manual`.

### Notes

- Existing daemons keep running unchanged; the new init unit is only installed the next time you run `nca daemon start`. Run `nca daemon stop && nca daemon start` to opt in.
- Use `nca update --force --yes` to reinstall the latest standalone binary, then `nca daemon doctor` to confirm the init unit was installed correctly.
