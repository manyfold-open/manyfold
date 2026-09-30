---
'@manyfold/api': minor
'@manyfold/web': minor
---

Discovering skills no longer answers as if a repo had none because it has not been read yet. The first discover after a skill repo is added (a fresh install's built-in repos, or one added with `mf skills repos create`) used to start reading it in the background and answer without it, so the catalog showed a single skill until a later look. `GET /skills/discover` now reads such repos before answering, and waits for another server reading one, for up to 15 seconds; a repo that takes longer, or fails, is named in the page's new `pendingRepos`, which the web app's skills catalog shows as "still reading". Repos read before still refresh in the background, and only a first page waits.
