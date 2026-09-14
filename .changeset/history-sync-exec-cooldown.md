---
'@manyfold/api': patch
'@manyfold/shared': patch
---

Skip automatic runtime history sync while a Sprite's exec endpoint is marked unavailable. Opening Chat no longer starts history-file commands against that endpoint; sync resumes after the turn's recovery probe clears the marker.
