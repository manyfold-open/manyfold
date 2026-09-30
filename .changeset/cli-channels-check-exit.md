---
'@manyfold/cli': minor
---

`mf channels test` and `mf channels register` now exit `1` when the check fails (`ok: false`), as `mf doctor` and `mf model-providers test` already did. The JSON report still goes to stdout. A script running with `set -e` now stops at a failed channel check instead of carrying on.
