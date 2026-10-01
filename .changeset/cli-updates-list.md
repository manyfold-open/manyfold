---
'@manyfold/cli': minor
---

New `mf updates` lists what the web's Update Center lists: the mf CLI and herdr on your computers, sandboxes and cloud computers, each runtime's framework, the CLIs a sandbox ships, and your agents' skills. Each row shows where it is, the version it is on and the one it would go to, and whether it can run from here or needs a person (with the command to run) or a machine that is offline. `--kind` and `--where` narrow it; `--json` carries stable ids and lists any source that did not load. `mf updates versions` shows the versions there are to install: `cli` for the mf CLI, or a framework name, which also lists the ranges the platform refuses and why.
