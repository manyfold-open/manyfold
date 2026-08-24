---
'@manyfold/api': patch
'@manyfold/cli': patch
'@manyfold/web': patch
---

Rename the mf CLI's pre-release update channel from `staging` to `dev`
throughout. The channel a user selects with `mf update --channel dev` and the
name the product reports are now the same word.

- The runtime list labels the channel "Dev" instead of "Staging".
- `staging` stays accepted as an alias everywhere it can arrive from an older
  peer: the `--channel` flag, a saved `~/.manyfold/update-channel.json`
  preference, the `daemon.update` RPC payload, and version strings — builds
  published before this rename are versioned `x.y.z-staging.<stamp>.<sha>` and
  are still installed in the field, so they keep reading as dev builds.
- `GET /daemon/cli-versions` gains a `dev` list; the `staging` list is retained
  as a deprecated mirror so an older web bundle keeps working against a newer
  API during a rolling deploy.

No distribution or update-source behaviour changes here.
