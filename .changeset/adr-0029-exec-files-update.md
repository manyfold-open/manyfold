---
'@manyfold/cli': minor
'@manyfold/api': patch
---

A daemon started without an init unit (`manual`: the sprite runner, `mf daemon start --foreground`) can now take a remote upgrade when it is a standalone macOS / Linux binary and not the pod runner (ADR-0029 §5). The old process drives it: the downloaded binary must pass `--version` before it replaces anything (now true for every self-update), the running binary is kept as `<mf>.prev`, the daemon hands its running execs to a successor it starts detached and watches the successor answer on the control socket with the new version; if that never happens it stops the successor, restores `.prev`, relaunches it and refuses that target version until another one is chosen. The daemon advertises `daemon.update.manual` when it can do this, so the dashboard's upgrade works for such daemons and the platform upgrades a capable sprite runner through `daemon.update` instead of installing over it. A restarted daemon also tells the platform once, in its first hello, what it made of the execs it inherited and whether an upgrade was rolled back; both are recorded as audit entries on the daemon.
