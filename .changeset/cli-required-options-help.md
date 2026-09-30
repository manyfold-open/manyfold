---
'@manyfold/cli': minor
---

`--help` marks the options a command cannot run without as `(required)`, on every command at every depth, so the flags you must pass are visible without a failed run. `mf channels create --config` is now optional and defaults to `{}`, which is enough for `fake` and for the providers whose settings all have defaults. Lark, Matrix and iMessage still say which settings they need.
