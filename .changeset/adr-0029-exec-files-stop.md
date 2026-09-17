---
'@manyfold/cli': minor
'@manyfold/api': patch
---

`mf daemon stop` now also ends the execs the daemon owns (by their recorded identity), and `--keep-execs` leaves them for the next daemon to adopt — which is what the platform's runner bring-up passes once a daemon advertises `exec.files.v1`. The systemd user unit `mf daemon start` writes carries `KillMode=process`, so a detached exec outlives the daemon's restart; whether that holds for the actual installation is decided at start (launchd: yes; systemd: only with `KillMode=process`; manual: no), logged as `exec survival`, reported by `mf daemon doctor`, and used by the update drain, which only waits for sessions that would die with the daemon and keeps admitting adoptable execs while an update is pending. `mf daemon status` shows how many running execs would survive a restart.
