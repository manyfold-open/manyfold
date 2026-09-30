---
'@manyfold/cli': minor
---

`mf automations run --wait` follows the run's reply as it streams, the way `mf agent send` shows a reply, then says how the run ended (`run aur_… succeeded`, or `failed:` and why) and whether it reached the automation's channel; a failed run exits 1, and Ctrl-C stops following without stopping the run. `mf automations result <id>` prints the full reply of the automation's latest run, or of `--run <runId>`, or why it failed, following a run still going to its end, where `get` only had the first line of each reply. Both take `--show-thinking` and `--json` (`{ run, text, usage, error }`). `run` without `--wait` says where to find the result.
