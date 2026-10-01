---
'@manyfold/cli': minor
---

`mf a2a send` follows a task the peer hands back `working` at its blocking limit, with `tasks get`, and prints the answer when it finishes, within the same `--timeout`. A stream that ends before its task prints the followed answer rather than the partial text. When the deadline passes first, it exits 1 with the task id and the `mf a2a tasks get … --wait` command that keeps following it. A task that ends `failed`, `canceled` or `rejected` now prints its reason and exits 1 for `send`, `tasks get --wait` and `tasks subscribe`; before, it exited 0 without saying why. `tasks get --wait` also stops at a task that needs input instead of waiting out the deadline.
