---
'@manyfold/web': minor
---

A composition can now put direct links on the marketing nav bar, ahead of the Product menu, through a new optional `barLinks` field on the `editionNavMenus` slot; the folded phone menu lists them first, each with its own icon, and a bar that carries them folds at 960px instead of 880px so the wider centre group never runs into the utilities. The landing page gains an `EditionBand` slot between the observability section and the plans, empty here, and `/ai-solutions` is routed as a new editions slot page that redirects home. An open-source build looks and behaves exactly as before.
