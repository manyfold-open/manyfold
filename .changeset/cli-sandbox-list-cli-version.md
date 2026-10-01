---
'@manyfold/cli': minor
---

`mf sandbox list` shows each sandbox's Manyfold CLI version, as `old → new` when an update is out, and when any sandbox is behind it points at `mf sandbox update` for one and `mf updates apply --kind cli` for all of them. Before, the table had no version at all, though `mf sandbox update` told you to check it there.
