---
'@manyfold/cli': minor
---

`mf update` now reports failures the way every other command does, and takes `--json`. A network failure exits `2` instead of `1`, and names the host it could not reach. A bad `--channel`, or a `--to` that is not a version, exits `5` before anything is fetched. A `--to` release that does not exist says so and points at `mf updates versions cli`, instead of printing a 404 URL. `--json` gives `--check` and the install result as JSON, sends progress to stderr, and needs `--yes`. `--channel` is now remembered only after the release resolved and you did not cancel; before, it was saved even when the update then failed.
