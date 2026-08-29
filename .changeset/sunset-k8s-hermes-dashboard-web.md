---
'@manyfold/web': minor
---

Login no longer mints dashboard cookies or follows absolute redirect URLs — the `rd` parameter and the `*.manyfold.ai` absolute-URL allowance existed only for the removed k8s hermes dashboard bounce, and `redirect_url` now accepts internal paths only. The hermes dashboard toggle is shown only for sprite runtimes.
