---
'@manyfold/cli': minor
---

New `mf updates apply` runs pending updates from the terminal: the ids you give, or every one `--kind` and `--where` select that can run from here, in the same order as the web's Update Center. It keeps to the API's five computer updates a minute, waits out a rate limit once, and reports each update as updated, pending (taken once the machine's sessions or current work finish) or failed, then `N updated · M pending · K failed`. It exits `1` when an update failed. `--to` picks the version for one update; `--json` needs `--yes` and never prompts.
