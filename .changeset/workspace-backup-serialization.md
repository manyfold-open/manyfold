---
'@manyfold/api': patch
---

Reject overlapping backup and restore operations on the same workspace across API replicas. Keep operation ownership through archive transfer and cleanup, preserve active jobs when another API starts, and recover interrupted operations before allowing a retry. Remote archive and restore commands record cancellation state so a delayed command cannot overwrite a newer operation.
