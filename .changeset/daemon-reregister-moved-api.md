---
'@manyfold/api': patch
---

A hosted sandbox or pod whose daemon was registered against an earlier public API address (a replaced tunnel, a changed domain) is registered again on its next bring-up instead of being started against the old address and never connecting. The bring-up's single inspect exec now also reads the saved address; before, every bring-up ended in `daemon did not come online` while the sandbox was held awake.
